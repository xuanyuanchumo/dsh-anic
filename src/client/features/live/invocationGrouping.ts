/**
 * 实时调用分区的纯分组/时序逻辑（cycle-60 T3 拆分：renderInvocations.ts
 * 触 250 行纪律，把「算什么」与「怎么渲」分离——本文件零 React 依赖，
 * 可被渲染器与未来任何消费面复用）。
 */
import { t } from '../../i18n.ts';
import type { InvocationJson } from './renderInvocationsTypes.ts';

/**
 * cycle-20（P2）：turn/step 折叠分组。任一条目带 turn 元数据才启用分组；
 * 全部缺失（旧宿主/旧 feed）→ 返回 null 走原平铺——零回归面。
 *
 * 组间序：turn 降序（feed 最新在前，最新 turn 的组排头并默认展开，其余折叠
 * 收纳历史）；无 turn 标注的条目归「未分组」组殿后（不丢弃任何事实）。
 * 原生 details/summary：无 JS 状态、静态标记可渲染、键盘可达。
 */
export function groupByTurn(invocations: InvocationJson[]): Array<{ turn: number | null; items: InvocationJson[] }> | null {
  if (!invocations.some((inv) => typeof inv.turn === 'number')) return null;
  const buckets = new Map<number | null, InvocationJson[]>();
  for (const inv of invocations) {
    const key = typeof inv.turn === 'number' ? inv.turn : null;
    const arr = buckets.get(key);
    if (arr) arr.push(inv);
    else buckets.set(key, [inv]);
  }
  const turnKeys = [...buckets.keys()].filter((k): k is number => k !== null).sort((a, b) => b - a);
  const groups = turnKeys.map((k) => ({ turn: k as number | null, items: buckets.get(k) ?? [] }));
  const ungrouped = buckets.get(null);
  if (ungrouped) groups.push({ turn: null, items: ungrouped });
  return groups;
}

/**
 * cycle-41（用户目标 A）：最近一次**已完成**调用（done/error，endedAt 落定）
 * 所在的分组键。返回 undefined = 尚无已完成调用；null = 最近完成者未标注
 * turn（归「未分组」组）。
 */
export function mostRecentCompletedKey(invocations: InvocationJson[]): number | null | undefined {
  let bestAt = -1;
  let bestKey: number | null | undefined;
  for (const inv of invocations) {
    if (inv.status === 'in-flight') continue;
    const at = inv.endedAt ?? inv.startedAt;
    if (at > bestAt) {
      bestAt = at;
      bestKey = typeof inv.turn === 'number' ? inv.turn : null;
    }
  }
  return bestKey;
}

/**
 * cycle-60（T-6001 调用流时序）：组内时间范围——feed 的条目本身带绝对
 * 时间戳（startedAt/endedAt，epoch ms），但面板此前只显示「t3/s1」这类
 * 步进坐标，绝对时间语义（这组调用发生在几点、耗时多久）不可见。
 *
 * 计算用组内**首末 startedAt**（不含未落定的 endedAt——in-flight 的结束
 * 时间还没发生，用 startedAt 边界描述「这组从何时开始到何时开始」是诚实
 * 陈述；跨度 = 末条 startedAt − 首条 startedAt，描述组内节奏而非单条耗时）。
 * 时间格式：时:分:秒（面板场景分钟粒度足够，秒保调用密集时的区分度）。
 * 全组无合法时间戳 → 返回 null（渲染层跳过，零伪造）。
 *
 * 合法性门槛：startedAt > 0（epoch 0 = 1970-01-01 不是真实调用时刻——旧
 * feed/夹具用 0 值占位时显示 08:00:00 是本地时区巧合的伪造时序，宁可跳过）。
 */
export function turnTimeRange(items: InvocationJson[]): string | null {
  let min = -1;
  let max = -1;
  for (const inv of items) {
    if (typeof inv.startedAt !== 'number' || !Number.isFinite(inv.startedAt) || inv.startedAt <= 0) continue;
    if (min === -1 || inv.startedAt < min) min = inv.startedAt;
    if (inv.startedAt > max) max = inv.startedAt;
  }
  if (min === -1 || max === -1) return null;
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
  return t('live.turnTimeRange', { from: fmt(min), to: fmt(max), span: `${String(Math.round((max - min) / 1000))}s` });
}
