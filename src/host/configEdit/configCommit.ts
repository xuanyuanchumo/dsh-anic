/**
 * 配置写入的**提交原语**（cycle-83：从 configWriter.ts 拆出——为回滚复用同一写入器）。
 *
 * ## 为什么必须拆出来而不是在 configWriter 里加一个 `rollback()` 分支
 *
 * 「回滚」不是第二种写路径，它是**同一段提交动作的另一种输入**：
 * 备份当前态 → 原子写 → 回读断言 → 不符则回滚。configWriter 的 applyConfigPatch
 * 是「patch → 这段动作」，回滚是「一份完整原文 → 同一段动作」。若为回滚另写一份
 * `atomicWriteFileSync(config.yml)`，本仓就有了两条写路径（G-SINGLE 的直接违反）：
 * 一条带回读断言、一条不带，而用户真正依赖的是后者。
 *
 * 所以本文件只保留**动作**（备份/写/验/回滚），configWriter 保留**策略**
 * （patch 怎么算、rollback 用哪份原文）。两者相加仍是单一路径。
 *
 * ## 备份纪律（与 cycle-82 逐条一致，不得放宽）
 *
 * 同目录 `config.yml.bak.<ISO 紧凑时间戳>`，只留最近 3 份，按名排序清理；
 * **只删自己造的这个前缀**（用户可能放 `config.yml.old-my-backup`，那是人的资产）。
 * 备份失败即放弃整个写操作（绝不带着伤改正文）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { createScoped } from '../logger.ts';
import { readFieldValue } from './configRead.ts';
import { fieldById, type ConfigFieldDef } from './configSchema.ts';

const log = createScoped('anic:config-edit');

/** 保留的备份份数（超过按名排序删最旧）。 */
export const BACKUP_KEEP = 3;
export const BACKUP_PREFIX = 'config.yml.bak.';

export interface BackupPruneResult {
  kept: string[];
  deleted: string[];
}

export interface WriteOutcome {
  ok: boolean;
  applied: boolean;
  changedFields: string[];
  insertedFields: string[];
  warnings: string[];
  /** 写前原文落成的 .bak 路径（backupPath 存在时可人工核对）。 */
  backupPath: string | null;
  /** 回读到的实际值（Post-Verify 事实；失败时是当前磁盘事实）。 */
  observed: Record<string, unknown> | null;
  error: string;
}

/** 回读断言的结果（注入点与真实现共用同一形状）。 */
export interface VerifyResult {
  ok: boolean;
  observed: Record<string, unknown> | null;
  error: string;
}

/**
 * ISO 紧凑时间戳（`2026-10-27T11:12:21.123Z` → `20261027T111221123Z`）。
 *
 * 保留毫秒是**排序正确性**要求：同一秒内连写两次（自动化脚本很常见）时，
 * 去掉毫秒会让两个备份同名，清理时无法区分新旧。去掉冒号是因为 Windows
 * 文件名不允许，而备份与正文落在同一个 `.cycles/` 目录里。
 */
export function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('.', '');
}

/** 备份文件名（时间戳来自注入的 now，测试可控）。 */
export function backupFileName(now: Date, seq = 0): string {
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

/** 备份当前原文；失败返回原因（调用方据此放弃整个写操作）。 */
function makeBackup(dir: string, content: string, now: Date): { path: string | null; error: string } {
  try {
    mkdirSync(dir, { recursive: true });
    for (let seq = 0; seq < 20; seq += 1) {
      const candidate = join(dir, backupFileName(now, seq));
      if (!existsSync(candidate)) {
        atomicWriteFileSync(candidate, content);
        return { path: candidate, error: '' };
      }
    }
    return { path: null, error: 'could not allocate a unique backup name' };
  } catch (e) {
    return { path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 字段级回读断言：按**解析到的实际值**判定，不信写入意图。
 *
 * 为什么两种读取器都要：`loadWorkspaceConfig` 是唯一语义入口（INV-25）但只覆盖
 * 它消费的字段子集；`readFieldValue` 覆盖 schema 全部字段但绕过 loader。
 * 只靠一种就会漏掉另一半（cycle-82 的原话，回滚路径同样适用）。
 */
export function verifyFields(cyclesDir: string, after: string, changedFields: string[]): VerifyResult {
  let content = '';
  try {
    content = readFileSync(join(cyclesDir, 'config.yml'), 'utf-8');
  } catch (e) {
    return { ok: false, observed: null, error: `re-read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const observed: Record<string, unknown> = {};
  const mismatched: string[] = [];
  for (const id of changedFields) {
    const def = fieldById(id) as ConfigFieldDef | undefined;
    if (def === undefined) continue;
    const got = readFieldValue(content, def);
    observed[id] = got;
    const want = readFieldValue(after, def);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatched.push(`${id}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  if (mismatched.length > 0) return { ok: false, observed, error: mismatched.join('; ') };
  return { ok: true, observed, error: '' };
}

/** 回滚/恢复用的断言：**逐字节**比较（注释也是内容，必须一致）。 */
export function verifyExact(cyclesDir: string, expected: string): VerifyResult {
  let content = '';
  try {
    content = readFileSync(join(cyclesDir, 'config.yml'), 'utf-8');
  } catch (e) {
    return { ok: false, observed: null, error: `re-read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (content !== expected) {
    return { ok: false, observed: null, error: 'content mismatch after restore (bytes differ from backup)' };
  }
  return { ok: true, observed: null, error: '' };
}

/** 提交三参数：注入点全部为**失败路径**服务（详见 configWriter 的 applyConfigPatch 注）。 */
export interface CommitOpts {
  now?: Date;
  /** 写后立刻篡改磁盘（模拟「写了但读不回来」）。 */
  beforeWrite?: (after: string) => void;
}

export interface CommitInput {
  /** 目标全文。 */
  after: string;
  changedFields: string[];
  insertedFields: string[];
  warnings: string[];
  verify: (cyclesDir: string) => VerifyResult;
}

/**
 * 提交一段完整原文：备份 → 原子写 → 回读断言 → 不符则用备份回滚。
 *
 * 这是**唯一**碰 `config.yml` 正文的地方。patch 与 rollback 都从这里进来。
 */
export function commitConfigContent(cyclesDir: string, input: CommitInput, opts: CommitOpts = {}): WriteOutcome {
  const configPath = join(cyclesDir, 'config.yml');
  const before = readFileSync(configPath, 'utf-8');
  const fail = (error: string, backupPath: string | null = null, observed: Record<string, unknown> | null = null): WriteOutcome => ({
    ok: false, applied: false, changedFields: [], insertedFields: [], warnings: input.warnings, backupPath, observed, error,
  });

  // ① 备份：失败即放弃（不带着伤改正文）。
  const made = makeBackup(cyclesDir, before, opts.now ?? new Date());
  if (made.path === null) return fail(`backup failed: ${made.error}`);
  pruneBackups(cyclesDir);

  // ② 原子写正文
  try {
    atomicWriteFileSync(configPath, input.after);
    opts.beforeWrite?.(input.after);
  } catch (e) {
    return fail(`write failed: ${e instanceof Error ? e.message : String(e)}`, made.path);
  }

  // ③ 回读断言（Post-Verify）
  const check = input.verify(cyclesDir);
  if (check.ok) {
    log.info(`config written: ${input.changedFields.join(', ')}`);
    return {
      ok: true, applied: true, changedFields: input.changedFields, insertedFields: input.insertedFields,
      warnings: input.warnings, backupPath: made.path, observed: check.observed, error: '',
    };
  }

  // ④ 回滚：原文从备份写回（原子），并把回读到的当前事实如实返回
  try {
    atomicWriteFileSync(configPath, readFileSync(made.path, 'utf-8'));
  } catch (e) {
    log.error(`config rollback FAILED (backup at ${made.path}): ${e instanceof Error ? e.message : String(e)}`);
    return fail(`readback mismatch AND rollback failed: ${check.error}`, made.path, check.observed);
  }
  log.warn(`config readback mismatch, rolled back: ${check.error}`);
  return fail(`readback mismatch (rolled back from backup): ${check.error}`, made.path, check.observed);
}

/** 当前文件事实（供 GET 使用：字节数 + mtime）。 */
export function configFileStatOf(configPath: string): { exists: boolean; bytes: number; mtime: string | null } {
  if (!existsSync(configPath)) return { exists: false, bytes: 0, mtime: null };
  try {
    const st = statSync(configPath);
    return { exists: true, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}
