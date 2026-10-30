/**
 * flow-tracker 的**查询与统计**（cycle-91 拆分 · 守 T3 ≤250 行）。
 *
 * ## 为什么拆出去
 *
 * 「**写**（追踪一条流程的生命周期）」与「**读**（查历史 / 统计成功率）」
 * 是两种节奏：写侧每轮都在改（状态机推进、字段扩展），读侧的形状由
 * 面板与 API 契约钉住、很少变。
 *
 * 混在一起时，改读侧（比如加一种统计口径）要在一堆状态推进代码里翻找。
 *
 * ## 边界
 *
 * 纯函数、零 IO：输入状态，输出读数。
 */
import type { FlowRecord, FlowTrackerState } from './flowTrackerTypes.ts';

/** 查询最近 N 条流程记录（默认 20）。 */
export function recentFlows(state: FlowTrackerState, limit = 20): FlowRecord[] {
  return state.flows.slice(-limit).reverse();
}

/** 查询活跃流程（INVOKING 或 RUNNING——已受理未终结的全部）。 */
export function activeFlows(state: FlowTrackerState): FlowRecord[] {
  return state.flows.filter((f) => f.status === 'INVOKING' || f.status === 'RUNNING');
}

/** 统计：按脚本分组计数 + 成功率。 */
export function flowStats(state: FlowTrackerState): Record<string, { total: number; done: number; failed: number; timeout: number }> {
  const stats: Record<string, { total: number; done: number; failed: number; timeout: number }> = {};
  for (const f of state.flows) {
    let s = stats[f.script];
    if (!s) { s = { total: 0, done: 0, failed: 0, timeout: 0 }; stats[f.script] = s; }
    s.total++;
    if (f.status === 'DONE') s.done++;
    else if (f.status === 'FAILED') s.failed++;
    else if (f.status === 'TIMEOUT') s.timeout++;
  }
  return stats;
}
