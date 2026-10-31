/**
 * `tools/change` 的**发出计数**（cycle-93）—— 独立无依赖的极小计数器。
 *
 * ## 为什么单独成文件（解真实运行时环）
 *
 * cycle-93 首次实现时把计数器放在 `disclosureReadout.ts` 里，于是：
 *
 * ```
 * disclosureActivation.ts → disclosureReadout.ts   （记一次发出）
 * disclosureReadout.ts    → disclosureActivation.ts（读状态做读数）
 * ```
 *
 * ⇒ **真运行时环**（不是类型导入造成的伪环）。`skillConvergenceContract` 的
 * `importGraph` 守卫立刻报红 —— 这正是它的价值：**环是静态可判的，不该等到
 * 运行时才暴露**（Node ESM 下环会让一边拿到未初始化的绑定，报
 * "Cannot access before initialization"）。
 *
 * ## 解法：把「计数器」下沉为**零依赖叶子**
 *
 * 计数是纯状态（一个整数），与"谁在读它"无关。下沉后：
 *
 * ```
 * disclosureActivation.ts → toolsChangeCounter.ts   （叶子，零依赖）
 * disclosureReadout.ts    → toolsChangeCounter.ts   （叶子，零依赖）
 * disclosureReadout.ts    → disclosureActivation.ts （单向）
 * ```
 *
 * ⇒ 环消失，依赖变**树**。
 *
 * ## 边界
 *
 * - 进程级（模块级单例），多 agent 共享 —— 因为 `tools/change` 是
 *   **未按 scope 过滤的注册表通知**（宿主契约原文："An UNFILTERED
 *   registry-subject notification"）⇒ 计数天然是全局的；
 * - 只累加，不复位（`resetToolsChangeEmitCount` 仅测试用）。
 */

let emits = 0;

/** 记一次 `tools/change` 发出。 */
export function noteToolsChangeEmit(): void {
  emits++;
}

/** 当前累计发出次数。 */
export function toolsChangeEmitCount(): number {
  return emits;
}

/** 单测复位（生产路径不调用）。 */
export function resetToolsChangeEmitCount(): void {
  emits = 0;
}
