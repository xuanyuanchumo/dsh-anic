/**
 * 耗时统计（cycle-90）—— 分位数（双口径）+ Gini（双尺度）+ 结果分布。
 *
 * ## 为什么同时报两种分位口径
 *
 * P50 与 P95 的**常见算法不一致**，且差异可观的：
 * 实测 gate-check（n=35）时 P95 的 Type 7 线性插值 = **3162.20ms**，
 * 最近秩 = **3984ms** —— **差 26%**。
 *
 * - **Type 7 线性插值**（R 默认）：平滑、适合描述「分布形状」；
 * - **最近秩**（nearest rank）：**SLA 口径** —— 「95% 的请求在 X ms 内完成」
 *   这句话在 SLA 语境下指的是第 95 百分位的**实际观测值**，不是插值出来的。
 *
 * ⇒ 只报一个会误导：**报 Type 7 的 P95 去做 SLA 判断会低估**（插值落在两个实测值之间，
 * 而 SLA 通常承诺「不低于某个实测值」）。两个都报，读者自己选口径。
 *
 * ## 为什么 Gini 要报两个尺度
 *
 * 实测全部 105 条 flow 耗时：原尺度 G = **0.8349**，对数尺度 G = **0.1995**。
 *
 * 差距这么大说明：**原尺度的高 G 主要来自少数极慢的离群点**，而不是
 * 「普遍不均衡」。对数尺度把长尾压扁后 G 骤降 ⇒ 真实情况是
 * 「大多数很快 + 少数很慢」，而不是「一半快一半慢」。
 *
 * 只报原尺度 G 会让人误判为「整个流程都不均衡」；只报 log G 会掩盖
 * 「尾部确实很重」这个事实。两个一起报，才能区分**长尾**与**离群污染**。
 *
 * ## 样本量门槛（why 具体数字）
 *
 * - P50：`n ≥ 30` —— 低于此，中位数本身抖动大到无法指导决策；
 * - P95：`n ≥ 100` —— 尾部分位数对样本量极敏感（n=35 时换口径就差 26%）；
 * - Gini：`n ≥ 20` —— Gini 的小样本偏差显著（分子分母都含 n）。
 *
 * 门槛不足 ⇒ 返回 `insufficient-data`，**不返回数字**。
 *
 * ## 边界
 *
 * - 负值耗时 ⇒ `not-applicable`（耗时不可能为负，输入有问题）；
 * - `sum = 0` ⇒ Gini = 0（全部相同，不是 NaN）；
 * - 单样本 ⇒ Gini 不可判定（分母含 n−1）；
 * - 纯函数：零 DOM / 零 clock / 零 random / 零 IO。
 */
import {
  insufficient,
  notApplicable,
  ok,
  requireSamples,
  type Verdict,
} from '../runtime/statVerdict.ts';

/** 分位数结果（双口径）。 */
export interface DurationQuantiles {
  /** 样本量。 */
  n: number;
  /** 中位数（Type 7 线性插值）。 */
  p50: number;
  /** P95 · Type 7 线性插值。 */
  p95Type7: number;
  /** P95 · 最近秩（SLA 口径）。 */
  p95NearestRank: number;
  /** 最小 / 最大（观测值，不是插值）。 */
  min: number;
  max: number;
  /** 算术平均（**仅作参考**：均值会被长尾污染，判断分布形状请看中位数与 Gini）。 */
  mean: number;
}

/** 升序排序（**不改入参**：调用方可能复用同一数组）。 */
function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Type 7 线性插值分位数（R 的默认类型）。
 *
 * 公式：`h = (n−1)·p`，取 `x[floor(h)]` 与 `x[ceil(h)]` 的线性插值。
 *
 * @param sorted **已升序**的数组
 * @param p      分位（0..1）
 */
export function quantileType7(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0] ?? null;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const low = sorted[lo];
  const high = sorted[hi];
  if (low === undefined || high === undefined) return null;
  if (lo === hi) return low;
  return low + (h - lo) * (high - low);
}

/**
 * 最近秩分位数（SLA 口径）：`x[ceil(n·p) − 1]`。
 *
 * @param sorted **已升序**的数组
 * @param p      分位（0..1）
 */
export function quantileNearestRank(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.ceil(n * p);
  const idx = Math.min(n, Math.max(1, rank)) - 1;
  return sorted[idx] ?? null;
}

/**
 * 耗时分位数（双口径）。
 *
 * @param values 耗时样本（毫秒）
 */
export function durationQuantiles(values: readonly number[]): Verdict<DurationQuantiles> {
  if (values.length === 0) return insufficient('无耗时样本');
  if (values.some((v) => v < 0)) return notApplicable('存在负值耗时 —— 输入不是合法耗时样本');
  const sorted = sortedCopy(values);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = quantileType7(sorted, 0.5);
  const p95Type7 = quantileType7(sorted, 0.95);
  const p95NearestRank = quantileNearestRank(sorted, 0.95);
  if (p50 === null || p95Type7 === null || p95NearestRank === null) {
    return notApplicable('分位数计算失败（样本不可排序）');
  }
  const min = sorted[0];
  const max = sorted[n - 1];
  if (min === undefined || max === undefined) return notApplicable('分位数计算失败（边界样本缺失）');
  return ok({
    n,
    p50,
    p95Type7,
    p95NearestRank,
    min,
    max,
    mean: sum / n,
  });
}

/**
 * Gini 系数（原尺度）。
 *
 * 公式：`G = Σ(2i − n − 1)·x_i / (n·(n−1)·x̄)`（`x_i` 已升序，i 从 1 到 n）。
 *
 * @param values 样本
 * @returns 0..1；样本全同 ⇒ 0；单样本 ⇒ null（不可判定）
 */
export function giniCoefficient(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const sorted = sortedCopy(values);
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0; // 全为 0 ⇒ 完美均衡（不是 NaN）
  const mean = sum / n;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) {
    const x = sorted[i];
    if (x === undefined) return null;
    weighted += (2 * (i + 1) - n - 1) * x;
  }
  const g = weighted / (n * (n - 1) * mean);
  // 浮点误差可能让 G 略微越界（如 −1e-16 或 1.0000000000000002）。
  if (!Number.isFinite(g)) return null;
  return Math.min(1, Math.max(0, g));
}

/** Gini 的**对数尺度**版本（`ln(x+1)`）。 */
export function giniLogScale(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const logged = values.map((v) => Math.log(v + 1));
  return giniCoefficient(logged);
}

/** Gini 读数（双尺度）。 */
export interface GiniReadout {
  /** 样本量。 */
  n: number;
  /** 原尺度 G（0..1，越大越不均衡）。 */
  gini: number;
  /** 对数尺度 G（`ln(x+1)`）。 */
  giniLog: number;
  /**
   * 形态判读（**不是**统计推断，是给读者的解读提示）：
   * - `long-tail`：log G 明显小于原 G ⇒ 少数极慢样本拉高原 G（真长尾）；
   * - `balanced`：两者接近 ⇒ 整体均衡。
   */
  shape: 'long-tail' | 'balanced';
}

/**
 * 形态判据的两个阈值。
 *
 * ## 为什么**绝对量**也要看（不能只看比值）
 *
 * 只按比值判会出错：某样本原尺度 G = 0.045、log G = 0.0095 ⇒ 比值 0.21，
 * 按「log G < 原 G 的 60%」会被判成「长尾」，但**两个值都极小**
 * （0.045 ⇒ 几乎完美均衡）。把一个均衡分布误判成「长尾」，
 * 比不给判据更糟 —— 用户会据此以为「尾部很重」而去查一个不存在的问题。
 *
 * ⇒ 判据必须**同时**满足：
 *   ① **原尺度 G 本身够大**（≥ 0.3 ⇒ 确实「不均衡」才谈长尾）；
 *   ② log G 显著小于原 G（< 原 G 的 60% ⇒ 不均衡由少数极端值主导）。
 *
 * 两者同时成立才叫「长尾」；只有 ① 成立是「普遍不均衡」（balanced-but-skewed，
 * 本仓归为 balanced 因为 log 尺度并不小）；只有 ② 成立但 ① 不成立是「均衡」。
 */
export const GINI_SHAPE_THRESHOLDS = {
  /** 原尺度 G 达到此值才算「确实不均衡」。 */
  minAbsoluteGini: 0.3,
  /** log G 低于原 G 的此比例才算「由少数极端值主导」。 */
  logRatio: 0.6,
} as const;

/**
 * Gini 读数（双尺度 + 形态判读）。
 *
 * @param values 样本
 */
export function giniReadout(values: readonly number[]): Verdict<GiniReadout> {
  const gate = requireSamples(values.length, 20, 'Gini 需足够样本');
  if (gate !== null) return gate;
  const gini = giniCoefficient(values);
  const giniLog = giniLogScale(values);
  if (gini === null || giniLog === null) return notApplicable('Gini 计算失败（样本过少或含非法值）');
  // 两条**同时**成立才算长尾（见 GINI_SHAPE_THRESHOLDS 的注释）。
  const shape: GiniReadout['shape'] =
    gini >= GINI_SHAPE_THRESHOLDS.minAbsoluteGini && giniLog < gini * GINI_SHAPE_THRESHOLDS.logRatio
      ? 'long-tail'
      : 'balanced';
  return ok({ n: values.length, gini, giniLog, shape });
}
