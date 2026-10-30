/**
 * flow-tracker 的**存储规格**（cycle-91）—— 双层存储的形状与容量常量。
 *
 * ## 为什么要从「单文件滚动淘汰」改成「双层 append-only」（本轮 P0 治本）
 *
 * **实测缺陷**（cycle-90 收口台账 §5 O-90-04 已登记，本轮根治）：
 * 原实现把 200 条上限的**滚动淘汰**当作容量管理：
 *
 * ```
 * flow-tracker.json = { flows: FlowRecord[]（最多 200 条）, counter: number }
 * ```
 *
 * 淘汰的代价是**结构性偏差**，不是"旧数据不重要"：
 *
 * | 后果 | 机理 |
 * |---|---|
 * | **时间选择偏差** | 淘汰只发生在**容量触顶**的时刻（不是均匀采样）⇒ 样本在时间轴上**聚集在每次触顶之后的区间** ⇒ 长周期指标（KM 中位修复时间）系统性偏向近期 |
 * | **幸存者偏差** | 淘汰保留的是**最近**的 200 条 ⇒ 历史上"曾经连续失败"的记录在窗口滑出后消失 ⇒ 通过率类指标只看见"活下来的"流程 |
 * | **不可察觉的静默截断** | 读侧若不比对 `counter` 与 `flows.length` 就完全看不出数据被丢过（cycle-90 加了 `truncationInfo` 检测，但它在**路由层断了**——见下） |
 *
 * 治本方向（cycle-90 §6 提示①）：**append-only 历史 + 显式窗口**。
 * 写入永不丢数据；读取时按需投影窗口。
 *
 * ## 双层设计
 *
 * ```
 * .cycles/
 * ├── flow-tracker.json        ← 热窗口（≤ MAX_WINDOW 条，原子写，滚动）
 * │     { version, flows[], counter, history?: {...} }
 * └── flow-history.jsonl       ← 追加式历史（每行一条完整记录，永不重写）
 * ```
 *
 * - **热窗口**（`flow-tracker.json`）：保留既有字段形状（`flows` / `counter`）⇒
 *   **读侧零改动即可继续工作**（向后兼容）。上限仍存在，但它现在只是
 *   **"最近视图"**，不再是"唯一数据源"。
 * - **历史**（`flow-history.jsonl`）：每次 `finishFlow` 追加一行 JSON。
 *   只追加、只读、永不重写 ⇒ **O(1) 写入**（与 `segmentedLedger` 同款纪律）。
 *   即使热窗口把记录挤掉了，历史里**永远找得回来**。
 *
 * ## 为什么不做「只留 jsonl」而保留双层
 *
 * 纯 jsonl 的读侧要**全量扫描 + 解析 N 行**才能得到最近 200 条；
 * 面板 4s 轮询一次 ⇒ 每 4 秒全量解析一个只增不减的文件 ⇒ **O(n) 每次轮询**，
 * 且 n 无上界。双层让「最近视图」保持 O(1) 读取，同时历史保证不丢。
 *
 * ## 为什么不做「只留 json」而直接扩容到 2000
 *
 * 扩容只是**推迟**偏差（2000 条后照样触发），不消除偏差的性质。
 * 且单文件 JSON 每次写入要**重写整个数组** ⇒ O(n) 写放大。
 * 治本是「不再丢数据」，不是「丢得慢一点」。
 *
 * ## 容量常量
 *
 * - `MAX_WINDOW = 200`：热窗口保留条数。**沿用旧值**——它现在是"最近视图"
 *   的大小，不是"数据保留期"。改它会改变面板默认展示范围（用户可见行为），
 *   不属于本轮治本范围。
 * - 历史**不设上限**：append-only 的全部意义就是"不丢"。真要清理时，
 *   由**归档流程**（`archive-cycle`）显式处置，而不是由容量隐式淘汰。
 *
 * ## 诚实边界
 *
 * - 历史文件**可能无限增长**。这是**有意的**：它换来的是"统计口径不再随
 *   调用次数漂移"。代价由归档流程显式承担（而不是被隐式淘汰掩盖）。
 * - 读侧若**只读热窗口**，统计口径仍然是"最近 200 条"——**偏差没有消失，
 *   只是变得可见**。真正消除偏差需要读侧从历史文件取数（`readHistoryAll`）。
 *   本轮**同时**提供该能力，并让生命周期指标路由**默认走历史**。
 */
import type { FlowRecord } from './flowTracker.ts';

/** 热窗口文件路径（相对 cyclesDir）。 */
export const TRACKER_FILE = 'flow-tracker.json';

/** append-only 历史文件路径（相对 cyclesDir）。 */
export const HISTORY_FILE = 'flow-history.jsonl';

/** 热窗口保留条数（"最近视图"大小，非数据保留期）。 */
export const MAX_WINDOW = 200;

/** stdout 截断上限（字符）。 */
export const STDOUT_MAX = 8000;

/** stderr 截断上限（字符）。 */
export const STDERR_MAX = 4000;

/** 持久化文件版本号（升级时按此迁移）。 */
export const TRACKER_VERSION = 2;

/**
 * 热窗口的持久化形状（v2）。
 *
 * v1 = `{ flows, counter }`（无 version 字段）。
 * v2 = `{ version, flows, counter }`。
 *
 * **为什么加 version**：读侧要能区分「v1 文件（counter 是单调累计值，
 * 语义正确）」与「v2 文件」。v1 的 `counter` 本来就是单调累计的
 * （`state.counter + 1`），所以**两者语义一致**，v1 文件**无需迁移**——
 * 但显式记版本让「将来加字段」有锚点，且让读侧对未知版本**显式降级**
 * 而不是猜。
 */
export interface FlowTrackerFileV2 {
  version: number;
  flows: FlowRecord[];
  counter: number;
}

/**
 * 读侧遇到未知版本时的降级策略。
 *
 * **为什么是「宽容读 + 显式警告」而不是「拒绝」**：持久化文件是
 * **本插件自己写的**，不是用户输入；把它读崩会让整个可观测性面消失，
 * 那比"少一个字段"严重得多。但**不能静默**——所以返回时带上 `versionMismatch`，
 * 由调用方决定是否提示。
 */
export const UNKNOWN_VERSION_BEHAVIOR = 'tolerate-and-warn' as const;
