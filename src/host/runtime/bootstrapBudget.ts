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
 * **真实消费面（cycle-77 更正 · 实测 grep -rln，逐条可查）**：
 *   1. src/host/toolsBootstrapGateway.ts — 入口层唯一消费者：:14 import 常量与解析函数；
 *      :52 / :103 调 resolveBootstrapStepTimeout；:42 / :93 用常量渲染工具描述串。
 *   2. runtime/bootstrapOrchestrator.ts / bootstrapOrchestratorAsync.ts /
 *      bootstrapEngineIntegration.ts — cycle-77（F-06）前各自写死 `timeoutMs = 60000`，
 *      是本常量的**第二个默认源**且与之反向漂移（漏传第三参即按 60s 掐断 eval-runner，
 *      把预算不足伪装成「评估 0 分」）。现已全部改为引用本常量作形参默认值：
 *      显式传参优先的语义不变，但「不传就用 60000」这条错误默认已从三处消失
 *      （静态守卫见 tests/unit/bootstrapBudget.test.ts「不再出现裸 60000 默认值」）。
 *   3. **已收敛（cycle-78 WS-B，原「已知不对称」缺口）**：同步入口 invokeSkillScript
 *      内部曾按 `Math.min(timeoutMs, 120000)` 收口，而异步入口按传入值执行 ⇒ analyze
 *      入口的 240000ms 预算被砍成 120000ms（eval-runner 整金字塔实测 57s+，冷启动余量
 *      被吃掉）——同一份预算在两条路径上语义不同，是最难排查的那类漂移。
 *      现同步入口改用本模块导出的 MAX_SKILL_INVOKE_TIMEOUT_MS（= 自举每步预算，
 *      单一事实源），两路径 cap 一致：同步 = 异步 = 240000ms。
 *      cap 仍保留（而非彻底放开）的理由：超时是**保护**而非限制——防止调用方误传
 *      无限大/NaN/负数把宿主事件循环拖死；上限取「自举每步预算」是因为任何一次技能
 *      调用的合法上限就是它，再大只会掩盖预算配置错误（真正的域值由调用方显式传参）。
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
 * 技能脚本调用超时（同步/异步两入口共用）的**硬上限**（cycle-78 WS-B）。
 *
 * 与 BOOTSTRAP_STEP_TIMEOUT_MS 同值不是巧合而是定义：任何一次技能脚本调用的合法
 * 上限就是「自举每步预算」——再大只会掩盖预算配置错误。此前同步入口写死 120000，
 * 把 240000 的预算悄悄砍半（见文件头第 3 条），两入口因此语义不同。
 *
 * 保留 cap（而非放开到无上限）的理由：防调用方误传 Infinity/NaN/负数。
 * `Infinity` 在 spawnSync 里等于「永不超时」→ 一个卡死的管道能拖死宿主；
 * `NaN` 在 Node 里会被当作 0 处理（同样可能永不等超时）。上限是保护，不是限制。
 */
export const MAX_SKILL_INVOKE_TIMEOUT_MS = BOOTSTRAP_STEP_TIMEOUT_MS;

/**
 * 长跑脚本默认超时（cycle-112 · 实测根因）——auto-fix-loop 的合法上限。
 *
 * 被守卫缺陷：auto-fix-loop 在 runner 配置里允许 `test_timeout_ms`（本仓 240000）
 * × maxRetries（默认 3）次重试，**整次调用**的合法上限因此远超「自举每步预算」。
 * 而 anic_skill 网关此前把默认超时与硬上限都钉在 240000 ⇒ 真机 flow-tracker
 * 实测 5/6 次 auto-fix-loop 在 `durationMs=240020` 被 SIGTERM 掐断（status=TIMEOUT，
 * exitCode=-1）——**不是脚本慢，是调用预算比脚本预算还小**。健康模型据此把它
 * 长期判为 slow（同族：预算不足被伪装成质量结论）。
 *
 * 数值推导（可复算）：单次全量测试金字塔实测 ~57s（BOOTSTRAP_PYRAMID_BUDGET_MS），
 * 冷启动/并发争用按 2× 记 ≈ 120s；3 次重试 × 120s = 360s；加报告写盘与 Node
 * 冷启动 ≈ 420s。取 900000ms（15 min）给足余量且保持有界——上限仍是保护而非
 * 「永不超时」（Infinity/NaN 由 resolveSkillInvokeTimeout 拦在门外）。
 */
export const LONG_SCRIPT_TIMEOUT_MS = 900_000;

/** 需要长预算的脚本（白名单；新增成员必须在此登记并说明推导）。 */
const LONG_SCRIPT_BUDGET: Readonly<Record<string, number>> = {
  'auto-fix-loop': LONG_SCRIPT_TIMEOUT_MS,
};

/**
 * 一次技能脚本调用的**默认**超时（调用方未显式传参时）。
 * 长跑脚本取 LONG_SCRIPT_TIMEOUT_MS，其余取自举每步预算（默认值单一事实源）。
 */
export function defaultSkillTimeout(script: string): number {
  return LONG_SCRIPT_BUDGET[script] ?? BOOTSTRAP_STEP_TIMEOUT_MS;
}

/**
 * 一次技能脚本调用的**硬上限**（显式传参也越不过去）。
 * 长跑脚本的上限 = 它自己的预算；其余 = 自举每步预算（cycle-78 语义不变）。
 */
export function skillTimeoutCap(script: string): number {
  return LONG_SCRIPT_BUDGET[script] ?? MAX_SKILL_INVOKE_TIMEOUT_MS;
}

/**
 * 收口一次技能脚本调用的超时值（纯函数，无副作用——便于真断言而非静态字符串匹配）。
 *
 * 语义：合法正数 → min(请求值, capMs)；非法值（NaN/Infinity/非正）→ 直接取上限
 * （**不猜**调用方意图：宁可给足预算，也不给出「永不超时」）。
 *
 * cycle-112：`capMs` 参数化——长跑脚本（auto-fix-loop）的合法上限大于自举每步
 * 预算，调用方按 `skillTimeoutCap(script)` 传入；缺省仍是 MAX_SKILL_INVOKE_TIMEOUT_MS
 * （短脚本语义零变更）。
 */
export function resolveSkillInvokeTimeout(requestedMs: number, capMs: number = MAX_SKILL_INVOKE_TIMEOUT_MS): number {
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return capMs;
  return Math.min(requestedMs, capMs);
}

/**
 * 解析一次自举步骤的超时预算。
 *
 * 语义与旧内联表达式**逐字等价**（显式传参优先；非正数 / 非数一律落回默认）：
 *   typeof raw === 'number' && raw > 0 ? raw : <默认>
 * 唯一差别是旧默认字面量 60000 → BOOTSTRAP_STEP_TIMEOUT_MS（单一常量）。
 *
 * 上限纪律：本函数**不**引入更严的帽子——越界显式值原样透传，由执行层
 * invokeSkillScript / invokeSkillScriptAsync（skillInvoker*.ts）负责限制；
 * 同步入口现统一走 resolveSkillInvokeTimeout，两入口上限已一致（cycle-78 收敛）。
 */
export function resolveBootstrapStepTimeout(raw?: unknown): number {
  return typeof raw === 'number' && raw > 0 ? raw : BOOTSTRAP_STEP_TIMEOUT_MS;
}
