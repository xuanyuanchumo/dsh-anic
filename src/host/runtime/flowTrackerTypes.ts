/**
 * flow-tracker 的**类型定义**（cycle-91 拆分）。
 *
 * ## 为什么拆
 *
 * cycle-91 引入 append-only 历史层后，`flowTracker.ts` 破 250 行（T3 纪律）。
 * 拆分的**第一刀**是类型：类型是**静态**的，业务是**行为**的，两者变更
 * 节奏不同 —— 类型几乎不变，业务每轮都在改。混在一起时，改业务的人
 * 会顺手改类型声明。
 *
 * 第二个理由更实际：`flowTrackerHistory.ts`（历史层）需要 `FlowRecord`，
 * 若类型留在 `flowTracker.ts` 里，历史层就得 import 主文件 ⇒
 * **循环依赖**（主文件 import 历史层、历史层 import 主文件）。
 * 把类型抽到独立文件后，历史层只依赖类型文件，主文件依赖两者 ⇒ **无环**。
 *
 * ## 边界
 *
 * 纯类型声明：零运行时值、零逻辑、零 IO。
 */

export type FlowStatus = 'INVOKING' | 'RUNNING' | 'DONE' | 'FAILED' | 'TIMEOUT';

/** 归属来源三态（cycle-89 join key）：none = 诚实的未知，绝不编造。 */
export type FlowAttributionSource = 'workflow-state' | 'ledger' | 'none';

/** 归属元数据：`at` 是解析那一刻的 ISO 时间（不是流程开始时间）。 */
export interface FlowAttribution { at: string; source: FlowAttributionSource; }

export interface FlowRecord {
  /** 唯一标识：`${script}-${isoTimestamp}-${counter}` */
  flowId: string;
  /** 白名单脚本名 */
  script: string;
  /** 工作区路径 */
  workspace: string;
  /** 调用参数 */
  args: string[];
  /** 当前状态 */
  status: FlowStatus;
  /** ISO 开始时间戳 */
  startedAt: string;
  /** ISO 结束时间戳 */
  endedAt?: string;
  /** 退出码 */
  exitCode?: number;
  /** 截断 stdout（≤8000 字符） */
  stdout?: string;
  /** 截断 stderr（≤4000 字符） */
  stderr?: string;
  /** 耗时毫秒 */
  durationMs?: number;
  /** 循环归属（如 `cycle-89`）。可选：旧记录无此字段，读侧容忍缺失。 */
  cycle?: string;
  /** 宏观相位归属（plan/design/build/test/deploy/maintain）。可选。 */
  phase?: string;
  /** 门禁归属（G0..G3 / H1..H4）。可选。 */
  gate?: string;
  /** 归属来源与解析时刻；缺失 = 旧记录（按 `none` 处理）。 */
  attribution?: FlowAttribution;
}

/**
 * 淘汰水位线（cycle-94）—— 回答「我看到的是全部，还是被裁过的最近 N 条」。
 *
 * ## 为什么类型放在本文件而不是 `flowRetention.ts`
 *
 * `flowRetention.ts`（策略/算法）需要 `FlowRecord`，而本文件（纯类型）若反过来
 * import 它，就形成 `flowTrackerTypes ↔ flowRetention` 的**类型环**。虽然
 * `importGraph.mjs` 会排除 type-only 边，但本仓纪律是「让依赖成为树而不是环」
 * （cycle-93 §3 的原话：环是静态可判的，运行时才爆的那类缺陷最难查）。
 * ⇒ 类型下沉到零依赖的纯类型文件，算法文件单向依赖它。
 *
 * ## 四个读数的语义
 *
 * 对齐 dsh-context 的 `surfaceFloor` / `archiveFloor` 等 floor 家族：
 * 记的是「裁到哪儿」而不是「裁了几条」—— floor 单调可比，条数不是。
 */
export interface EvictionWatermark {
  /**
   * 被裁掉的 flow 的最大 `startedAt`（ISO 串）；从未裁过 → null。
   *
   * **为什么用时间戳而不是 counter**：counter 只在 `startFlow` 递增，而
   * `flowId` 的时间戳是调用真实发生的时刻。读侧拿它和「我最后一次看到的流程时间」
   * 一比就知道界在哪 —— counter 做不到（读侧未必见过 counter）。
   */
  evictedThrough: string | null;
  /** 累计被裁掉的条数（只增不减，用于「丢了多少」的定量）。 */
  evictedTotal: number;
  /** 最近一次淘汰裁掉几条（0 = 没触发淘汰）。 */
  evictedNow: number;
  /**
   * 是否因「保护进行中流程」而保留了本应被裁的记录。
   *
   * 为 true 意味着**热窗口可能超过 MAX_WINDOW** —— 这是**有意的**：
   * 「容量上限」与「看得见正在跑什么」冲突时，后者优先。诚实标注而不是
   * 悄悄超限（否则下一个人看到 205 条会以为是 bug）。
   */
  overCapacity: boolean;
}

export interface FlowTrackerState {
  flows: FlowRecord[];
  /** 单调递增计数器，用于 flowId 唯一性 */
  counter: number;
  /**
   * 淘汰水位线（cycle-94）。**可选**：旧文件（v2 及之前）没有该字段，
   * 读侧按空水位线处理 —— 语义恰好正确（那些文件确实没淘汰过，或淘汰未被记录）。
   */
  watermark?: EvictionWatermark;
}
