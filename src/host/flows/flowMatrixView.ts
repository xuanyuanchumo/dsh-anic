/**
 * 流程 ↔ 循环/相位/门禁 矩阵的**响应投影**（cycle-89）。
 *
 * ## 为什么单独成文件
 *
 * `flowJoin.ts`（分组）与 `flowJoinMetrics.ts`（量化指标）是**判据**，
 * 纯函数、零 IO。而路由要做的是**投影**：把磁盘上的 FlowRecord 变成
 * 一个**可 JSON 序列化、且不泄露大字段**的响应体。
 *
 * 两者是不同抽象层：判据不管「响应里该放什么」，投影不管「怎么分组」。
 * 混在一起会让「分组规则」与「响应契约」互相牵制 —— 改响应字段时
 * 怕碰坏分组，改分组时怕碰坏响应。
 *
 * ## 投影的**裁剪纪律**（本模块存在的核心理由）
 *
 * `FlowRecord` 带 `stdout`（≤8000 字符）与 `stderr`（≤4000 字符）。
 * 直接把 FlowRecord 塞进响应体 = 每次拉取传输十几 KB 的日志文本 ——
 * 而面板的量化条只需要**计数**。
 *
 * ⇒ 响应里每条记录只保留**摘要字段**：id / script / status / 时间 /
 * 归属三元组。**stdout/stderr 一律不投影**（它们属于「展开看详情」的按需读面，
 * 不属于「量化条」这张表）。
 *
 * ## 隔离纪律
 *
 * 调用方**必须**先按工作区过滤（`filterByWorkspace`），本模块**不**做过滤 ——
 * 因为「过滤哪些记录」是判据（属 flowJoin），「怎么投影」才是投影。
 * 但本模块**会**把传入的工作区写进响应（`workspace` 字段），
 * 让调用方能自证「这份数据确实是这个工作区的」。
 */
import type { FlowRecord } from '../runtime/flowTracker.ts';
import { joinFlows, filterByWorkspace, type FlowGroup } from './flowJoin.ts';
import { coverageMetrics } from './flowJoinMetrics.ts';
import type { CoverageMetrics } from './flowJoin.ts';

/** 单条记录的**摘要形态**（响应里唯一的记录形态）。 */
export interface FlowSummary {
  flowId: string;
  script: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number;
  cycle?: string;
  phase?: string;
  gate?: string;
}

/** 分组投影（计数 + 摘要列表；**不含** stdout/stderr）。 */
export interface FlowGroupSummary {
  key: string;
  total: number;
  done: number;
  failed: number;
  timeout: number;
  active: number;
  scripts: Record<string, number>;
  flows: FlowSummary[];
}

/** 矩阵响应体（`GET /anic/api/flows/matrix`）。 */
export interface FlowMatrixView {
  /** 本次查询针对的工作区（归一后）——让调用方能自证数据归属。 */
  workspace: string | null;
  /** 总量（含孤儿）。 */
  total: number;
  /** 量化指标（归属率 / 孤儿 / 门禁证据覆盖 / 三维分布）。 */
  metrics: CoverageMetrics;
  /** 按循环分组。 */
  byCycle: FlowGroupSummary[];
  /** 按相位分组。 */
  byPhase: FlowGroupSummary[];
  /** 按门禁分组。 */
  byGate: FlowGroupSummary[];
  /** 孤儿摘要（无归属的记录）。 */
  orphans: FlowSummary[];
}

/** 记录 → 摘要（只留面板量化条需要的字段）。 */
export function toFlowSummary(record: FlowRecord): FlowSummary {
  const summary: FlowSummary = {
    flowId: record.flowId,
    script: record.script,
    status: record.status,
    startedAt: record.startedAt,
  };
  if (record.endedAt !== undefined) summary.endedAt = record.endedAt;
  if (record.durationMs !== undefined) summary.durationMs = record.durationMs;
  if (record.exitCode !== undefined) summary.exitCode = record.exitCode;
  if (record.cycle !== undefined) summary.cycle = record.cycle;
  if (record.phase !== undefined) summary.phase = record.phase;
  if (record.gate !== undefined) summary.gate = record.gate;
  return summary;
}

/** 分组 → 分组投影（计数原样带过，flows 裁剪成摘要）。 */
export function toGroupSummary(group: FlowGroup): FlowGroupSummary {
  return {
    key: group.key,
    total: group.total,
    done: group.done,
    failed: group.failed,
    timeout: group.timeout,
    active: group.active,
    scripts: { ...group.scripts },
    flows: group.flows.map(toFlowSummary),
  };
}

/**
 * 构造矩阵视图。
 *
 * @param records **已按工作区过滤**的记录（调用方负责）
 * @param workspace 本次查询的工作区（写进响应供自证）
 */
export function buildFlowMatrixView(records: readonly FlowRecord[], workspace: string | null): FlowMatrixView {
  const index = joinFlows(records);
  return {
    workspace,
    total: index.total,
    metrics: coverageMetrics(records),
    byCycle: index.byCycle.map(toGroupSummary),
    byPhase: index.byPhase.map(toGroupSummary),
    byGate: index.byGate.map(toGroupSummary),
    orphans: index.orphans.map(toFlowSummary),
  };
}

/**
 * 端点用的一站式构造：读记录 → 按工作区过滤 → 投影。
 *
 * @param allRecords 磁盘上的全部记录（**可能包含别的项目的**）
 * @param workspace 目标工作区（null = 不做过滤，返回空）
 */
export function buildFlowMatrixForWorkspace(
  allRecords: readonly FlowRecord[],
  workspace: string | null,
): FlowMatrixView {
  const filtered = workspace === null ? [] : filterByWorkspace(allRecords, workspace);
  return buildFlowMatrixView(filtered, workspace);
}
