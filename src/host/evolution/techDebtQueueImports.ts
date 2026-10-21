/**
 * tech-debt 队列域的类型再导出（cycle-55 T-5501）。
 *
 * 为什么存在：healthDebtBridge 需要 TechDebtEntry/DebtSeverity 类型，而
 * patchEngine.ts 是唯一权威源。直接 import 会把 PatchEngine 的运行时
 * 依赖也拖进来（本桥只需类型 + techDebtQueue 的形状契约）——本文件做
 * 显式类型通道，避免桥接模块与生成引擎的隐式耦合。
 */
export type { TechDebtEntry, DebtSeverity } from './patchEngine.ts';
