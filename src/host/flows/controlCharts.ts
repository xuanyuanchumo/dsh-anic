/**
 * run 级 EWMA 控制图（cycle-90）—— 门禁通过率的漂移检测。
 *
 * ## 为什么是 EWMA 而不是 p-chart
 *
 * p-chart 检测**大幅**跳变；EWMA 对**缓慢漂移**敏感（它给每个观测一个
 * 指数递减的权重）。门禁通过率的典型退化是「今天 80%，一周后 60%」——
 * 这种漂移 p-chart 要积累很多点才报警，EWMA 早得多。
 *
 * ## 为什么是 **run 级**（n_i = 1）
 *
 * 对象是「**每一次跑门禁这件事**」：每个 run 一个伯努利观测（PASS=1 / FAIL=0）。
 * 条目加权（给一次批量跑里的多条账本各算一份）会**掩盖连续失败** ——
 * 一次批量跑 20 条里 18 条 PASS，条目加权得 0.9，run 级只算 1 个观测。
 * 后者才是控制图要的粒度。
 *
 * ⇒ `n_i = 1` ⇒ `σ_p = √(p̄(1−p̄))` **恒定**，控制限随 i 收敛
 * （EWMA 的标准形态）。实测基线：111 runs / 85 全 PASS / p̂ = **0.7658**。
 *
 * ## ⚠️ 初始化约定（实测踩到的坑）
 *
 * EWMA 的初值必须是**中心线 p̄**，不是 0。`Z_0 = 0` 会让前几个点被
 * 「从 0 爬上来」的假趋势污染 —— 实测同一组数据：
 * `Z_0 = p̄` ⇒ 0.873333/0.838667/0.870933（研究基线）；
 * `Z_0 = 0`  ⇒ 0.180000/0.284000/0.427200（完全不同的数）。
 * ⇒ 读数里 `centerLine` 与 `pHat` 同值，且 `series[0]` 必然**接近** p̄。
 *
 * ## 为什么**不能**复用 band-detector 的 Western Electric 规则 4–8
 *
 * 本仓 `band-detector` 的规则 4（连续 8 点在中心线同侧）、规则 8（8 点在 1σ 外）等
 * 作用在**连续值**序列上。对 0/1 **二项**序列，它们**必然假阳性**：
 * p̄=0.77 时「连续 8 点同侧」是**正常二项涨落**（8 次同侧的概率约 2×0.77⁸×0.5
 * ≈ 11% —— 每 9 个 run 就出现一次）。用连续值的规则判二项序列，等于把噪声当信号。
 *
 * ⇒ **只用规则 1**（1 点超出 3σ 控制限）。规则 1/2/3 的判据形态可复用，
 * 但**必须用二项变序控制限重算 σ**。
 *
 * ## 数值稳定性（四条）
 *
 * 1. `p̄ ∈ {0, 1}` ⇒ `σ_p = 0` ⇒ 控制限退化 ⇒ **标 `degenerate`**，
 *    **不返回 NaN**（控制图在「全通过」或「全失败」时确实无判别力）。
 * 2. `UCL > 1` ⇒ **clamp 到 1**（比例不可能超过 1）；`LCL < 0` ⇒ clamp 到 0。
 * 3. **变序控制限**：`σ_p(i) = √(p̄(1−p̄)/n_i)`（`n_i` 可变）—— 用固定 σ 是错的。
 * 4. `λ = 0.2` 时控制限半宽在 `i ≥ 21` 饱和 ⇒ **样本不足 25 个子组时不启动**。
 *
 * ## 明确不实现的模型（附实测否决理由）
 *
 * - **马尔可夫概率估计**：guard 使转移依赖外部裁决数据 ⇒ 违反马尔可夫性；
 *   且 gate-check 投影只有 4 条事件（每单元 n=1）、history 明显不完整。
 *   降级方案只能是 **Tarjan SCC 纯结构分析**（不估概率）。
 * - **互信息点估计**：MLE 0.0464 nats，但 **Miller-Madow 校正量占 32%**
 *   ⇒ 几乎全是噪声；且 G0/G3 的 FAIL 期望频数 4.1/4.7 < 5 ⇒
 *   **χ² 近似不合法**，必须改用 Fisher 精确检验（未做）。
 * - **门禁「耗时」KM**：账本**无开始时间**（详见 `gateSurvival.ts` 文件头）。
 * - **PageRank / 中心性做瓶颈**：4 节点 DAG 退化为拓扑序，无信息量。
 * - **序列模式挖掘**：14 条轨迹只挖出平凡项集。
 * - **耗时预测 / AUC 作告警**：AUC 全局 0.5755、最小可检出效应 d≈0.96
 *   ≫ 实际效应 ⇒ 只能作**负结果**，不能作告警。
 * - **H1–H4 的任何统计**：账本中 H 门 **0 条**（不存在）。
 *
 * ## 边界
 *
 * 纯函数：零 DOM / 零 clock / 零 random / 零 IO。
 */
import {
  insufficient,
  notApplicable,
  ok,
  type Verdict,
} from '../runtime/statVerdict.ts';
import {
  EWMA_LAMBDA,
  EWMA_LIMIT_K,
  EWMA_MIN_SUBGROUPS,
  RUN_CLUSTER_GAP_MS,
  type EwmaLimit,
  type EwmaOptions,
  type EwmaReadout,
  type EwmaSubgroup,
  type RunObservation,
} from './ewmaTypes.ts';
// 形状声明已拆至 ewmaTypes.ts（T3 ≤250 行）；此处再导出保持导入路径不变。
export type { RunObservation, EwmaSubgroup, EwmaOptions, EwmaLimit, EwmaReadout } from './ewmaTypes.ts';
// 缺省常量也再导出一次：消费面只 import 本文件即可，不必知道形状声明在哪。
export { EWMA_LAMBDA, EWMA_LIMIT_K, EWMA_MIN_SUBGROUPS, RUN_CLUSTER_GAP_MS } from './ewmaTypes.ts';

/**
 * 把账本条目聚成 run（相邻间隔 ≤ `gapMs` 的条目算同一次跑）。
 *
 * ## 为什么需要聚类（启发式，**必须在面板标注**）
 *
 * 账本是**逐条追加**的：一次 `gate-check --gate all` 会连写 G0/G1/G2/G3 四条。
 * 若不聚类，这四条会被算成「4 次独立观测」⇒ 通过率被**高估**
 * （同一轮的 3 个 PASS + 1 个 FAIL 变成 4 个观测里的 3 个 PASS）。
 *
 * 判据用**时间间隔**（gap ≤ 5s 视为同一次跑）—— 因为同一次跑的四条账本
 * 是**连续写入**的，间隔在毫秒级；而两次独立的跑之间至少隔一个人工/调度间隔。
 *
 * ⚠️ 这是**启发式**，不是真值：`gapMs` 取值不同会得到不同的 run 边界。
 * 面板必须显示「run 边界按 Ns 间隔划分」—— 让读者知道这个口径。
 */
export function clusterRuns(
  entries: ReadonlyArray<{ timestamp?: string; result?: string }>,
  gapMs = RUN_CLUSTER_GAP_MS,
): RunObservation[] {
  const timed = entries
    .map((e) => ({ t: typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN, result: e.result ?? '' }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const runs: RunObservation[] = [];
  let current: { passed: boolean; entries: number } | null = null;
  let lastT = Number.NEGATIVE_INFINITY;
  for (const item of timed) {
    if (current === null || item.t - lastT > gapMs) {
      if (current !== null) runs.push(current);
      current = { passed: item.result === 'PASS', entries: 1 };
    } else {
      current.entries += 1;
      // 一个 run 内只要有一条非 PASS，整个 run 就算 FAIL（保守方向）。
      if (item.result !== 'PASS') current.passed = false;
    }
    lastT = item.t;
  }
  if (current !== null) runs.push(current);
  return runs;
}

/**
 * EWMA 核心（通用子组入口）。
 *
 * ```
 * Z_i    = λ·p_i + (1−λ)·Z_{i−1}        （Z_0 = p̄，**不是 0**）
 * 半宽_i = L·σ_p·√( λ/(1−λ)·(1 − (1−λ)^{2i}) )
 * σ_p    = √( p̄(1−p̄) / n_i )            （变序）
 * ```
 */
export function ewmaFromSubgroups(
  subgroups: readonly EwmaSubgroup[],
  options: EwmaOptions = {},
): Verdict<EwmaReadout> {
  const lambda = options.lambda ?? EWMA_LAMBDA;
  const L = options.L ?? EWMA_LIMIT_K;
  const minSubgroups = options.minSubgroups ?? EWMA_MIN_SUBGROUPS;
  const n = subgroups.length;
  if (n === 0) return insufficient('无观测');
  if (n < minSubgroups) {
    return insufficient(`子组不足（n=${String(n)} < ${String(minSubgroups)}），EWMA 未启动`);
  }
  if (lambda <= 0 || lambda > 1) return notApplicable(`lambda 必须在 (0,1]，收到 ${String(lambda)}`);
  if (L <= 0) return notApplicable(`L 必须为正，收到 ${String(L)}`);
  if (subgroups.some((s) => !(s.n >= 1) || !(s.p >= 0 && s.p <= 1) || !Number.isFinite(s.p))) {
    return notApplicable('子组形态非法（n 须 ≥1，p 须在 0..1）');
  }

  // p̄：按子组大小池化。run 级用法下每个子组 n_i = 1 ⇒ p̄ = run 通过率。
  let totalN = 0;
  let totalP = 0;
  for (const s of subgroups) {
    totalN += s.n;
    totalP += s.p * s.n;
  }
  const pHat = totalP / totalN;
  // p̄ ∈ {0,1} ⇒ σ_p = 0 ⇒ 控制图退化（无判别力）。
  const degenerate = pHat <= 0 || pHat >= 1;

  const series: number[] = [];
  const limits: EwmaLimit[] = [];
  const violations: number[] = [];
  // ⚠️ 初值 = p̄（中心线），**不是 0**（见文件头「初始化约定」）。
  let z = pHat;
  for (let i = 1; i <= n; i += 1) {
    const sg = subgroups[i - 1];
    if (sg === undefined) break;
    z = lambda * sg.p + (1 - lambda) * z;
    series.push(z);
    // 变序 σ_p：按该子组自己的 n_i 重算。
    const sigma = Math.sqrt((pHat * (1 - pHat)) / sg.n);
    // 半宽：随 i 收敛的因子（i=1 时因子最小，n 越大越张开）。
    const factor = Math.sqrt((lambda / (1 - lambda)) * (1 - Math.pow(1 - lambda, 2 * i)));
    const halfWidth = L * sigma * factor;
    const uclRaw = pHat + halfWidth;
    const lclRaw = pHat - halfWidth;
    // 比例不可能越界 ⇒ clamp（**不产生 NaN**）。
    const ucl = Math.min(1, uclRaw);
    const lcl = Math.max(0, lclRaw);
    limits.push({ i, ucl, lcl, halfWidth });
    // WE 规则 1：1 点超出 3σ 控制限（用**未 clamp** 的原始限判越界，
    // 否则 clamp 后永远「不越界」⇒ 规则失效）。
    if (z > uclRaw || z < lclRaw) violations.push(i - 1);
  }

  const lastOutOfControlIndex = violations.length > 0
    ? (violations[violations.length - 1] as number)
    : -1;

  return ok({
    n,
    pHat,
    centerLine: pHat,
    series,
    limits,
    violations,
    lastOutOfControlIndex,
    degenerate,
  });
}

/** run 观测 → 子组：**每个 run 一个伯努利观测**（n_i = 1，p_i ∈ {0,1}）。 */
export function runsToSubgroups(runs: readonly RunObservation[]): EwmaSubgroup[] {
  return runs.map((r) => ({ n: 1, p: r.passed ? 1 : 0 }));
}

/**
 * run 级 EWMA 控制图（**主入口**，n_i = 1）。
 *
 * @param observations run 级伯努利观测（`clusterRuns` 的输出）
 * @param options      参数（λ / L / 最小子组数）
 */
export function ewmaControlChart(
  observations: readonly RunObservation[],
  options: EwmaOptions = {},
): Verdict<EwmaReadout> {
  return ewmaFromSubgroups(runsToSubgroups(observations), options);
}

/**
 * 一站式：账本条目 → run 级 EWMA 读数（聚类 + 控制图一步到位）。
 */
export function ewmaFromLedger(
  entries: ReadonlyArray<{ timestamp?: string; result?: string }>,
  options: EwmaOptions = {},
): Verdict<EwmaReadout> {
  return ewmaControlChart(clusterRuns(entries), options);
}
