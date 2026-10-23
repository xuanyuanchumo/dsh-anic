/**
 * 自举每步超时预算 —— **全插件单一事实源**（cycle-72 P0-BOOTSTRAP-STEP-TIMEOUT）。
 *
 * 被守卫缺陷：anic_bootstrap_cycle / anic_bootstrap_analyze 的每步默认超时是
 * 60000ms，而这一步（eval-runner）要跑**整条测试金字塔**。真机证据（只读取证，
 * .cycles/flow-tracker.json 最后一条 eval-runner flow）：
 *   flowId      eval-runner-2026-10-22T14:03:37.161Z-…
 *   status      TIMEOUT
 *   durationMs  60009
 *   exitCode    -1
 * 即脚本在第 60.009s 被 SIGTERM 掐断 —— 这不是质量结论，是**预算不足**。
 * 后果：自举链拿不到评估结论 → CONVERGED 永假，且每轮写出误导性的 0 分提案。
 *
 * 数值推导（真实数字，非目测；node scripts/run-tests.mjs 实测打印）：
 *   1. vitest     层 56.9s
 *   2. validate   层  0.3s
 *   3. smoke      层  0.2s
 *   4. trigger    层  0.1s
 *   → 金字塔合计 ≈ 57.5s（本模块保守按 57000ms 记）
 *   5. eval-runner.mjs 自身报告写盘 + Node 冷启动开销：该脚本还会再 spawn 若干层，
 *      Windows 冷启动单进程实测约 0.1–0.4s，多层叠加不可忽略。
 *   6. 余量：CI 磁盘抖动、并发会话争用、父工程 vitest 首次加载（缓存未热）。
 * 保守取 4× 金字塔：57s × 4 ≈ 228s，圆整到 **240000ms**。
 * 该值 ≥ 金字塔 × 4，且小于「无上限」——有界、可解释、可复算。
 *
 * 单一实现纪律（本模块存在的理由）：两个入口（cycle / analyze）原先各写一份
 *   typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 60000
 * 同义实现写两份只会向坏方向漂移（本仓库既有先例：解析器双份重复 → 恒错解析）。
 * 现在两处都调用 resolveBootstrapStepTimeout，默认值只存在于 BOOTSTRAP_STEP_TIMEOUT_MS。
 *
 * 放在 runtime/ 而非顶层 gateway 的理由：真实消费者是 src/host/toolIds… 之外的
 * **gateway 层**（toolsBootstrapGateway.ts），而 gateway → runtime 是既有方向；
 * 若把常量放进 gateway，runtime 侧要引它就会反向依赖 gateway（分层倒置）。
 * 本模块零依赖（不 import 任何仓内模块），因此不可能引入 import 环。
 *
 * **真实消费面（cycle-72 更正 · 实测 grep -rln，此前本注释高报过，属「声明>实现」）**：
 *   1. src/host/toolsBootstrapGateway.ts — 唯一消费者：:14 import 常量与解析函数；
 *      :52 / :103 调 resolveBootstrapStepTimeout；:42 / :93 用常量渲染工具描述串。
 *   2. runtime/bootstrapOrchestrator.ts / bootstrapOrchestratorAsync.ts **不**引用本条——
 *      它们把 timeoutMs 作为**形参**接收（由 gateway 传入），并非默认参数引用。
 *   3. runtime/bootstrapEngineIntegration.ts:99 仍是**独立字面量** `timeoutMs = 60000`：
 *      生产路径上 gateway 总会显式传第三参（:105），故该字面量在生产不可达；但它
 *      仍是一个未收敛的第二默认源（单测 bootstrapEngineIntegration.test.ts 显式传值绕过它）。
 *      未在本轮收敛：改它属 toolsBootstrapGateway / bootstrapEngineIntegration 的调用约定，
 *      会扩大本任务边界——如实登记为已知缺口，不假装「单一事实源」已覆盖全链。
 */

/**
 * 实测测试金字塔合计预算（毫秒）。
 * = vitest 56.9s + validate 0.3s + smoke 0.2s + trigger 0.1s ≈ 57.5s，保守取 57s。
 * 回归测试据此断言默认值有下限（阈值来源即本注释，不是拍脑袋）。
 */
export const BOOTSTRAP_PYRAMID_BUDGET_MS = 57_000;

/**
 * 自举「每步」默认超时（毫秒）——显式传参缺省时使用。
 * 240000 = 4 × 金字塔 57s（余量与推导见文件头）。
 */
export const BOOTSTRAP_STEP_TIMEOUT_MS = 240_000;

/**
 * 解析一次自举步骤的超时预算。
 *
 * 语义与旧内联表达式**逐字等价**（显式传参优先；非正数 / 非数一律落回默认）：
 *   typeof raw === 'number' && raw > 0 ? raw : <默认>
 * 唯一差别是旧默认字面量 60000 → BOOTSTRAP_STEP_TIMEOUT_MS（单一常量）。
 *
 * 上限纪律：**沿既有语义，不引入更严的帽子**——越界显式值原样透传，由
 * invokeSkillScript / invokeSkillScriptAsync（skillInvoker*.ts）负责执行层限制。
 * 特别说明（如实记录，不在本步修复）：同步入口 invokeSkillScript 内部
 * 仍按 Math.min(timeoutMs, 120000) 收口（skillInvoker.ts），因此 analyze 入口的
 * 有效预算为 120000ms（≥ 金字塔 57s，仍可跑通），与 async 入口的完整 240000ms
 * 存在已知不对称。放开该 cap 属 skillInvoker.ts 范围，不在本任务写入边界内。
 */
export function resolveBootstrapStepTimeout(raw?: unknown): number {
  return typeof raw === 'number' && raw > 0 ? raw : BOOTSTRAP_STEP_TIMEOUT_MS;
}
