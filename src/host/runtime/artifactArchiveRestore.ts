/**
 * 归档**还原**（cycle-87 · O-86-03）：把一轮从 `.cycles/archive/` 搬回活跃区。
 *
 * ## 为什么这必须是产品能力，而不是一次性脚本
 *
 * cycle-86 的事故里，cycle-86 被测试探针误归档 —— 当时的"修复"是我现场写了一段
 * `renameSync` + 手改 manifest 的脚本。那条路径有三个问题：
 *   ① 不可复用：下次再发生只能再写一遍，而每次手写都可能漏一步（漏改 manifest
 *      就会让"归档清单说有、活跃区也有"两条记录同时存在，读数从此不可信）；
 *   ② 没有审计：谁在什么时候还原了什么，磁盘上没有痕迹；
 *   ③ 没有幂等：重复执行会因为目标已存在而抛 EEXIST（半迁移状态）。
 *
 * 本模块把这三件事固化成契约：
 *   - **可重入**：目标已在活跃区 ⇒ `alreadyActive` no-op（不报错、不重复搬）；
 *   - **可审计**：每次动作追加 `archive/restore-log.json`（谁/何时/为什么/前后账本读数）；
 *   - **两段式**：`dryRun` 与真写共用同一判据（与 `archiveBaseline` 同纪律）；
 *   - **账本只读**（INV-9）：写前/写后各读一次作为证据，一个字都不改。
 *
 * ## 为什么还原必须同步删 manifest 条目
 *
 * manifest 是"归档区有什么"的真相源。还原后若条目还在，`inventory` 会同时报告
 * 「活跃有 cycle-N」与「归档有 cycle-N」——两处都"有"的读数比"都没有"更危险：
 * 读者会以为存在两份副本。所以真写路径在移动成功后**立即**重写 manifest
 * （原子写）；dryRun 只在结果里报告将要删哪条。
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import {
  readLedgerFacts,
  readManifest,
  type ArchiveManifest,
} from './artifactArchiveFacts.ts';

/** 还原日志文件（与 manifest 同目录；追加式，不覆盖历史）。 */
export const RESTORE_LOG_FILE = 'restore-log.json';

/** `cycle-N` 的严格形状（拒绝 `../` 与任意目录名——路径只能来自这个正则的产物）。 */
const CYCLE_NAME_RE = /^cycle-(\d+)$/;

export interface RestoreOptions {
  /** 只算不写（预览段）。 */
  dryRun?: boolean;
  /** 审计里的执行者标识。 */
  actor?: string;
  /** 还原原因（写进审计；缺省给一句可执行的理由模板）。 */
  reason?: string;
}

export interface RestoreResult {
  ok: boolean;
  dryRun: boolean;
  /** 被（将要）还原的轮次名；非法/缺失时为 null。 */
  restored: string | null;
  /** 目标已在活跃区（no-op，幂等路径）。 */
  alreadyActive: boolean;
  /** 归档区找不到该轮。 */
  missing: boolean;
  /** 真写后回读的 manifest（dryRun 时 = 磁盘现状）。 */
  manifest: ArchiveManifest | null;
  /** 账本审计读数（`unchanged` 恒应为 true —— INV-9）。 */
  ledger: { entries: number; chainHead: string | null; unchanged: boolean } | null;
  warnings: string[];
}

/** 还原日志单条。 */
export interface RestoreLogEntry {
  at: string;
  actor: string;
  name: string;
  reason: string;
  ledgerBefore: { entries: number; chainHead: string | null } | null;
  ledgerAfter: { entries: number; chainHead: string | null } | null;
}

/** 读还原日志（畸形 ⇒ 空数组；与 manifest 同口径：读坏了当没有，不伪造）。 */
export function readRestoreLog(cyclesDir: string): RestoreLogEntry[] {
  const p = join(cyclesDir, 'archive', RESTORE_LOG_FILE);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as RestoreLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** 追加一条还原日志（原子写；失败只告警——审计缺口不能吞掉已完成的还原事实）。 */
function appendRestoreLog(cyclesDir: string, entry: RestoreLogEntry, warnings: string[]): void {
  try {
    const dir = join(cyclesDir, 'archive');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const next = [...readRestoreLog(cyclesDir), entry];
    atomicWriteFileSync(join(dir, RESTORE_LOG_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    warnings.push(`restore log not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 从 manifest 移除一条（保持数值序；空清单保留 archivedAt 原值）。 */
export function manifestWithout(manifest: ArchiveManifest | null, name: string): ArchiveManifest | null {
  if (manifest === null) return null;
  const cycles = manifest.cycles.filter((c) => c.name !== name);
  return { ...manifest, cycles };
}

/**
 * 还原一轮。
 *
 * 判据顺序（每一步都能单独断言，且**先判后动**）：
 *   1. 名字形状非法 ⇒ `ok:false` + warning（绝不把请求当路径）；
 *   2. 已在活跃区 ⇒ `alreadyActive` no-op（幂等，不报错）；
 *   3. 归档区没有 ⇒ `missing`（`ok:false`）：调用方要能区分"没搬过"与"搬丢了"；
 *   4. dryRun ⇒ 只报告，不写盘；
 *   5. 真写：`renameSync` → 重写 manifest → 追加 restore-log → 账本前后读数比对。
 */
export function restoreArchivedCycle(
  cyclesDir: string,
  name: string,
  opts: RestoreOptions = {},
): RestoreResult {
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? 'artifactArchive.restoreArchivedCycle';
  const reason = opts.reason ?? 'manual restore (archive -> active)';
  const warnings: string[] = [];
  const ledgerBefore = readLedgerFacts(cyclesDir);
  /** 账本只读事实：`unchanged` 由**实际比对**得出，不是写死 true（INV-9 要能证伪）。 */
  const ledgerDelta = (after: { entries: number; chainHead: string | null } | null) => {
    if (ledgerBefore === null && after === null) return null;
    const same = ledgerBefore !== null && after !== null
      && ledgerBefore.entries === after.entries
      && ledgerBefore.chainHead === after.chainHead;
    return { ...(after ?? ledgerBefore ?? { entries: 0, chainHead: null }), unchanged: same };
  };
  const ledgerRead = ledgerDelta(ledgerBefore);

  const base: RestoreResult = {
    ok: false, dryRun, restored: null, alreadyActive: false, missing: false,
    manifest: readManifest(cyclesDir), ledger: ledgerRead, warnings,
  };

  if (!CYCLE_NAME_RE.test(name)) {
    warnings.push(`invalid cycle name: ${JSON.stringify(name)} (expected cycle-<number>)`);
    return base;
  }

  const activeDir = join(cyclesDir, 'cycles', name);
  const archivedDir = join(cyclesDir, 'archive', name);

  if (existsSync(activeDir)) {
    warnings.push(`${name} is already active — no-op (idempotent restore)`);
    return { ...base, ok: true, alreadyActive: true };
  }
  if (!existsSync(archivedDir)) {
    warnings.push(`${name} not found in archive — nothing to restore`);
    return { ...base, missing: true };
  }
  if (dryRun) {
    return { ...base, ok: true, restored: name };
  }

  try {
    mkdirSync(join(cyclesDir, 'cycles'), { recursive: true });
    renameSync(archivedDir, activeDir);
  } catch (e) {
    warnings.push(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
    return base;
  }

  // manifest 重写（移动成功后立刻做；失败只告警但保留 warning —— 读数不一致要被看见）
  try {
    const next = manifestWithout(readManifest(cyclesDir), name);
    if (next !== null) {
      atomicWriteFileSync(join(cyclesDir, 'archive', 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`);
    }
  } catch (e) {
    warnings.push(`manifest not updated: ${e instanceof Error ? e.message : String(e)}`);
  }

  const ledgerAfter = readLedgerFacts(cyclesDir);
  appendRestoreLog(cyclesDir, {
    at: new Date().toISOString(), actor, name, reason,
    ledgerBefore, ledgerAfter,
  }, warnings);

  const ledger = ledgerDelta(ledgerAfter);
  // 账本变动=严重违约（只还原目录不该影响链）——必须喊出来，不能默认绿。
  if (ledger !== null && !ledger.unchanged) warnings.push('LEDGER CHANGED during restore (INV-9 violation)');
  return { ...base, ok: true, restored: name, manifest: readManifest(cyclesDir), ledger };
}
