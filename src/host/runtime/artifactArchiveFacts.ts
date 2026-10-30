/**
 * 归档的**读侧事实**（cycle-83）：完成判定、清单、manifest、账本只读读数。
 *
 * ## 承重裁决（照抄 `flows/archiveEngine.ts` 文件头，两条都不可谈判）
 *
 * ① **完成判定必须与 G1 共用同一任务行解析器**（`flows/gateArtifacts.parseTaskRows`）。
 *    「G1 说完成、归档说没完成」分叉的根因就是两处各写一份判定。
 * ② **归档只移动目录，永不触碰账本**（INV-9 只追加哈希链）。按 detail 删条目会让
 *    后续所有 `previousHash` 指向已删条目，下一次 `verifyLedger` 必报 CHAIN_BREAK，
 *    整条链从此不可信。本文件对账本**只有读**：读出来供审计留痕，一个字都不改。
 *
 * ## `total === 0` 死锁的修法（本轮真实缺陷）
 *
 * `isCycleComplete` 的旧判据是 `rows.length > 0 && pending === 0`，于是"任务清单存在
 * 但零任务行"的轮次恒判不完成 ⇒ 永久不可归档。本仓 cycle-1 / cycle-75 正是这种形态。
 * 本模块把「不可归档」拆成三种**可区分**的原因：
 *   - `missing-task-list`  清单文件不存在（这轮根本没走完初始化）；
 *   - `empty-task-list`    清单在但零任务行 ⇒ **不可归档但不阻塞基线重置**，如实点名；
 *   - `has-pending`        有未完成任务 ⇒ 真的还不能归档。
 * 三者都返回 `complete: false`，但调用方（以及人）能据此决定处置——
 * 「一个 false」把所有情形压成同一个读数，那正是不可行动的形态。
 *
 * ## 为什么 manifest 的读也在这里
 *
 * 写侧（`artifactArchiveBaseline.ts`）与路由 inventory 都要读它。两处各写一份解析
 * 会在"畸形 JSON 算空还是算坏"上分叉——那是双真相源。这里定一个口径：
 * **畸形 ⇒ null**（= 没有可用的 manifest），由调用方决定怎么显示。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTaskRows } from '../flows/gateArtifacts.ts';
import { dirSize, listCycleFacts } from '../../shared/snapshotProjection/cycleInventory.ts';

/** 不可归档的原因（逐条可执行，不是一句 false）。 */
export type ArchiveBlockReason =
  | 'missing-cycle-dir'
  | 'missing-task-list'
  | 'empty-task-list'
  | 'has-pending'
  /**
   * cycle-87：调用方用 `names` 限定了候选集，这一轮**没被选中**。
   *
   * 为什么要单独一个原因而不是"不出现"：`kept` 的语义是"这轮为什么还留在活跃区"。
   * 静默从结果里消失会让调用方以为"它已经被归档了"——而它其实还在原地。
   */
  | 'not-selected';

/** 一轮的归档可得性判定（`complete=true` 时 reason 为 undefined）。 */
export interface CompletenessVerdict {
  complete: boolean;
  reason?: ArchiveBlockReason;
  /** 任务行总数（missing-task-list 时为 0）。 */
  total: number;
  /** 未完成任务行数。 */
  pending: number;
}

/** 活跃/归档轮的清单条目（含体积读数）。 */
export interface CycleEntry {
  name: string;
  num: number;
  files: number;
  bytes: number;
}

/** 归档轮的额外事实（归档时间来源 = 目录 mtime；不入账本）。 */
export interface ArchivedCycleEntry extends CycleEntry {
  archivedAt: string;
}

/** manifest 的单条（`archive/manifest.json` 的 `cycles[]` 元素）。 */
export interface ManifestCycle {
  name: string;
  num: number;
  files: number;
  /** 从哪个相对路径移进来的（审计可回溯：`cycles/cycle-12`）。 */
  archivedFrom: string;
  /** 归档时间（ISO）。 */
  archivedAt: string;
}

export interface ArchiveManifest {
  archivedAt: string;
  cycles: ManifestCycle[];
  totalBytes: number;
}

/** `archiveBaseline` 的调用参数。 */
export interface BaselineOptions {
  /** 只算不写（面板/CLI 的预览段，与真写共用同一判据）。 */
  dryRun?: boolean;
  /**
   * 连"不可完成"的轮次一起移动。
   *
   * 默认 false：移动未完成的轮会让任务清单从活跃区消失，读者再也看不到未完成的工作
   * ——那与「基线重置」的目的（让当前事实清晰）相反。仅当用户明确知道自己在做什么
   * （例如把历史脏目录整体封存）才置 true。
   */
  includeIncomplete?: boolean;
  /** 审计记录里的执行者标识（缺省为模块名；测试可注入以断言留痕）。 */
  actor?: string;
  /**
   * 只处理这些轮次（cycle-87）。
   *
   * 为什么需要：`includeIncomplete: true` 是"全封存"开关，但它会**连可完成的轮一起搬走**
   * ——想单独封存 4 个历史脏目录时，那会把当前正在用的轮次也扫进去。给定 `names`
   * 后候选集先被收窄，再走同一套完成判定；未选中的轮以 `not-selected` 点名保留。
   */
  names?: readonly string[];
}

/** 基线重置结果（dryRun 与真写**同形**，便于面板两段式复用）。 */
export interface BaselineResult {
  ok: boolean;
  dryRun: boolean;
  /** 被（将要）移入归档区的轮次名（数值序）。 */
  archived: string[];
  /** 留在活跃区、并逐个点名的轮次。 */
  kept: Array<{ name: string; reason: ArchiveBlockReason; detail: string }>;
  /** 本次是 no-op（没有可归档的轮次）。 */
  alreadyArchived: boolean;
  /** 真写后回读的 manifest（dryRun 时 = 磁盘现状或 null）。 */
  manifest: ArchiveManifest | null;
  /** 账本审计读数（写前/写后；`unchanged` 恒应为 true —— INV-9）。 */
  ledger: { entries: number; chainHead: string | null; unchanged: boolean } | null;
  warnings: string[];
}

/**
 * 完成判定（与 G1 共用 `parseTaskRows`；`total === 0` 不再被压成一句 false）。
 *
 * @param cyclesDir 工作区 `.cycles` 目录绝对路径
 * @param cycleName `cycle-N` 目录名
 */
export function isCycleCompleteForArchive(cyclesDir: string, cycleName: string): CompletenessVerdict {
  const cyclePath = join(cyclesDir, 'cycles', cycleName);
  if (!existsSync(cyclePath)) return { complete: false, reason: 'missing-cycle-dir', total: 0, pending: 0 };
  const taskListPath = join(cyclePath, '任务清单.md');
  if (!existsSync(taskListPath)) return { complete: false, reason: 'missing-task-list', total: 0, pending: 0 };
  let text: string;
  try {
    text = readFileSync(taskListPath, 'utf-8');
  } catch {
    // 读失败按 missing 处理：不可读 ≠ 空清单，两者处置不同（一个要修权限/一个要补任务）
    return { complete: false, reason: 'missing-task-list', total: 0, pending: 0 };
  }
  const rows = parseTaskRows(text);
  // ★死锁修复：零任务行是**独立的第三种原因**，不是"未完成"（后者意味着还有活要干）。
  if (rows.length === 0) return { complete: false, reason: 'empty-task-list', total: 0, pending: 0 };
  const pending = rows.filter((r) => r[r.length - 1] !== '完成').length;
  if (pending > 0) return { complete: false, reason: 'has-pending', total: rows.length, pending };
  return { complete: true, total: rows.length, pending: 0 };
}

/** 活跃轮清单（带体积读数；**不含**完成判定——判定单独可查，避免清单变慢）。 */
export function listActiveCycles(cyclesDir: string): CycleEntry[] {
  const root = join(cyclesDir, 'cycles');
  return listCycleFacts(root).map((c) => {
    const s = dirSize(join(root, c.name));
    return { name: c.name, num: c.num, files: s.files, bytes: s.bytes };
  });
}

/** 归档轮清单（归档时间取目录 mtime；manifest 缺失时仍然可用）。 */
export function listArchivedCycles(cyclesDir: string): ArchivedCycleEntry[] {
  const root = join(cyclesDir, 'archive');
  return listCycleFacts(root, { withDate: true }).map((c) => {
    const s = dirSize(join(root, c.name));
    let archivedAt = '';
    // 取**完整** ISO 时间（快照侧只取日期，清单侧要给运维精确时刻）
    try { archivedAt = statSync(join(root, c.name)).mtime.toISOString(); } catch { /* 无 mtime → 空串 */ }
    return { name: c.name, num: c.num, files: s.files, bytes: s.bytes, archivedAt };
  });
}

/** 读 manifest（缺失/畸形 ⇒ null；"第一次"与"读坏了"由调用方按语义区分）。 */
export function readManifest(cyclesDir: string): ArchiveManifest | null {
  const p = join(cyclesDir, 'archive', 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ArchiveManifest>;
    return {
      archivedAt: typeof raw.archivedAt === 'string' ? raw.archivedAt : '',
      cycles: Array.isArray(raw.cycles) ? (raw.cycles as ManifestCycle[]) : [],
      totalBytes: typeof raw.totalBytes === 'number' ? raw.totalBytes : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 账本**只读**审计读数（INV-9：本模块从不写账本，只留证据）。
 *
 * `chainHead` 取包裹形态的顶层字段；缺失时以末条 hash 自愈（与 `runtime/ledger.ts` 同口径）。
 */
export function readLedgerFacts(cyclesDir: string): { entries: number; chainHead: string | null } | null {
  const p = join(cyclesDir, 'gates', 'ledger.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as
      | { entries?: unknown; chainHead?: unknown }
      | unknown[];
    if (Array.isArray(raw)) {
      const last = raw[raw.length - 1] as { hash?: unknown } | undefined;
      return { entries: raw.length, chainHead: typeof last?.hash === 'string' ? last.hash : null };
    }
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const last = entries[entries.length - 1] as { hash?: unknown } | undefined;
    const head = typeof raw.chainHead === 'string'
      ? raw.chainHead
      : (typeof last?.hash === 'string' ? last.hash : null);
    return { entries: entries.length, chainHead: head };
  } catch {
    return null;
  }
}

/** 人读原因（"为什么这轮没被归档"必须是一句能执行的话）。 */
export function archiveReasonDetail(verdict: CompletenessVerdict): string {
  switch (verdict.reason) {
    case 'missing-cycle-dir': return 'cycle directory not found';
    case 'missing-task-list': return '任务清单.md missing (cycle never finished init)';
    case 'empty-task-list': return '任务清单.md has 0 task rows (cannot prove completion; does not block baseline reset)';
    case 'has-pending': return `${String(verdict.pending)}/${String(verdict.total)} task rows pending`;
    default: return 'not archivable';
  }
}
