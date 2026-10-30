/**
 * Kaplan-Meier 的**形状声明**（cycle-90 · 从 `gateSurvival.ts` 拆出，守 T3 ≤250 行）。
 *
 * 拆出的理由（职责，不是行数）：`gateSurvival.ts` 讲的是**估计器**（怎么算），
 * 本文件讲的是**数据形状**（算出来是什么）。混在一起时，改一个字段名要翻算法实现，
 * 而调算法参数时又会被形状定义打断。
 *
 * 纯类型：零运行时开销。
 */
/** 单个观测（事件或删失）。 */
export interface SurvivalSample {
  /** 时长（毫秒）；必须 ≥ 0。 */
  durationMs: number;
  /** true = 事件发生（已修复/已通过）；false = 右删失（尚未发生）。 */
  event: boolean;
}

/** 生存阶梯的一步。 */
export interface SurvivalStep {
  /** 该步的时刻（毫秒）。 */
  t: number;
  /** 该步之前尚在险（at risk）的样本数。 */
  atRisk: number;
  /** 该时刻发生的事件数。 */
  d: number;
  /** 该时刻被删失的样本数。 */
  c: number;
  /** 该步之后的生存率 S(t)。 */
  survival: number;
  /**
   * Greenwood **方差**（该步之后的累积值 `Σ d/(n(n−d))`）。
   *
   * 为什么单独给方差而不只给标准误：KM 文献里「Greenwood」通常指这个**方差**，
   * 而置信区间需要的是**标准误**（= √方差）。两个都给，避免读者自己开方
   * 也能对上文献数值（实测：手算向量 0.083333 / 0.25 即方差）。
   */
  greenwoodVariance: number;
  /** Greenwood 标准误（= √方差；方差为 0 时为 0，不是 NaN）。 */
  greenwoodSe: number;
}

/** KM 读数。 */
export interface KaplanMeierReadout {
  /** 样本量（含删失）。 */
  n: number;
  /** 事件数（真正发生的）。 */
  events: number;
  /** 删失数。 */
  censored: number;
  /** 生存阶梯（按时刻升序）。 */
  steps: SurvivalStep[];
  /** 中位生存时间（毫秒）；未达到 0.5 ⇒ null。 */
  medianMs: number | null;
  /** 中位数的 log-log 95% 置信区间（毫秒）；不可判定 ⇒ null。 */
  medianCi95Ms: [number, number] | null;
  /** 中位 CI 是否退化（`n_j === d_j` 造成 Greenwood 分母 0）。 */
  degenerateCi: boolean;
}

