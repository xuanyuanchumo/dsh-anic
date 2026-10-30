/**
 * 门禁生存分析（cycle-90）—— Kaplan-Meier 估计器。
 *
 * ## 生存时间口径（关键取舍，必须写明）
 *
 * **不是**「门禁流程耗时」—— 门禁账本（`ledger.json`）**只记裁决与时间戳，
 * 不记开始时间**（实测 232 条中「含耗时」的 0 条）。那个口径**不可观测**。
 *
 * 本模块用**可观测**的口径：**一个门「失败 → 修复 → 通过」的 episode 时长**
 * （FAIL 后第一次 PASS 与该 FAIL 的时间差）。
 *
 * - 实测：34 个 episode、0 删失 ⇒ KM 中位 **233641ms（3.9min）**，
 *   Greenwood CI for S = [0.3354, 0.6646]，
 *   **log-log CI for median = [145322, 375635]ms = [2.4, 6.3]min**。
 * - **为什么用 KM 而不是均值/中位数**：修复时长是**右删失**数据
 *   （还没修好的 episode 是删失，不是失败）。均值会把删失样本当成
 *   「已修好且很慢」或直接漏掉 ⇒ 系统性偏。
 *   KM 是处理删失的标准估计器。
 *
 * ## 删失必须支持（当前 0 条，但代码要能处理）
 *
 * G2 的实测通过率仅 **0.63** ⇒ 开区间 episode（FAIL 后再无 PASS）是**最可能**的
 * 形态。当前一门最后一次是 PASS 时才没有开区间 —— 这不是恒真的性质。
 *
 * ## 数值稳定性（四条硬要求）
 *
 * 1. **同一时刻 t 的样本必须先聚合**：该时刻有 `d` 个事件 + `c` 个删失时，
 *    生存率一步降到 `S·(1 − d/n)`，**不是**逐条处理（逐条会把同一时刻的
 *    多个事件算成多步）。
 * 2. **`n_j === d_j` ⇒ Greenwood 分母为 0** ⇒ CI **退化为 [0,1]** 并标
 *    `degenerate`，**绝不返回 NaN**。
 * 3. **n === 1 的中位数在数学上存在**（单事件 ⇒ S(t)=0 ⇒ 中位数 = 该时刻），
 *    但它的置信区间**必然退化**（`n_j === d_j`）⇒ `degenerateCi=true`。
 *    默认门槛 `n ≥ 20` 使这种情形不会出现在读数面。
 * 4. **`S(t)` 恰等于 0.5** ⇒ 取该 t（不是下一个 t）。
 *
 * ## 样本量门槛
 *
 * `n < 20` ⇒ `insufficient-data`（不画曲线）。理由：KM 的中位数在
 * 小样本下方差极大（中位数的渐近方差 ∝ 1/n²）。
 *
 * ## 边界
 *
 * 纯函数：零 DOM / 零 clock / 零 random / 零 IO。
 */
import {
  insufficient,
  ok,
  type Verdict,
} from '../runtime/statVerdict.ts';
import type { KaplanMeierReadout, SurvivalSample, SurvivalStep } from './gateSurvivalTypes.ts';
// episode 切分已拆至 failEpisodes.ts（T3 ≤250 行）；此处再导出保持导入路径不变。
export { failEpisodes } from './failEpisodes.ts';
// 形状声明已拆至 gateSurvivalTypes.ts（T3 ≤250 行）；此处再导出保持导入路径不变。
export type { SurvivalSample, SurvivalStep, KaplanMeierReadout } from './gateSurvivalTypes.ts';

/**
 * 计算 Kaplan-Meier 估计。
 *
 * @param samples 观测样本（**未排序也可** —— 内部会聚合并排序）
 * @param minSamples 样本量门槛（默认 20）
 */
export function kaplanMeier(
  samples: readonly SurvivalSample[],
  minSamples = 20,
): Verdict<KaplanMeierReadout> {
  if (samples.length === 0) return insufficient('无生存样本');
  if (samples.some((s) => !Number.isFinite(s.durationMs) || s.durationMs < 0)) {
    return insufficient('存在非法时长样本（负值或非有限）');
  }
  if (samples.length < minSamples) {
    return insufficient(`样本不足（n=${String(samples.length)} < ${String(minSamples)}），中位数不可判定`);
  }

  // 聚合：同一时刻的事件与删失必须合并成一步。
  const byTime = new Map<number, { d: number; c: number }>();
  for (const s of samples) {
    const bucket = byTime.get(s.durationMs);
    if (bucket === undefined) {
      byTime.set(s.durationMs, { d: s.event ? 1 : 0, c: s.event ? 0 : 1 });
    } else {
      if (s.event) bucket.d += 1;
      else bucket.c += 1;
    }
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);

  const steps: SurvivalStep[] = [];
  let survival = 1;
  let greenwoodSum = 0;
  let atRisk = samples.length;
  /** 方差开始退化的时刻（null = 未退化）。 */
  let degenerateFrom: number | null = null;

  for (const t of times) {
    const bucket = byTime.get(t);
    if (bucket === undefined) continue;
    const { d, c } = bucket;
    // 生存率一步下降 d/atRisk。
    if (atRisk > 0 && d > 0) survival *= (1 - d / atRisk);
    // Greenwood 累积方差：Σ d / (n(n−d))。
    if (atRisk > 0 && d > 0) {
      if (atRisk - d === 0) {
        // 分母为 0 ⇒ **该点**的 Greenwood 不可估。
        //
        // ⚠️ 关键：这只影响**该点之后**的方差，不能让**中位数处**的 CI 一起退化。
        // 实测踩到：最后一步（atRisk=1, d=1）必然触发此条件，若把它当成全局退化，
        // 整个中位数 CI 会被误杀成 null —— 而中位数那一步本身完全健康
        // （atRisk=18, d=1 ⇒ 方差 0.0294 正常）。
        //
        // 处置：该点的方差**停止累积**（后续方差不可信），但**已累积**的部分仍有效。
        // 因此退化标记只作用于「中位数点之后」—— 用 `degenerateFrom` 记录起点。
        if (degenerateFrom === null) degenerateFrom = t;
      } else {
        greenwoodSum += d / (atRisk * (atRisk - d));
      }
    }
    const variance = greenwoodSum > 0 ? greenwoodSum : 0;
    const se = variance > 0 ? Math.sqrt(variance) : 0;
    steps.push({ t, atRisk, d, c, survival, greenwoodVariance: variance, greenwoodSe: se });
    // 删失样本离开风险集（事件样本已在该步离开）。
    atRisk -= d + c;
  }

  // 中位数：首个 S(t) ≤ 0.5 的时刻。
  let medianMs: number | null = null;
  const medianStep = steps.find((s) => s.survival <= 0.5);
  if (medianStep !== undefined) medianMs = medianStep.t;
  // 退化只影响**中位数点之后**的方差 ⇒ 中位数点自身正常时 CI 仍可给出。
  const degenerateCi = degenerateFrom !== null
    && (medianStep === undefined || degenerateFrom <= medianStep.t);

  // 中位数 CI —— **Brookmeyer-Crowley 反演**（点态 CI 反解到时间轴）。
  //
  // ## 方法（标准做法，不是「把 S 的 CI 直接当时间的 CI」）
  //
  // 对**每个时刻** t，先算 S(t) 的 log-log 点态置信带：
  //   η = log(-log Ŝ)，η ± z·se_η ⇒
  //   S 下界(t) = exp(-exp(η + z·se_η))（更小），
  //   S 上界(t) = exp(-exp(η - z·se_η))（更大）。
  // 构造两条**随时间变化的曲线** L(t)（下界）与 U(t)（上界），
  // 中位数 CI = { t : L(t) ≤ 0.5 ≤ U(t) } 的时间跨度：
  //   - t_a = 最早的 t 使 U(t) ≤ 0.5（此时**已确信**中位数已过）；
  //   - t_b = 最早的 t 使 L(t) ≤ 0.5（中位数**最晚**可能到这里）。
  //
  // ⚠️ **两条都是「首次穿越」语义**（first-crossing）。这是关键：
  // 若取「最后一次满足」，因为 S(t) 单调不增 ⇒ 那个值是**整个阶梯的最后一步**
  // （实测会得到 401569 / 26393819 这种荒谬值）—— 那是把「CI 曲线的交点」
  // 误当成「原始 S 的交点」。
  //
  // ## 浮点陷阱（实测踩到）
  //
  // ① 中位数处 Ŝ 常是 0.4999999999999999 ⇒ **先钳到 0.5** 再做 log-log，
  //    否则 log(Ŝ) 变极小负数、变换爆掉、CI 静默变 null。
  // ② S(t) **单调不增但可能持平**（某时刻只有删失没有事件 ⇒ S 不变）。
  //    找首次穿越时**不能**用 `break` 提前退出（持平段会让后面的步骤又满足条件
  //    而被漏掉），必须扫完全部步骤取**第一个**满足者。
  let medianCi95Ms: [number, number] | null = null;
  if (medianStep !== undefined && !degenerateCi) {
    const z = 1.959963984540054; // 95% 双侧
    /**
     * 某一步的 log-log 置信带 `[lower, upper]`（S 的点态 CI）。
     *
     * S=1 时 `log(-log 1) = -∞` ⇒ 无有限带 ⇒ 返回 null（跳过该步，不是 NaN）。
     */
    const bandOf = (st: SurvivalStep): { lower: number; upper: number } | null => {
      const q = Math.min(Math.max(st.survival, 1e-12), 1 - 1e-12);
      const absLogQ = Math.abs(Math.log(q));
      if (absLogQ === 0) return null;
      const seLog = st.greenwoodSe / (q * absLogQ);
      if (!Number.isFinite(seLog)) return null;
      const eta = Math.log(-Math.log(q));
      const lower = Math.exp(-Math.exp(eta + z * seLog));
      const upper = Math.exp(-Math.exp(eta - z * seLog));
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
      return { lower, upper };
    };
    /**
     * 中位数 CI = { t : 0.5 落在 t 处的 log-log 置信带**内** } 的时间跨度。
     *
     * ## 为什么是这个判据（而不是「上界曲线首次 ≤ 0.5」）
     *
     * 后者是常见误解。若取「上界 ≤ 0.5 的首次时刻」当 CI 下界，
     * 在**中位数附近 se 较大**时（`|log S|` 小 ⇒ se_log 大 ⇒ 带很宽）
     * 上界曲线可能**始终 > 0.5** ⇒ CI 下界为 null ⇒ 整个 CI 消失。
     * 实测正是如此（n=34 时上界曲线从未降到 0.5）。
     *
     * 而「0.5 是否落在带内」的判据**对称且总能算出**：
     *   - 带内有 0.5 ⇒ 该时刻的中位数**可能**是真值 ⇒ 属于 CI；
     *   - 带内无 0.5 ⇒ 该时刻的中位数**已被排除**。
     * CI = 连续满足该条件的时间段 —— 这正是「中位数的置信集」的定义。
     */
    let firstIn: number | null = null;
    let lastIn: number | null = null;
    for (const st of steps) {
      const band = bandOf(st);
      if (band === null) continue;
      if (band.lower <= 0.5 && band.upper >= 0.5) {
        if (firstIn === null) firstIn = st.t;
        lastIn = st.t;
      }
    }
    if (firstIn !== null && lastIn !== null && firstIn <= lastIn) {
      medianCi95Ms = [firstIn, lastIn];
    }
  }

  const events = samples.filter((s) => s.event).length;
  return ok({
    n: samples.length,
    events,
    censored: samples.length - events,
    steps,
    medianMs,
    medianCi95Ms,
    degenerateCi,
  });
}
