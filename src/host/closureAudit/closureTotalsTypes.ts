/**
 * 闭环体检**汇总计数**（cycle-75 T3 拆分：registryClosure 超 250 行）。
 *
 * 独立成文件的原因：`ClosureTotals` 同时被服务端汇总（closureSummary）与
 * 客户端投影（closureView）引用，放在 registryClosure 里会让三者形成
 * 循环 import —— 类型单独下沉是破环的标准手法。
 */

/** 全量体检的计数面（每一个数字都必须能追到逐项证据）。 */
export interface ClosureTotals {
  registered: number;
  produced: number;
  /** consumed = 本仓内有读取方（含测试/agent 卡证据）。 */
  consumed: number;
  /** codeConsumed = 生产代码内真消费（证据出自 src/ 非注册文件）。 */
  codeConsumed: number;
  unconsumed: number;
  ghost: number;
  /**
   * ★cycle-75：五分类计数。前四键**只覆盖未消费项**（consumedGap + producedGap = unconsumed）；
   * `channelOnly` 不在未消费里（它是「已消费但仅测试/agent 卡引用」）——这类资产
   * 不计入 unconsumed，却是「生产了但没人用」的同一族缺口，必须单独可见，
   * 否则面板会把 285 个「已消费」误读成一片健康的绿。
   */
  consumedGap: number;
  /** !produced && !consumed —— 产出缺口（只声明了、没接线）。 */
  producedGap: number;
  /** consumed && dynamic —— 已认领消费、但证据是**计算键**（非字面量）。 */
  dynamicClaimed: number;
  /** consumed && evidenceKind==='channel' —— 仅测试/agent 卡引用，无生产消费者。 */
  channelOnly: number;
}
