/**
 * 控制带读数（cycle-96 · 从 `bandDetector.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么这一项此前是「有消费、无生产」的结构性缺口
 *
 * 客户端 `gateColors.ts` 的 `renderControlBand` 早已写好（吃 `ControlBand`：
 * mean / sigma2 / sigma3 / value / label），`bandStats` 也算得出均值与标准差 ——
 * 但 `BandResult` **从来没把两者合起来暴露**。
 * ⇒ 渲染器在等数据，数据在等出口，两边各自完备、中间断开。
 *
 * 这是本仓闭环体检「注册↔生产↔消费」三态矩阵要抓的形态；矩阵此前只看
 * **资产级**有无，看不到"两个已有资产之间的接线缺口"。
 *
 * ## 判定必须与客户端**同式**
 *
 * 客户端 `bandStatus`：`|value − mean| > nσ` ⇒ **对称**边界。
 * 本模块只算边界并**同时算一次判定**带进返回值 —— 让渲染层不重算。
 * 若两边各写一套（例如这边写成单向上界），就会出现「宿主说 warn、面板画成 alarm」，
 * 那是本仓最贵的一类债（两套真相）。
 *
 * ## sampleSize < 2 时控制带**不成立**
 *
 * 1 个点的 σ 恒为 0 ⇒ `|value − mean| = 0` ⇒ 永远 normal。那是个**假绿**：
 * 它把"还没有历史"读成"过程非常稳定"。所以 `sampleSize` 如实上报，
 * 由渲染层决定显示「样本不足」而不是一个看起来很好的读数。
 */
import { bandStats } from './bandStats.ts';

/** 控制带读数（与客户端 `ControlBand` 同名同义，但带**判定结果**）。 */
export interface ControlBandReadout {
  /** 历史均值（μ）。 */
  mean: number;
  /** 标准差（σ）；0 = 近常数过程（WE 规则短路，与技能同款）。 */
  stdDev: number;
  /** 上 2σ 边界（μ + 2σ）。 */
  sigma2: number;
  /** 上 3σ 边界（μ + 3σ）。 */
  sigma3: number;
  /** 当前观测值。 */
  value: number;
  /** 人读标签。 */
  label: string;
  /** 判定：`normal`（±2σ 内）/ `warn`（±3σ 内）/ `alarm`（超 3σ）。 */
  status: 'normal' | 'warn' | 'alarm';
  /** 参与统计的点数；0/1 时控制带**不成立**，须如实上报而非算个好看的数。 */
  sampleSize: number;
}

/**
 * 由历史分数序列与当前值算出控制带读数（**纯函数**，零 IO）。
 *
 * @param scores 历史序列（含或不含当前值均可 —— 统计口径由调用方决定）
 * @param value 当前观测值
 */
export function controlBandOf(scores: number[], value: number): ControlBandReadout {
  const { mean, stdDev } = bandStats(scores);
  const sigma2 = mean + 2 * stdDev;
  const sigma3 = mean + 3 * stdDev;
  const dev = Math.abs(value - mean);
  // 与客户端 bandStatus 同式（对称判定）；stdDev=0 时 dev 必为 0 ⇒ normal
  //（诚实：近常数过程确实没有偏离，不是"没检查"）。
  const status = dev > 3 * stdDev ? 'alarm' : dev > 2 * stdDev ? 'warn' : 'normal';
  return {
    mean, stdDev, sigma2, sigma3, value,
    label: '代码质量带',
    status,
    sampleSize: scores.length,
  };
}

/** 样本是否足够算出控制带（< 2 个点时 σ 恒 0，判据不成立）。 */
export function controlBandTrustworthy(band: ControlBandReadout): boolean {
  return band.sampleSize >= 2;
}
