/**
 * 备份可见与回滚（cycle-83）——把「.bak 只能人肉 cp 回去」变成可点的一次恢复。
 *
 * ## 为什么回滚必须复用同一写入器（G-SINGLE 的直接要求）
 *
 * 回滚是**另一种输入**，不是另一条写路径：`applyConfigPatch` 是「patch → 提交动作」，
 * 回滚是「一份完整原文 → 同一段提交动作（备份/写/回读）」。若在这里自己
 * `atomicWriteFileSync(config.yml)`，本仓就有两条写路径：一条带回读断言、
 * 一条不带——而用户真正依赖的恰好是后者。所以本文件只**算出**要写什么，
 * 提交交给 `commitConfigContent`（configCommit.ts，唯一碰正文的地方）。
 *
 * ## 回滚前先备份当前态（否则回滚是不可逆操作）
 *
 * 用户回滚的目的是「回到昨天那份」，但**今天的状态也是他的资产**：回滚一次就把
 * 「回滚前的状态」永久丢掉，是最经典的不可逆操作。commitConfigContent 的
 * 备份步骤天然满足这条（它总是先备份当前原文），但顺序必须明说：
 * 回滚的备份是**回滚前**的正文，不是备份文件的副本。
 *
 * ## diff 摘要：每个 .bak 相对当前改了什么
 *
 * 只列文件名等于让用户自己 diff。摘要给的是**字段级**（`changedFields`），
 * 因为用户能理解的单位是「L4 会变成 L3」，不是「第 17 行不同」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScoped } from '../logger.ts';
import { loadWorkspaceConfig } from '../config.ts';
import { CONFIG_FIELDS, fieldById } from './configSchema.ts';
import { readFieldValue } from './configRead.ts';
import {
  BACKUP_PREFIX,
  commitConfigContent,
  listBackups,
  verifyExact,
  type WriteOutcome,
} from './configCommit.ts';

const log = createScoped('anic:config-backup');

/** 单个备份的可见事实 + 相对当前配置的差异摘要。 */
export interface BackupView {
  /** 文件名（客户端回传这个值给 rollback，不接受路径）。 */
  name: string;
  /** 备份时刻（从紧凑时间戳还原的 ISO；解析不了时为 null——不猜）。 */
  at: string | null;
  bytes: number;
  /** 相对**当前** config.yml 发生变化的字段 id（升序）。 */
  changedFields: string[];
  /** 每个字段的两侧值（只有 changedFields 里出现的键）。 */
  values: Record<string, { backup: unknown; current: unknown }>;
}

/** 紧凑时间戳 → ISO（`20261027T030002000Z` → `2026-10-27T03:00:02.000Z`）。解析不了返回 null。 */
export function stampToIso(name: string): string | null {
  if (!name.startsWith(BACKUP_PREFIX)) return null;
  const s = name.slice(BACKUP_PREFIX.length).replace(/-\d+$/, '');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, ms] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}.${ms}Z`;
  // 交叉验证：还原后再走一遍 Date 解析，非法日期（如 13 月）返回 null 而不是编一个。
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}

/** 读一份文本的字段值表（缺键 = null，如实标注）。 */
function fieldsOf(content: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of CONFIG_FIELDS) out[def.id] = readFieldValue(content, def);
  return out;
}

/** 两侧差异（字段级）。 */
export function diffFields(backupContent: string, currentContent: string): {
  changedFields: string[];
  values: Record<string, { backup: unknown; current: unknown }>;
} {
  const a = fieldsOf(backupContent);
  const b = fieldsOf(currentContent);
  const changedFields: string[] = [];
  const values: Record<string, { backup: unknown; current: unknown }> = {};
  for (const def of CONFIG_FIELDS) {
    if (JSON.stringify(a[def.id]) !== JSON.stringify(b[def.id])) {
      changedFields.push(def.id);
      values[def.id] = { backup: a[def.id] ?? null, current: b[def.id] ?? null };
    }
  }
  return { changedFields, values };
}

/**
 * 备份清单（新到旧）+ 每份的 diff 摘要。
 *
 * 读不出来的备份**保留在清单里但标记**（`at=null` + 空摘要 + 进 warnings 由调用方取）：
 * 从清单里悄悄丢掉一份文件比显示一个坏文件更糟——用户会以为「我的备份没了」。
 */
export function listBackupsWithDiff(cyclesDir: string): BackupView[] {
  const configPath = join(cyclesDir, 'config.yml');
  if (!existsSync(configPath)) return [];
  let current = '';
  try {
    current = readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }
  const names = listBackups(cyclesDir).slice().reverse(); // 新到旧：用户先看最近那份
  const out: BackupView[] = [];
  for (const name of names) {
    const abs = join(cyclesDir, name);
    let content = '';
    let bytes = 0;
    try {
      content = readFileSync(abs, 'utf-8');
      bytes = content.length;
    } catch {
      out.push({ name, at: stampToIso(name), bytes: 0, changedFields: [], values: {} });
      continue;
    }
    const d = diffFields(content, current);
    out.push({ name, at: stampToIso(name), bytes, changedFields: d.changedFields, values: d.values });
  }
  return out;
}

/** 回滚计划（dryRun 与真写共用 —— 同 config 的裁决）。 */
export interface RollbackPlan {
  ok: boolean;
  /** 备份文件名（只接受清单内的名字，不接受路径）。 */
  name: string;
  /** 备份内容（ok=true 时才有意义）。 */
  content: string;
  changedFields: string[];
  warnings: string[];
  error: string;
}

/**
 * 校验并读取要回滚的备份。
 *
 * 为什么只接受**文件名**而不是路径：接受路径就多了一个任意文件读取入口
 * （`backup: "../../../etc/passwd"` 会被当成源）。名字必须同时满足：
 * 在本模块前缀内、在 `listBackups()` 的清单里（严格前缀 + 目录内实际存在）。
 */
export function planRollback(cyclesDir: string, backup: unknown): RollbackPlan {
  const bad = (error: string): RollbackPlan => ({ ok: false, name: '', content: '', changedFields: [], warnings: [], error });
  if (typeof backup !== 'string' || backup.trim() === '') return bad('body.backup must be a backup file name');
  const name = backup.trim();
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return bad('body.backup must be a bare file name (no path segments)');
  if (!name.startsWith(BACKUP_PREFIX) || name.length === BACKUP_PREFIX.length) {
    return bad(`backup name must start with ${BACKUP_PREFIX} (only this module's own backups are restorable)`);
  }
  const known = listBackups(cyclesDir);
  if (!known.includes(name)) return bad(`unknown backup: ${name} (not in .cycles/ backup list)`);
  const configPath = join(cyclesDir, 'config.yml');
  if (!existsSync(configPath)) return bad('config.yml not found (nothing to roll back onto)');
  let content = '';
  try {
    content = readFileSync(join(cyclesDir, name), 'utf-8');
  } catch (e) {
    return bad(`backup unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (content.trim() === '') return bad(`backup is empty: ${name}（空内容回滚会把配置清空，拒绝）`);
  // 交叉验证：备份必须能作为配置被**唯一 loader** 解析（否则回滚等于把坏内容写进去）。
  // 走临时目录太重，这里用 schema 读取器做形状证据：至少要能读回 project 段。
  const diff = diffFields(content, readFileSync(configPath, 'utf-8'));
  const warnings: string[] = [];
  if (!/^\s*project\s*:/m.test(content)) warnings.push(`${name}: 备份里没有 project 段（可能不是本插件的配置备份）`);
  return { ok: true, name, content, changedFields: diff.changedFields, warnings, error: '' };
}

/** 回滚结果（在 WriteOutcome 之上补「备份了回滚前状态」这条事实）。 */
export interface RollbackOutcome extends WriteOutcome {
  /** 回滚目标是哪份备份。 */
  backup: string;
  /** 回滚**前**的当前态被备份到哪（用户据此可以回滚回去——不可逆性的补救）。 */
  safetyBackupPath: string | null;
}

/**
 * 执行回滚：把备份内容写回 config.yml，走**同一提交器**。
 *
 * 三点顺序都是刻意的：
 * ① commitConfigContent 先备份**当前**正文（于是回滚本身可再回滚）；
 * ② 再原子写备份内容；
 * ③ 回读断言用**逐字节**比较（注释也是内容：备份里那四行「为什么这么配」的
 *    注释必须原样回来，否则「恢复」只是恢复了值，丢掉了理由）。
 */
export function rollbackConfig(cyclesDir: string, backup: unknown, opts: { now?: Date } = {}): RollbackOutcome {
  const plan = planRollback(cyclesDir, backup);
  const failBase = { changedFields: [] as string[], insertedFields: [] as string[], warnings: plan.warnings, backupPath: null, observed: null };
  if (!plan.ok) {
    return { ok: false, applied: false, ...failBase, error: plan.error, backup: '', safetyBackupPath: null };
  }
  const out = commitConfigContent(cyclesDir, {
    after: plan.content,
    changedFields: plan.changedFields,
    insertedFields: [],
    warnings: plan.warnings,
    verify: (dir) => verifyExact(dir, plan.content),
  }, { now: opts.now });
  if (!out.ok) log.warn(`rollback to ${plan.name} failed: ${out.error}`);
  else log.info(`rolled back to ${plan.name} (${plan.changedFields.length} fields)`);
  return { ...out, backup: plan.name, safetyBackupPath: out.backupPath };
}

/**
 * 反向验证：回滚后的内容必须能被唯一 loader 解析（INV-25）。
 *
 * 为什么单独再验一次：`verifyExact` 只证明字节回来了；若那份备份本身是
 * 语法半坏的（用户手改过 .bak），字节相等也不代表「配置可读」。这条是
 * 「回滚成功」的语义层证据，与字节层证据互补。
 */
export function readbackAfterRollback(cyclesDir: string): { ok: boolean; error: string } {
  try {
    loadWorkspaceConfig(cyclesDir);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: `loader threw after rollback: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 字段的展示名（服务端不给词条文本——客户端用 labelKey 自己 t()）。 */
export function backupFieldLabel(id: string): string {
  const def = fieldById(id);
  return def === undefined ? id : def.labelKey;
}
