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
 * cycle-71 T-7131（用户要求核心）：最近一次已完成调用的**本体**。
 *
 * 与 mostRecentCompletedKey 同源排序规则（跳过 in-flight、取
 * `endedAt ?? startedAt` 的 max、`startedAt > 0` 门槛），但返回调用本体——
 * 「最近完成的那一次调用」需要一个单点落点渲染其全貌（身份/时序/入参/产出/
 * 裁决），而不是只定位它落在哪个 turn 组。
 *
 * 为什么单独实现而不复用 key 版：key 版必须保持既有语义逐字节不变
 * （return undefined 表示「无已完成调用」，turn 组展开判定依赖它）；本体版
 * 额外要求「时刻必须真实」（startedAt > 0），否则旧 feed 的 0 值占位会让
 * 「最近完成者」变成一条没有时刻的伪造记录，卡片会渲染出空时序。
 */
export function mostRecentCompleted(invocations: InvocationJson[]): InvocationJson | null {
  let best: InvocationJson | null = null;
  let bestAt = 0;
  for (const inv of invocations) {
    if (inv.status === 'in-flight') continue;
    // 与 turnTimeRange 同构的合法性门槛：epoch 0 / 负值 / 非有限不是真实调用时刻。
    if (typeof inv.startedAt !== 'number' || !Number.isFinite(inv.startedAt) || inv.startedAt <= 0) continue;
    const at = inv.endedAt ?? inv.startedAt;
    if (!Number.isFinite(at)) continue;
    if (best === null || at > bestAt) {
      best = inv;
      bestAt = at;
    }
  }
  return best;
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

/**
 * cycle-63（T-6301 组内调用密度）：组内条数 / 跨度分钟——「这组多快」。
 *
 * - 分母用 turnTimeRange 同源的 startedAt 边界（首末开始时刻），与时间范围
 *   的跨度陈述同源，两个数字互相可验算；
 * - 跨度 0（单条组或同毫秒组）→ null 不渲染：除零不是「无穷密」的诚实
 *   陈述，宁可跳过；
 * - 无合法时间戳（全部 ≤0/非有限）→ null（零伪造，与 turnTimeRange 门槛
 *   一致）；
 * - 数值精度：保留 1 位小数（面板场景足够区分度；「12.0 次/分钟」与
 *   「12.3 次/分钟」的工程差异无观察价值）。
 */
export function turnDensity(items: InvocationJson[]): string | null {
  let min = -1;
  let max = -1;
  let count = 0;
  for (const inv of items) {
    count += 1;
    if (typeof inv.startedAt !== 'number' || !Number.isFinite(inv.startedAt) || inv.startedAt <= 0) continue;
    if (min === -1 || inv.startedAt < min) min = inv.startedAt;
    if (inv.startedAt > max) max = inv.startedAt;
  }
  if (min === -1 || max === -1 || max <= min) return null;
  const perMinute = count / ((max - min) / 60000);
  return t('live.turnDensity', { rate: perMinute.toFixed(1) });
}

/**
 * cycle-63（T-6302 组完成时刻）：组内**全部**条目非 in-flight 且 endedAt
 * 落定时，取 max endedAt 渲染「完成于 HH:MM:SS」——产出落定的绝对时刻。
 *
 * 与 turnTimeRange 的语义区分（两键两文案，防混淆）：
 * - 时间范围「 · 」= startedAt 边界（组从何时开始到何时开始——组内节奏）；
 * - 完成时刻「完成于」= endedAt 语义（组产出全部落定的时刻——产出语义）。
 *
 * 诚实门槛：
 * - 组内含任一 in-flight → null（组还没完，渲染完成时刻是伪造——宁可等
 *   下一轮轮询它落定后再出现）；
 * - 部分条目 endedAt 缺失（旧 feed/异常形状）→ null（「部分完成」没有
 *   组级完成时刻——不拿部分 max 冒充全体落定）；
 * - 合法性门槛 endedAt > 0（epoch 0 占位非真实时刻——与 startedAt 门槛
 *   同构）。
 */
export function turnCompletedAt(items: InvocationJson[]): string | null {
  if (items.length === 0) return null;
  let max = -1;
  for (const inv of items) {
    if (inv.status === 'in-flight') return null;
    if (typeof inv.endedAt !== 'number' || !Number.isFinite(inv.endedAt) || inv.endedAt <= 0) return null;
    if (inv.endedAt > max) max = inv.endedAt;
  }
  const d = new Date(max);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return t('live.turnCompletedAt', { at: `${hh}:${mm}:${ss}` });
}

/**
 * cycle-64（T-6401 in-flight 时序脉动量化）：运行中调用的**已进行时长**。
 *
 * in-flight 行此前只有脉冲动画点与「进行中」文案——「这调用跑了多久」
 * 不可见；done/error 行有 durationMs，运行中行没有任何时长语义。用户
 * 目标「运行状态白盒透明化**量化**」在 in-flight 态缺一元。
 *
 * 时钟基准裁决：elapsed = generatedAt（feed 快照时刻）− startedAt，**不用
 * 客户端 Date.now()**——generatedAt 与 startedAt 同为宿主进程时钟（同源
 * 无偏斜）；客户端时钟与宿主时钟可能跨机偏移，用它算 elapsed 会把偏移
 * 伪装成耗时。脉动语义：每轮 2s 轮询的响应携带新鲜 generatedAt →
 * elapsed 随真实时间自然前进（调用跑 10s 面板会看到 2→4→6→8→10s）。
 *
 * 诚实门槛：
 * - 非 in-flight（done/error）→ null（durationMs 已有终态时长语义）；
 * - startedAt 非法（≤0/非有限）→ null（与 turnTimeRange 门槛同构）；
 * - generatedAtMs 非有限（旧宿主缺字段/不可解析形状）→ null；
 * - elapsed < 0（时钟异常：快照时刻早于开始时刻）→ null（不显示负数
 *   时长——宁可跳过不解释异常）。
 * 精度：整秒向下取整（0.6s 显示「已进行 0s」是保守诚实——不进位成 1s）。
 */
export function inFlightElapsedMs(inv: InvocationJson, generatedAtMs: number): number | null {
  if (inv.status !== 'in-flight') return null;
  if (typeof inv.startedAt !== 'number' || !Number.isFinite(inv.startedAt) || inv.startedAt <= 0) return null;
  if (!Number.isFinite(generatedAtMs)) return null;
  const elapsed = generatedAtMs - inv.startedAt;
  if (elapsed < 0) return null;
  return elapsed;
}

