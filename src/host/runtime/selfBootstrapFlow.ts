/**
 * 自举路由的 FlowTracker 记账（cycle-72 P0-SELF-FLOW-EVIDENCE）。
 *
 * 被守卫的缺陷：`/anic/self/evaluate|iterate|gate-check` 三个端点**从不写
 * FlowTracker**（grep `startFlow` 在 selfBootstrapRoute.ts 零命中），而
 * `anic_bootstrap_cycle` 工具走编排器时每步都写。后果是证据分裂：
 *   - 磁盘上有 `self-bootstrap.json` 状态与 tech-debt 提案；
 *   - `flow-tracker.json` 里却零条自举记录 ⇒ `anic_status.flows` 看不到任何
 *     self 端点调用，`continuousLearning` 的健康统计也把它们漏掉。
 * 「跑过了」与「有记录」被拆开，白盒因此对自举链是盲的。
 *
 * 本模块让路由与编排器**共用同一记账形态**（同一 startFlow/finishFlow、
 * 同一 workspace/args 口径），不复制第二份实现——CLAUDE.md 的单一实现纪律。
 */
import { startFlow, finishFlow, type FlowTrackerState } from './flowTracker.ts';
import { invokeSkillScript, type InvokeResult } from '../skillInvoker.ts';

/** 一次记账后的执行结果：既有脚本输出，也有本次 flowId（供响应体暴露）。 */
export interface TrackedInvoke {
  result: InvokeResult;
  flowId: string;
  trackerState: FlowTrackerState;
}

/**
 * 记账 + 执行 + 收账（startFlow → invoke → finishFlow 的唯一形态）。
 *
 * 顺序有意为之：startFlow 先落 INVOKING（调用**开始前**），finishFlow 后落终态。
 * 若脚本抛异常，flow 会停在 INVOKING——这比「零记录」诚实：一条未收账的记录
 * 暴露了「这里中断过」，而零记录什么也证明不了。
 */
export function invokeTracked(
  scriptsDir: string,
  script: string,
  args: string[],
  workspace: string,
  timeoutMs: number,
  trackerState: FlowTrackerState,
  cyclesDir: string,
): TrackedInvoke {
  const started = startFlow(cyclesDir, trackerState, script, workspace, args);
  const result = invokeSkillScript(scriptsDir, script, args, workspace, timeoutMs);
  const finished = finishFlow(cyclesDir, started.state, started.flowId, result);
  return { result, flowId: started.flowId, trackerState: finished };
}
