/**
 * EWMA 控制图的**形状声明**（cycle-90 · 从 `controlCharts.ts` 拆出，守 T3 ≤250 行）。
 *
 * 拆出的理由（职责，不是行数）：`controlCharts.ts` 讲的是**算法**
 * （怎么聚 run、怎么算控制限），本文件讲的是**数据形状**（算出来是什么）。
 *
 * 纯类型：零运行时开销。
 */
/** 一个 run 的观测（PASS 或 FAIL）。 */
export interface RunObservation {
  /** 该 run 是否全 PASS。 */
  passed: boolean;
  /** 该 run 内包含的账本条目数（仅作展示，不参与控制限计算）。 */
  entries?: number;
}

/**
 * 一个子组（EWMA 的观测单位）。
 *
 * `n` 是子组大小（试验次数），`p` 是子组内的成功比例。
 * **变序 σ_p 的载体**：n_i 不等时控制限必须按各自 n_i 重算。
 */
export interface EwmaSubgroup {
  /** 子组大小（≥ 1）。 */
  n: number;
  /** 子组内的成功比例（0..1）。 */
  p: number;
}

/** EWMA 参数。 */
export interface EwmaOptions {
  /** 平滑系数（默认 0.2 —— SPC 惯例）。 */
  lambda?: number;
  /** 控制限倍数（默认 3 —— 3σ）。 */
  L?: number;
  /** 启动所需的最小子组数（默认 25 —— λ=0.2 时控制限在 i≥21 饱和）。 */
  minSubgroups?: number;
}

/** 一点的控制限。 */
export interface EwmaLimit {
  /** 子组序号（1-based）。 */
  i: number;
  /** 上控制限（已 clamp 到 [0,1]）。 */
  ucl: number;
  /** 下控制限（已 clamp 到 [0,1]）。 */
  lcl: number;
  /** 半宽（原始量，未 clamp）。 */
  halfWidth: number;
}

/** EWMA 控制图读数。 */
export interface EwmaReadout {
  /** 子组（run）数。 */
  n: number;
  /** 中心线 / 总体通过率 p̄。 */
  pHat: number;
  /** 中心线（EWMA 的 Z_0 初值 = p̄）。 */
  centerLine: number;
  /** EWMA 序列（每个子组一个值）。 */
  series: number[];
  /** 控制限（变序，随 i 变化）。 */
  limits: EwmaLimit[];
  /** 越界点的**序列下标**（0-based；WE 规则 1：1 点超出 3σ）。 */
  violations: number[];
  /** 最后一个越界点的下标（无越界 ⇒ -1）。 */
  lastOutOfControlIndex: number;
  /** 是否退化（`p̄ ∈ {0,1}` ⇒ σ_p=0 ⇒ 控制图无判别力）。 */
  degenerate: boolean;
}

/**
 * 缺省常量（形状侧的「参数缺省值」）。
 *
 * ## 为什么常量也归形状文件
 *
 * 算法文件里散落着 `?? 0.2` / `?? 3` / `?? 25` / `= 5000` 这类魔法数时，
 * 「参数缺省是多少」这件事就没有**单一真相源** —— 改了一处忘了另一处，
 * 控制限就会与文档不符。集中在这里 ⇒ 文档、算法、测试三处引用同一组常量。
 *
 * ## 口径注记
 *
 * - `EWMA_LAMBDA = 0.2`：SPC 惯例 ⇒ 有效窗口 ≈ 1/λ = 5 个子组。
 * - `EWMA_LIMIT_K = 3`：3σ ⇒ 只用 WE 规则 1（band-detector 的规则 4–8
 *   作用于连续值，对 0/1 二项序列必假阳性，见 `controlCharts.ts` 文件头）。
 * - `EWMA_MIN_SUBGROUPS = 25`：λ=0.2 时控制限的收敛因子
 *   sqrt(λ/(1−λ)·(1−(1−λ)^(2i))) 在 i≈21 才饱和 ⇒ 子组太少时控制限尚未张开。
 * - `RUN_CLUSTER_GAP_MS = 5000`：run 切分的**启发式**间隙（同一次跑的四条账本
 *   是毫秒级连写，两次独立触发之间隔着人工/调度往返）。⚠️ 面板必须显示这个口径。
 */

/** 平滑系数缺省（λ=0.2 ⇒ 有效窗口 ≈ 1/λ = 5 个子组）。 */
export const EWMA_LAMBDA = 0.2;

/** 控制限倍数缺省（3σ —— SPC 惯例）。 */
export const EWMA_LIMIT_K = 3;

/**
 * 最小子组数缺省。
 *
 * λ=0.2 时控制限的收敛因子 sqrt(λ/(1−λ)·(1−(1−λ)^(2i))) 在 i≈21 才饱和，
 * 子组太少时控制限尚未张开 ⇒ 此时的「失控」判定不可信。
 */
export const EWMA_MIN_SUBGROUPS = 25;

/** run 切分的时间间隙缺省（毫秒）：相邻 entry 间隔 ≤ 此值 ⇒ 同一 run。 */
export const RUN_CLUSTER_GAP_MS = 5000;
