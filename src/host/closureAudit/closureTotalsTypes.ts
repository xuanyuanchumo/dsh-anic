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
   * ★cycle-75：五分类计数（cycle-78 扩为六分类）。哪些键覆盖未消费，**必须分清**：
   *   unconsumed = declaredChannel + consumedGap + producedGap；
   *   consumed   = code + dynamicClaimed + channelOnly；
   *   registered = 上式两侧之和。
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
  /**
   * ★cycle-78：!consumed && 已在 channelRegistry 声明（通道独占：外部 curl / 运维 /
   * MCP 客户端 / 人工面）。它与 consumedGap 的区别**只是「有没有人说清为什么」**：
   * 声明 ≠ 豁免，项仍是未消费；但处置动作从「补接线」变成「维持并复核文档」。
   */
  channelDeclared: number;
}
