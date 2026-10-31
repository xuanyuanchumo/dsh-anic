/**
 * 均值/标准差（cycle-96 · 从 `bandDetector.ts` 下沉，解 import 环）。
 *
 * ## 为什么必须单独成文件（不是"拆文件洁癖"）
 *
 * 本函数有两个消费者：`bandDetector`（WE 规则与控制带）与 `controlBand`（读数组装）。
 * 若它留在 `bandDetector.ts`，`controlBand` 就要 import 它 ⇒ `bandDetector ⇄ controlBand`
 * **真环**。`objectiveConformanceContract ⑪` 的 import 环守卫会当场红 ——
 * 本仓 cycle-93 已经因为「计数器放错层」踩过同一个坑（`disclosureActivation ↔ disclosureReadout`）。
 *
 * ⇒ 纯算术下沉为**零依赖叶子**，依赖图保持为树。这与 `toolsChangeCounter.ts` 的修法同款。
 *
 * ## 与技能同式的理由
 *
 * `band-detector.mjs:110-115` 用总体标准差（除以 N，不是 N−1）。宿主侧必须**逐字同式**，
 * 否则同一份历史在两处算出不同的 σ ⇒ 控制带边界分叉 ⇒ 「宿主说 warn、面板画成 normal」。
 * 样本标准差（N−1）在 n 较小时会明显偏大，正是这条最容易被"看起来更严谨"误改。
 */
export interface BandStats {
  mean: number;
  stdDev: number;
}

/**
 * 总体均值与总体标准差（**除以 N**，与技能实现逐字同式）。
 *
 * @param values 观测序列；空序列 → `{mean:0, stdDev:0}`（不抛、不猜）
 */
export function bandStats(values: number[]): BandStats {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}
