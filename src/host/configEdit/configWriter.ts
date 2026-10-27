/**
 * 配置写入的**证据链**（cycle-82）：备份 → 原子写 → 回读断言 → 不符则回滚。
 *
 * ## 为什么回读断言不是装饰
 *
 * 本仓有前科：`autonomyActions.ts` 的文件头写着「唯一做法是手改 config.yml：
 * 无前置判定、无回读断言、无审计记录」。它的修法就是 Post-Verify —— 改完
 * **重新解析**，按解析到的实际值判定，绝不无条件声称「已改」。
 * 这里的写路径完全同源：`loadWorkspaceConfig` 是唯一解析入口（INV-25），
 * 写完用它回读——如果手术刀切错了行（缩进被判成别的段、值被写在下属结构里），
 * 文件字节变了但语义没变，只有回读能发现。
 *
 * ## 备份纪律
 *
 * 同目录 `config.yml.bak.<ISO 紧凑时间戳>`，只保留最近 3 份，按名排序清理。
 * **只删自己造的这个前缀**：用户自己放的同目录文件一个都不碰
 * （目录里可能有 `config.yml.old-my-backup`，那是人的资产）。
 *
 * ## 为什么备份不用原子写
 *
 * 备份是「把原文抄一份」，失败时原文还在（写备份失败就直接放弃整个写操作，
 * 绝不带着伤去改正文）。原子写只用在**正文**上——那才是并发读的依据。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { loadWorkspaceConfig } from '../config.ts';
import { createScoped } from '../logger.ts';
import { planPatch, type PatchPlan } from './yamlPatch.ts';
import { readFieldValue } from './configRead.ts';
import { type ConfigFieldDef, fieldById } from './configSchema.ts';

const log = createScoped('anic:config-edit');

/** 保留的备份份数（超过按名排序删最旧）。 */
export const BACKUP_KEEP = 3;
export const BACKUP_PREFIX = 'config.yml.bak.';

export interface BackupPruneResult {
  kept: string[];
  deleted: string[];
}

/**
 * ISO 紧凑时间戳（`2026-10-27T11:12:21.123Z` → `20261027T111221123Z`）。
 *
 * 保留毫秒是**排序正确性**要求，不是美观：同一秒内连写两次（自动化脚本很常
 * 见）时，去掉毫秒会让两个备份同名，清理时就无法区分谁更旧。去掉冒号是因为
 * Windows 文件名不允许，而备份要落在同一个 `.cycles/` 目录里。
 */
export function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('.', '');
}

/** 备份文件名（时间戳来自注入的 now，测试可控）。 */
export function backupFileName(now: Date, seq = 0): string {
  // 同毫秒内多次写入会撞名：加序号后缀（仍在本前缀内，仍可被排序清理）。
  const base = `${BACKUP_PREFIX}${compactStamp(now)}`;
  return seq === 0 ? base : `${base}-${String(seq)}`;
}

/** 目录内本模块造的备份名（升序 = 从旧到新）。只认严格前缀，绝不误伤用户文件。 */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.length > BACKUP_PREFIX.length)
    .sort();
}

/** 清理旧备份，返回保留/删除清单（只删前缀内文件）。 */
export function pruneBackups(dir: string, keep = BACKUP_KEEP): BackupPruneResult {
  const all = listBackups(dir);
  const excess = all.length > keep ? all.slice(0, all.length - keep) : [];
  const deleted: string[] = [];
  for (const name of excess) {
    try {
      unlinkSync(join(dir, name));
      deleted.push(name);
    } catch (e) {
      log.warn(`backup prune failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { kept: all.slice(-keep), deleted };
}

export interface WriteOutcome {
  ok: boolean;
  applied: boolean;
  changedFields: string[];
  insertedFields: string[];
  warnings: string[];
  /** 写前原文哈希（sha256 前 16 位；backupPath 存在时可用于人工核对）。 */
  backupPath: string | null;
  /** 回读到的实际值（Post-Verify 事实；失败时是当前磁盘事实）。 */
  observed: Record<string, unknown> | null;
  error: string;
}

/**
 * 回读断言：用唯一 loader `loadWorkspaceConfig`（INV-25）解析磁盘事实，
 * 并与「计划里的 after」逐字段比对。
 *
 * 为什么两条腿都要：loader 只覆盖语义子集（build/test/lint/autonomy/flow/
 * toolDisclosure/allowedOrigins），而 project.* / coverage 等字段它不解析；
 * 只靠 schema 读取器会绕过唯一入口（INV-25），只靠 loader 会漏掉一半字段。
 */
function verifyReadback(cyclesDir: string, plan: PatchPlan): { ok: boolean; observed: Record<string, unknown> | null; error: string } {
  let cfg;
  try {
    cfg = loadWorkspaceConfig(cyclesDir);
  } catch (e) {
    return { ok: false, observed: null, error: `re-read threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  const content = readFileSync(join(cyclesDir, 'config.yml'), 'utf-8');
  const observed: Record<string, unknown> = {};
  const mismatched: string[] = [];
  for (const id of plan.changedFields) {
    const def = fieldById(id) as ConfigFieldDef;
    const got = readFieldValue(content, def);
    observed[id] = got;
    const want = readFieldValue(plan.after, def);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatched.push(`${id}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  // loader 交叉确认：这几类是它真正消费的字段，必须与文件事实一致。
  const loaderView: Record<string, unknown> = {
    'macro_cycle.autonomy_level': cfg.values.autonomyLevel,
    'anic.toolDisclosure': cfg.values.toolDisclosure,
    'anic.allowedOrigins': cfg.values.allowedOrigins,
  };
  observed['loader'] = loaderView;
  for (const [id, got] of Object.entries(loaderView)) {
    if (!plan.changedFields.includes(id)) continue;
    const want = readFieldValue(plan.after, fieldById(id) as ConfigFieldDef);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatched.push(`${id}(loader): got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  if (mismatched.length > 0) return { ok: false, observed, error: mismatched.join('; ') };
  return { ok: true, observed, error: '' };
}

/**
 * 应用 patch（备份 → 原子写 → 回读断言 → 失败回滚）。
 *
 * 三个注入点都是**为失败路径服务**的：`beforeWrite` 可在写后立刻篡改磁盘
 * （模拟「写了但读不回来」），`verify` 可整段替换回读判定（模拟断言失败），
 * `now` 固定备份时间戳（让 .bak 命名可断言）。只读目录在 Windows 上造不出来，
 * 注入钩子才是这两条失败路径的可复现证据。
 */
export function applyConfigPatch(
  cyclesDir: string,
  patch: Record<string, unknown>,
  opts: { now?: Date; beforeWrite?: (after: string) => void; verify?: (cyclesDir: string, plan: PatchPlan) => { ok: boolean; observed: Record<string, unknown> | null; error: string } } = {},
): WriteOutcome {
  const configPath = join(cyclesDir, 'config.yml');
  if (!existsSync(configPath)) {
    return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: [], backupPath: null, observed: null, error: 'config.yml not found (run skill init-workflow first)' };
  }
  const before = readFileSync(configPath, 'utf-8');
  const plan = planPatch(before, patch);
  if (!plan.ok) {
    return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: plan.warnings, backupPath: null, observed: null, error: plan.error };
  }
  if (plan.changedFields.length === 0) {
    return { ok: true, applied: false, changedFields: [], insertedFields: [], warnings: plan.warnings, backupPath: null, observed: null, error: '' };
  }

  // ① 备份：失败即放弃（不带着伤改正文）。
  const now = opts.now ?? new Date();
  let backupPath: string | null = null;
  try {
    mkdirSync(cyclesDir, { recursive: true });
    for (let seq = 0; seq < 20 && backupPath === null; seq += 1) {
      const candidate = join(cyclesDir, backupFileName(now, seq));
      if (!existsSync(candidate)) {
        atomicWriteFileSync(candidate, before);
        backupPath = candidate;
      }
    }
    if (backupPath === null) throw new Error('could not allocate a unique backup name');
  } catch (e) {
    return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: plan.warnings, backupPath: null, observed: null, error: `backup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  pruneBackups(cyclesDir);

  // ② 原子写正文
  try {
    atomicWriteFileSync(configPath, plan.after);
    opts.beforeWrite?.(plan.after);
  } catch (e) {
    return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: plan.warnings, backupPath, observed: null, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // ③ 回读断言（Post-Verify）：不信写入意图，只信解析结果
  const verify = opts.verify ?? verifyReadback;
  const check = verify(cyclesDir, plan);
  if (check.ok) {
    log.info(`config patched: ${plan.changedFields.join(', ')}`);
    return { ok: true, applied: true, changedFields: plan.changedFields, insertedFields: plan.insertedFields, warnings: plan.warnings, backupPath, observed: check.observed, error: '' };
  }

  // ④ 回滚：原文从备份写回（原子），并把回读到的**当前事实**如实返回
  try {
    atomicWriteFileSync(configPath, readFileSync(backupPath, 'utf-8'));
  } catch (e) {
    log.error(`config rollback FAILED (backup at ${backupPath}): ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, applied: false, changedFields: plan.changedFields, insertedFields: plan.insertedFields, warnings: plan.warnings, backupPath, observed: check.observed, error: `readback mismatch AND rollback failed: ${check.error}` };
  }
  log.warn(`config readback mismatch, rolled back: ${check.error}`);
  return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: plan.warnings, backupPath, observed: check.observed, error: `readback mismatch (rolled back from backup): ${check.error}` };
}

/** 当前文件事实（供 GET 使用：原文 + 字节数 + mtime）。 */
export function configFileStat(configPath: string): { exists: boolean; bytes: number; mtime: string | null } {
  if (!existsSync(configPath)) return { exists: false, bytes: 0, mtime: null };
  try {
    const st = statSync(configPath);
    return { exists: true, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}
