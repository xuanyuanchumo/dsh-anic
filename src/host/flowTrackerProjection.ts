/**
 * FlowTracker 有界视图投影器（cycle-101 · dsh-context "无限流→有界视图" 模式）。
 *
 * ## 缺口（本轮实测，非推测）
 *
 * `.cycles/flow-tracker.json` 实测 164 条 flow / 2851 行，其中 142 条带 stdout
 * （单条最长 8000 字符）。anic_status 默认把整包结构化返回 —— dsh-context 的核心
 * 洞察是：**投影不是压缩 LLM 上下文，而是把无限增长的事件流折叠成有界状态**，
 * 让工具/UI 每次只取有界视图。
 *
 * ## 三道防线（逐条对齐 CTX 实现）
 *
 * 1. **字段白名单**（CTX wire.view 比 state schema 窄）：视图只出
 *    flowId/script/status/exitCode/durationMs/cycle/phase/gate —— stdout/stderr
 *    这些大文本留在 state 里（终端卡片走 presentationMeta 通道），不进视图。
 * 2. **保留钳制 + Floor 水位线**（CTX zt @26719）：只取尾部 N 条；被裁条数如实
 *    回报 `dropped`，并给 `floorStartedAt`（"裁到哪儿"，floor 单调可比 —— 条数不是）。
 * 3. **版本迁移幂等**（CTX Wa sweep）：`stateVersion` 显式标记，读到旧数据只判定
 *    该不该升版，不重写（lazy，不阻塞主路径）。
 *
 * ## 纯函数纪律
 *
 * 零 I/O、零时钟、零随机 —— 与 presentCall/presentResult 同一条官方硬性规则
 * （kb: adding-a-tool.md 反模式 #5）：投影会在直播流与日志回放两个上下文被调用。
 */

import type { FlowRecord, FlowTrackerState, FlowStatus } from './runtime/flowTrackerTypes.ts';

/** 对外视图条目（字段白名单——无 stdout/stderr/args）。 */
export interface FlowHeadEntry {
  flowId: string;
  script: string;
  status: FlowStatus;
  exitCode: number | null;
  durationMs: number | null;
  cycle: string | null;
  phase: string | null;
  gate: string | null;
}

/** 脚本统计读数（由 flowStats 派生面投影而来）。 */
export interface FlowScriptStat {
  total: number;
  done: number;
  failed: number;
  timeout: number;
  /** 成功率 = done / total（治标读数；timedOut 是 DONE 的子集语义见 CLAUDE.md）。 */
  successRate: number;
}

/** 有界视图（wire 面）。 */
export interface FlowTrackerView {
  /** 投影版本（迁移依据）。 */
  stateVersion: number;
  /** 历史总量（state.counter —— 一共跑过多少次，不是窗口内条数）。 */
  totalEver: number;
  /** 全部记录条数（含被裁窗口外的）。 */
  totalRecords: number;
  /** 窗口内条目数。 */
  kept: number;
  /** 被窗口裁掉的条数（诚实读数，不是错误）。 */
  dropped: number;
  /** 被裁条目的 startedAt 上界（floor 语义：≥ 该时间的都在窗口内）。 */
  floorStartedAt: string | null;
  /** 尾部 N 条（时间正序）。 */
  head: FlowHeadEntry[];
  /** 脚本级统计摘要。 */
  stats: Record<string, FlowScriptStat>;
}

/** 视图投影选项。 */
export interface ProjectionOptions {
  /** 窗口大小（默认 50；anic_status 的 flowLimit 映射到此）。 */
  limit?: number;
  /** 只出统计、不出条目明细（读数场景）。 */
  summaryOnly?: boolean;
}

const DEFAULT_LIMIT = 50;
/** 投影版本常量——升版改这里 + needsUpgrade 的历史分支。 */
export const FLOW_VIEW_VERSION = 1;

/** 单条 FlowRecord → 白名单视图条目。 */
function toHeadEntry(rec: FlowRecord): FlowHeadEntry {
  return {
    flowId: rec.flowId,
    script: rec.script,
    status: rec.status,
    exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null,
    durationMs: typeof rec.durationMs === 'number' ? rec.durationMs : null,
    cycle: rec.cycle ?? null,
    phase: rec.phase ?? null,
    gate: rec.gate ?? null,
  };
}

/**
 * 脚本统计投影（与 runtime/flowTrackerQuery.ts 的 flowStats 同构，
 * 但**不 import 它**——投影层保持零依赖运行时，避免读路径产生环）。
 * 多一个 successRate 读数：管理面板直接消费，不必二次算。
 */
function projectStats(flows: FlowRecord[]): Record<string, FlowScriptStat> {
  const stats: Record<string, FlowScriptStat> = {};
  for (const f of flows) {
    let s = stats[f.script];
    if (!s) {
      s = { total: 0, done: 0, failed: 0, timeout: 0, successRate: 0 };
      stats[f.script] = s;
    }
    s.total += 1;
    if (f.status === 'DONE') s.done += 1;
    else if (f.status === 'FAILED') s.failed += 1;
    else if (f.status === 'TIMEOUT') s.timeout += 1;
  }
  for (const s of Object.values(stats)) {
    s.successRate = s.total > 0 ? s.done / s.total : 0;
  }
  return stats;
}

/**
 * 主投影：state → 有界视图。纯函数（同一输入必得同一输出）。
 *
 * 步骤：尾部切 N（slice(-N)，O(N) 不复制整表）→ 逐条白名单投影
 *      → dropped/floor 由长度差与首条被裁记录导出。
 */
export function projectFlowTrackerView(
  state: FlowTrackerState | null | undefined,
  opts: ProjectionOptions = {},
): FlowTrackerView {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 500));
  const emptyView: FlowTrackerView = {
    stateVersion: FLOW_VIEW_VERSION,
    totalEver: 0,
    totalRecords: 0,
    kept: 0,
    dropped: 0,
    floorStartedAt: null,
    head: [],
    stats: {},
  };
  if (!state) return emptyView;

  const all: FlowRecord[] = Array.isArray(state.flows) ? state.flows : [];
  const windowed = all.length > limit ? all.slice(-limit) : all;
  const dropped = all.length - windowed.length;
  // Floor：最后一条**被裁掉**记录的时间（窗口内记录的 startedAt 都 ≥ 它）
  const floorStartedAt = dropped > 0 ? (all[dropped - 1]?.startedAt ?? null) : null;

  return {
    stateVersion: FLOW_VIEW_VERSION,
    totalEver: typeof state.counter === 'number' ? state.counter : all.length,
    totalRecords: all.length,
    kept: windowed.length,
    dropped,
    floorStartedAt,
    head: opts.summaryOnly ? [] : windowed.map(toHeadEntry),
    stats: projectStats(all),
  };
}

/**
 * 版本迁移判定（lazy，幂等）：不改入参，只回答"该不该升版"。
 * 对齐 CTX 的 `ver !== 36 → 重折叠升 37`：读到就标记，写回由调用方决定。
 */
export function needsUpgrade(state: FlowTrackerState | null | undefined): boolean {
  if (!state) return false;
  const v = (state as { version?: number }).version;
  return typeof v !== 'number' || v < FLOW_VIEW_VERSION;
}

/**
 * 视图 → 一行可读摘要（dsh-ops "双消费"：JSON 之外再给 grep 友好的读法）。
 * 形如 `[flows 164 total · 50 kept · 114 dropped · floor 2026-11-01T…]`。
 */
export function renderFlowViewMarker(view: FlowTrackerView): string {
  const parts = [`flows ${view.totalEver} total`];
  if (view.dropped > 0) parts.push(`${view.dropped} dropped`, `${view.kept} kept`);
  if (view.floorStartedAt) parts.push(`floor ${view.floorStartedAt}`);
  return `[${parts.join(' · ')}]`;
}

/** 状态分布 + 失败率 + 平均时长（管理面板读数；纯算术）。 */
export function projectStatusDistribution(view: FlowTrackerView): {
  byStatus: Record<string, number>;
  failureRate: number;
  avgDurationMs: number;
} {
  const byStatus: Record<string, number> = {};
  let durSum = 0;
  let durCount = 0;
  for (const e of view.head) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (typeof e.durationMs === 'number') {
      durSum += e.durationMs;
      durCount += 1;
    }
  }
  const bad = (byStatus['FAILED'] ?? 0) + (byStatus['TIMEOUT'] ?? 0);
  const total = view.head.length;
  return {
    byStatus,
    failureRate: total > 0 ? bad / total : 0,
    avgDurationMs: durCount > 0 ? Math.round(durSum / durCount) : 0,
  };
}
