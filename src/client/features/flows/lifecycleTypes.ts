/**
 * 生命周期指标的**客户端契约**（cycle-90）—— `GET /anic/api/flows/lifecycle` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级（响应字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import `src/host/runtime/lifecycleMetrics.ts`
 * 的类型，一次宿主字段改名就会让旧客户端整块崩掉（且打包时是类型擦除，
 * 编译期看不出来）。
 *
 * ⇒ 这里**手工声明可能缺字段**的形状，守卫只做最小准入。
 *
 * ## 三条诚实渲染纪律（写进类型与派生函数，不只写在文档里）
 *
 * 1. **取不到 ≠ 零**：模型不可判定时服务端给 `{ available:false, reason, detail }`
 *    —— 客户端**原样显示 detail**，绝不显示 0。
 * 2. **归属覆盖常驻**：孤儿比例必须与读数一起显示，否则读者会把「只统计了 3%」
 *    当成「统计了全部」。
 * 3. **截断徽标常驻**：`window.truncated === true` 时必须显示告警 ——
 *    「近期优于历史」在截断窗口下可能是假象。
 */

/** 模型读数在响应里的形态（成功给值，失败给**原因**）。 */
export interface MetricProjectionJson<T> {
  available?: boolean;
  value?: T;
  reason?: string;
  detail?: string;
}

/** 数据窗口诚实信息。 */
export interface LifecycleWindowJson {
  everWritten?: number;
  retained?: number;
  evicted?: number;
  truncated?: boolean;
  windowSpanMs?: number | null;
  truncationWarning?: string | null;
}

/** 归属覆盖。 */
export interface LifecycleAttributionJson {
  attributed?: number;
  orphans?: number;
  /** 0..1。 */
  coverage?: number;
  note?: string;
}

/** EWMA 读数（门禁通过率控制图）。 */
export interface LifecycleEwmaJson {
  n?: number;
  pHat?: number;
  centerLine?: number;
  series?: number[];
  limits?: Array<{ i?: number; ucl?: number; lcl?: number; halfWidth?: number }>;
  violations?: number[];
  lastOutOfControlIndex?: number;
  degenerate?: boolean;
}

/** KM 读数（门禁修复时间生存分析）。 */
export interface LifecycleSurvivalJson {
  n?: number;
  events?: number;
  censored?: number;
  medianMs?: number | null;
  medianCi95Ms?: [number, number] | null;
  degenerateCi?: boolean;
}

/** 耗时分位数（双口径）。 */
export interface LifecycleDurationJson {
  n?: number;
  p50?: number;
  p95Type7?: number;
  p95NearestRank?: number;
  min?: number;
  max?: number;
  mean?: number;
}

/** Gini 读数（双尺度）。 */
export interface LifecycleGiniJson {
  n?: number;
  gini?: number;
  giniLog?: number;
  shape?: 'long-tail' | 'balanced';
}

/** `GET /anic/api/flows/lifecycle` 的响应。 */
export interface LifecycleMetricsJson {
  window?: LifecycleWindowJson;
  attribution?: LifecycleAttributionJson;
  gatePassRate?: MetricProjectionJson<LifecycleEwmaJson>;
  gateRepairTime?: MetricProjectionJson<LifecycleSurvivalJson>;
  duration?: MetricProjectionJson<LifecycleDurationJson>;
  inequality?: MetricProjectionJson<LifecycleGiniJson>;
}

/** 生命周期指标端点。 */
export const LIFECYCLE_METRICS_URL = '/anic/api/flows/lifecycle';

/** 对象形守卫（独立实现，避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「能取到 window 或 attribution」。
 *
 * 刻意**不**校验全部字段 —— 任何新增/缺失字段都不该让整块面板走失败行
 * （与 `flowMatrixTypes.isFlowMatrix` 同款最宽守卫）。
 */
export function isLifecycleMetrics(v: unknown): v is LifecycleMetricsJson {
  if (!isObj(v)) return false;
  return isObj(v['window']) || isObj(v['attribution']);
}

/** 读数是否可用（`available === true` 且有 value）。 */
export function isAvailable(p: MetricProjectionJson<unknown> | undefined): p is { available: true; value: unknown } {
  return p?.available === true && p.value !== undefined;
}

/** 不可判定时的**可显示原因**（缺字段 → 兜底文案，不显示 undefined）。 */
export function unavailableReason(p: MetricProjectionJson<unknown> | undefined): string | null {
  if (!p || p.available === true) return null;
  if (typeof p.detail === 'string' && p.detail !== '') return p.detail;
  if (typeof p.reason === 'string' && p.reason !== '') return p.reason;
  return null;
}

/** 毫秒 → 人类可读（分钟 / 小时两档）。 */
export function humanizeMs(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)}min`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * run 级 3σ 规则的**灵敏度提示**（实测：需连续 ~30 次失败才触发）。
 *
 * ## ⚠️ 为什么 run 级口径下 3σ 控制限几乎无意义（**实测结论，不是推测**）
 *
 * run 级 n_i = 1 ⇒ `σ_p = √(p̄(1−p̄))`（实测 p̄=0.7658 ⇒ **0.4235**）。
 * 于是 3σ 控制限的半宽 = 3×0.4235 = **1.27** —— 比「中心线到 1.0 的距离」还大：
 *
 * ```
 * LCL = p̄ − 3σ_p = 0.7658 − 1.2706 = **−0.5048**   ⇒ ≤ 0 ⇒ 比例不可能低于它
 * ```
 *
 * ⇒ **3σ 规则在 run 级口径下几乎永不触发**（实测 30 连败也不报，
 * 而连续 30 次失败是极其严重的信号）。这不是 bug，是**伯努利比例控制图的
 * 固有灵敏度代价**：n_i=1 时样本比例的抽样方差极大。
 *
 * ## 那「灵敏度」该怎么表达
 *
 * 与其报一个「永远不触发的判据」，不如报**这个判据实际有多钝**：
 * 连续 k 次失败后，EWMA 距中心线多少个 σ。
 *
 * 推导：连续 k 次失败 ⇒ `Z_k = p̄·(1−λ)^k`（每次观测 p_i=0）。
 * 距中心线 `= (p̄ − Z_k) / σ_p` 个 σ。
 *
 * 实测（p̄=0.7658、λ=0.2）：
 * | 连续失败 | Z | 距中心线 |
 * |---|---|---|
 * | 5 | 0.251 | 1.22 σ |
 * | 10 | 0.082 | 1.61 σ |
 * | 20 | 0.009 | 1.79 σ |
 * | 30 | 0.001 | 1.81 σ |
 *
 * ⇒ **1.8σ 就是这个口径的「地板」**（Z 指数衰减到 0 后不再下降）。
 * 换句话说：run 级 3σ 口径下，**任何**连续失败次数都到不了 3σ。
 *
 * ## 因此本函数报的是「触不到 3σ」这个事实
 *
 * @param pHat 中心线（通过率）
 * @returns 需要的连续失败次数；若 **3σ 口径根本触不到** → 返回 null
 *   （调用方据此显示「该判据在本口径下不适用」而不是编一个假数字）
 */
export function failureSensitivity(pHat: number | null | undefined): number | null {
  if (typeof pHat !== 'number' || !Number.isFinite(pHat) || pHat <= 0 || pHat >= 1) return null;
  const lambda = 0.2;
  const sigmaP = Math.sqrt(pHat * (1 - pHat));
  const lcl = pHat - 3 * sigmaP;
  // LCL ≤ 0 ⇒ 比例下界已无意义 ⇒ 3σ 判据**在本口径下触不到**。
  if (lcl <= 0) return null;
  const ratio = lcl / pHat;
  if (ratio <= 0) return 1;
  const k = Math.log(ratio) / Math.log(1 - lambda);
  return Number.isFinite(k) ? Math.ceil(k) : null;
}

/**
 * EWMA 距中心线的**σ 数地板**（连续失败再多也到不了这个数）。
 *
 * 连续 k 次失败后 `Z_k = p̄(1−λ)^k → 0`，故
 * `距中心线 → p̄/σ_p = √(p̄/(1−p̄))` 个 σ（**与 k 无关**）。
 *
 * 实测 p̄=0.7658 ⇒ 地板 ≈ 1.81σ ⇒ 3σ 判据**永远到不了**。
 *
 * @param pHat 中心线（通过率）
 */
export function ewmaSigmaFloor(pHat: number | null | undefined): number | null {
  if (typeof pHat !== 'number' || !Number.isFinite(pHat) || pHat <= 0 || pHat >= 1) return null;
  const sigmaP = Math.sqrt(pHat * (1 - pHat));
  return pHat / sigmaP;
}
