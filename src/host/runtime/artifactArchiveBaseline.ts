/**
 * 归档**执行**（cycle-83）：把可完成的活跃轮次批量移入 `.cycles/archive/`。
 *
 * ## 承重裁决（照抄 `flows/archiveEngine.ts` 文件头，两条都不可谈判）
 *
 * ① 完成判定与 G1 共用同一任务行解析器（`flows/gateArtifacts.parseTaskRows`）——
 *    「G1 说完成、归档说没完成」分叉的根因就是两处各写一份判定。
 * ② **归档只移动目录，永不触碰账本**（INV-9 只追加哈希链）。按 detail 删条目会让
 *    后续所有 `previousHash` 指向已删条目，下一次 `verifyLedger` 必报 CHAIN_BREAK。
 *    本文件对账本**只有读**：写前/写后各读一次，作为审计证据而不是修改动作。
 *
 * ## 为什么是「批量」而不是逐轮循环调 archive-cycle.mjs
 *
 * 79 轮要 79 次子进程调用，中途失败就是半迁移状态。用户要的是「重新开始执行」
 * ——一次把所有可完成的轮搬走。所以本模块提供批量入口，并强制三条性质：
 *   - **可重入**：重复调用是 no-op（返回 `alreadyArchived`，不产生第二条 manifest 条目）；
 *   - **逐个点名**：不可完成的轮留在活跃区，并给出具体原因字符串（不是静默跳过）；
 *   - **可审计**：全流程写 `archive/baseline-reset.json`（谁/何时/移了哪些/为什么）。
 *
 * ## 写入纪律
 *
 * 落盘一律走 `shared/fs-safe.ts` 的 `atomicWriteFileSync`（写临时再 rename，
 * 防并发读看到半写 JSON）；目录移动用 `renameSync`（同卷原子）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { moveDirectory } from './dirMove.ts';
import {
  isCycleCompleteForArchive,
  listActiveCycles,
  listArchivedCycles,
  readLedgerFacts,
  readManifest,
  type ArchiveBlockReason,
  type ArchiveManifest,
  type BaselineOptions,
  type BaselineResult,
  type ManifestCycle,
} from './artifactArchiveFacts.ts';

export const BASELINE_AUDIT_FILE = 'baseline-reset.json';
export const MANIFEST_FILE = 'manifest.json';

/** 审计记录（`archive/baseline-reset.json`；人能读懂"这次搬了什么、为什么"）。 */
export interface BaselineAudit {
  actor: string;
  at: string;
  dryRun: boolean;
  includeIncomplete: boolean;
  archived: string[];
  kept: Array<{ name: string; reason: ArchiveBlockReason; detail: string }>;
  /** 账本读数（写前/写后）——**只作证据**，本模块从不修改账本。 */
  ledgerBefore: { entries: number; chainHead: string | null } | null;
  ledgerAfter: { entries: number; chainHead: string | null } | null;
  note: string;
}

/** 人读原因（"为什么这轮没被归档"必须是一句能执行的话）。 */
function reasonDetail(verdict: { reason?: ArchiveBlockReason; total: number; pending: number }): string {
  switch (verdict.reason) {
    case 'missing-cycle-dir': return 'cycle directory not found';
    case 'missing-task-list': return '任务清单.md missing (cycle never finished init)';
    case 'empty-task-list': return '任务清单.md has 0 task rows (cannot prove completion; does not block baseline reset)';
    case 'has-pending': return `${String(verdict.pending)}/${String(verdict.total)} task rows pending`;
    case 'not-selected': return 'not in the requested `names` set (left active on purpose)';
    default: return 'not archivable';
  }
}

/** 归档目标目录（按需创建；已存在则复用）。 */
function ensureArchiveDir(cyclesDir: string): string {
  const dir = join(cyclesDir, 'archive');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 合并 manifest：新条目追加、已有条目保留（**同 name 不重复写**——可重入的落点）。 */
function mergeManifest(existing: ArchiveManifest | null, added: ManifestCycle[], at: string): ArchiveManifest {
  const byName = new Map<string, ManifestCycle>();
  for (const c of existing?.cycles ?? []) byName.set(c.name, c);
  for (const c of added) if (!byName.has(c.name)) byName.set(c.name, c);
  const cycles = [...byName.values()].sort((a, b) => a.num - b.num);
  return {
    // archivedAt 取首次归档时间：重复调用不改写它（否则"这条什么时候归的"会被抹掉）。
    archivedAt: existing?.archivedAt !== undefined && existing.archivedAt !== '' ? existing.archivedAt : at,
    cycles,
    totalBytes: cycles.reduce((n, c) => n + (c.files > 0 ? 1 : 0), 0) === 0
      ? (existing?.totalBytes ?? 0)
      : cycles.reduce((n, c) => n + c.files, 0),
  };
}

/**
 * 批量归档**可完成**的活跃轮次（基线重置）。
 *
 * `dryRun` 与真写**共用同一条判据**（面板的预览-执行两段式：预览说什么，执行就做什么）。
 * dryRun 不写盘：不建 archive 目录、不动目录、不写 manifest/审计。
 */
export function archiveBaseline(cyclesDir: string, opts: BaselineOptions = {}): BaselineResult {
  const dryRun = opts.dryRun === true;
  const includeIncomplete = opts.includeIncomplete === true;
  const actor = opts.actor ?? 'artifactArchive.archiveBaseline';
  const now = new Date().toISOString();
  const warnings: string[] = [];

  const active = listActiveCycles(cyclesDir);
  const archivedNow = listArchivedCycles(cyclesDir);

  if (active.length === 0 && archivedNow.length === 0) {
    return {
      ok: true, dryRun, archived: [], kept: [], alreadyArchived: true, manifest: readManifest(cyclesDir),
      ledger: null,
      warnings: ['no cycle directories at all (neither .cycles/cycles nor .cycles/archive) — nothing to do'],
    };
  }

  // 逐轮判定（与 G1 同解析器）+ 逐个点名。
  //
  // cycle-87：若调用方给了 `names`，先收窄候选集——**未选中的轮必须以 not-selected
  // 点名保留**，不能静默消失（否则调用方会误以为它们已被归档）。
  const selected = opts.names === undefined ? null : new Set(opts.names);
  const toArchive: string[] = [];
  const kept: BaselineResult['kept'] = [];
  for (const c of active) {
    if (selected !== null && !selected.has(c.name)) {
      kept.push({ name: c.name, reason: 'not-selected', detail: reasonDetail({ total: 0, pending: 0 }) });
      continue;
    }
    const verdict = isCycleCompleteForArchive(cyclesDir, c.name);
    if (verdict.complete) { toArchive.push(c.name); continue; }
    if (includeIncomplete) { toArchive.push(c.name); continue; }
    kept.push({ name: c.name, reason: verdict.reason ?? 'has-pending', detail: reasonDetail(verdict) });
  }
  // 请求了不存在的轮次 → 如实告警（不是静默忽略）。
  if (selected !== null) {
    const present = new Set(active.map((c) => c.name));
    for (const want of selected) {
      if (!present.has(want)) warnings.push(`${want}: not an active cycle (ignored)`);
    }
  }

  // 可重入：目标轮次全在归档区 ⇒ no-op。判据用"**名**集合"而不是数量
  // （数量相等但名字不同的情形必须被区分开，否则会静默重复归档）。
  // 可重入判据：**没有任何可归档候选**才算 no-op。
  //
  // 为什么不用"数量相同"判：数量相等但名字不同的情形必须被区分（否则会静默
  // 重复归档或漏归档）。也不用"kept 为空"：留下的不可完成轮次不该影响 no-op 判定
  // ——重复调用时活跃区**必然**还留着那些不可归档的轮，用 kept 判会让 no-op 永远为假。
  const alreadyArchived = toArchive.length === 0;
  const ledgerBefore = readLedgerFacts(cyclesDir);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      archived: toArchive,
      kept,
      alreadyArchived,
      manifest: readManifest(cyclesDir),
      ledger: ledgerBefore === null ? null
        : { ...ledgerBefore, unchanged: true },
      warnings: [
        ...warnings,
        ...(alreadyArchived ? ['nothing archivable — no-op (already archived)'] : []),
      ],
    };
  }

  const archiveDir = toArchive.length > 0 ? ensureArchiveDir(cyclesDir) : join(cyclesDir, 'archive');
  const manifestCycles: ManifestCycle[] = [];
  const archived: string[] = [];
  for (const name of toArchive) {
    const from = join(cyclesDir, 'cycles', name);
    const to = join(archiveDir, name);
    if (!existsSync(from)) {
      // 并发消失（另一个进程刚归档）⇒ 不是错误，如实跳过并告警。
      warnings.push(`${name}: disappeared before move (concurrent archive?) — skipped`);
      continue;
    }
    if (existsSync(to)) {
      // 目标已存在：**不覆盖**（覆盖会销毁历史），如实告警并保留活跃侧。
      warnings.push(`${name}: already present in archive — left in active area (no overwrite)`);
      kept.push({ name, reason: 'missing-cycle-dir', detail: 'already present in archive; active copy preserved' });
      continue;
    }
    // cycle-91：逐文件移动（目录 rename 被环境禁止，见 dirMove.ts 头注）。
    const mv = moveDirectory(from, to);
    if (!mv.ok) {
      warnings.push(`${name}: move failed — ${mv.reason ?? 'unknown'}`);
      kept.push({ name, reason: 'move-failed', detail: mv.reason ?? 'unknown' });
      continue;
    }
    archived.push(name);
    const entry = active.find((c) => c.name === name);
    manifestCycles.push({
      name,
      num: Number(name.slice(6)),
      files: entry?.files ?? 0,
      archivedFrom: `cycles/${name}`,
      archivedAt: now,
    });
  }

  // manifest：**只在真有移动时**写（no-op 时保留磁盘现状，避免无意义的 mtime 抖动）。
  let manifest = readManifest(cyclesDir);
  if (manifestCycles.length > 0) {
    manifest = mergeManifest(manifest, manifestCycles, now);
    atomicWriteFileSync(join(archiveDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  }

  const ledgerAfter = readLedgerFacts(cyclesDir);
  const unchanged = ledgerBefore === null && ledgerAfter === null
    ? true
    : (ledgerBefore?.entries === ledgerAfter?.entries && ledgerBefore?.chainHead === ledgerAfter?.chainHead);

  // 审计记录（含 dryRun=false 的真实动作；即使是 no-op 也写——"这次跑过、什么都没搬"
  // 本身是一条值得留痕的事实，尤其是排查"为什么某轮还在活跃区"时）。
  const audit: BaselineAudit = {
    actor, at: now, dryRun: false, includeIncomplete,
    archived, kept,
    ledgerBefore, ledgerAfter,
    note: 'ledger untouched (append-only hash chain, INV-9) — directories moved only',
  };
  if (existsSync(archiveDir)) {
    atomicWriteFileSync(join(archiveDir, BASELINE_AUDIT_FILE), JSON.stringify(audit, null, 2) + '\n');
  }

  if (!unchanged) {
    // 这条**永远不该发生**：本模块没有任何写账本的代码路径。真发生说明有并发写者
    // 在同一时刻追加（合法的 append），或本模块被误改。如实上报，不假装正常。
    warnings.push('ledger facts changed during baseline reset — check for concurrent writers (INV-9 expects append-only)');
  }

  return {
    ok: true,
    dryRun: false,
    archived,
    kept,
    alreadyArchived: archived.length === 0,
    manifest,
    ledger: ledgerBefore === null && ledgerAfter === null
      ? null
      : { entries: ledgerAfter?.entries ?? 0, chainHead: ledgerAfter?.chainHead ?? null, unchanged },
    warnings,
  };
}
