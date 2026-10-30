/**
 * 产物归档的**公开入口**（cycle-83 产物治理写侧）—— 消费者只认这一个路径。
 *
 * ## 为什么拆成三文件（而不是一个 300 行的模块）
 *
 * 一个文件同时装「磁盘事实读取」「批量移动与审计」「类型契约」必破 T3 ≤250 行。
 * 但拆分边界不能按行数硬切（那样回滚会变成"改一处动三处"），只能沿职责切：
 *
 *   artifactArchiveFacts.ts     读侧事实：完成判定（与 G1 同解析器）/ 清单 / manifest / 账本只读
 *   artifactArchiveBaseline.ts  写侧动作：批量移动 + manifest 合并 + baseline-reset.json 审计
 *   本文件                       再导出（消费者 import 路径零变更 + 单一入口）
 *
 * ## 两条承重裁决（写在这里，因为这是人最先打开的文件）
 *
 * ① 完成判定与 G1 **共用同一任务行解析器**——两处各写一份必然分叉。
 * ② **归档只移动目录，永不触碰账本**（INV-9）。历史不是被删除，而是被移出主视图。
 */
export type {
  ArchiveBlockReason,
  ArchiveManifest,
  ArchivedCycleEntry,
  BaselineOptions,
  BaselineResult,
  CompletenessVerdict,
  CycleEntry,
  ManifestCycle,
} from './artifactArchiveFacts.ts';
export {
  archiveReasonDetail,
  isCycleCompleteForArchive,
  listActiveCycles,
  listArchivedCycles,
  readLedgerFacts,
  readManifest,
} from './artifactArchiveFacts.ts';

export type { BaselineAudit } from './artifactArchiveBaseline.ts';
export {
  archiveBaseline,
  BASELINE_AUDIT_FILE,
  MANIFEST_FILE,
} from './artifactArchiveBaseline.ts';
