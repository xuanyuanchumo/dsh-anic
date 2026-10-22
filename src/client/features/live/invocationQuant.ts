/**
 * 调用流**量化**纯函数（cycle-71 T-7131 用户要求「运行状态……白盒透明化量化」）。
 *
 * 从 invocationGrouping.ts 拆出（该文件触 250 行模块纪律）：分组/时序 vs
 * 分位数/直方图是两族不同的量——「算什么（组）」与「多快/错在哪（分布）」。
 *
 * 面板此前只有单条的 durationMs——「这批调用整体多快、长尾多长、错误集中在
 * 哪个码」不可见。四个函数共用一条**样本门槛**：只取 status !== 'in-flight'
 * 且 durationMs 为合法正数的条目（运行中调用的时长是「已进行」量纲，
 * 与终态耗时混在一起算分位数是把两种量纲掺进同一个数字——宁可样本少）。
 *
 * 分位数算法：最近秩法（nearest-rank，向上取整）——样本量小（面板场景通常
 * 个位数）时不做插值，返回的**必定是某个真实样本值**，可回溯核对，不发明
 * 一个谁都没测到过的中间值。
 */
import type { InvocationJson } from './renderInvocationsTypes.ts';

/** 终态且时长合法的样本（升序）。 */
function durationsOf(invocations: InvocationJson[]): number[] {
  const out: number[] = [];
  for (const inv of invocations) {
    if (inv.status === 'in-flight') continue;
    if (typeof inv.durationMs !== 'number' || !Number.isFinite(inv.durationMs) || inv.durationMs <= 0) continue;
    out.push(inv.durationMs);
  }
  return out.sort((a, b) => a - b);
}

/** 最近秩分位（q ∈ (0,1]）；空样本 → null（不伪造 0ms）。 */
function nearestRank(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/** 中位耗时（最近秩，真实样本值）；空样本 → null。 */
export function p50Of(invocations: InvocationJson[]): number | null {
  return nearestRank(durationsOf(invocations), 0.5);
}

/** P95 耗时（长尾量化）；空样本 → null。 */
export function p95Of(invocations: InvocationJson[]): number | null {
  return nearestRank(durationsOf(invocations), 0.95);
}

/** 最大耗时；空样本 → null。 */
export function maxOf(invocations: InvocationJson[]): number | null {
  const sorted = durationsOf(invocations);
  return sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null);
}

/**
 * 错误码直方图（code → 次数，按次数降序、同次数按码字典序——快照式排序，
 * 渲染层零重排）。只统计 error 条目且 `error.code` 非空字符串者；无错误 → []。
 */
export function errorCodeHistogram(invocations: InvocationJson[]): Array<{ code: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const inv of invocations) {
    if (inv.status !== 'error') continue;
    const code = inv.error?.code;
    if (typeof code !== 'string' || code === '') continue;
    buckets.set(code, (buckets.get(code) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (b.count - a.count) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
