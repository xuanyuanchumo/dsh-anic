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

export interface FlowTrackerState {
  flows: FlowRecord[];
  /** 单调递增计数器，用于 flowId 唯一性 */
  counter: number;
}
