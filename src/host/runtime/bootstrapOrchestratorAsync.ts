/**
 * 异步版自举循环（P1-EVENT-LOOP / P1-EXEC-SIGNAL，cycle-16）。
 *
 * 语义与同步版（bootstrapOrchestrator.runSelfBootstrapCycle）逐字相同：
 * 同 FlowTracker 记账、同状态机推进、同解析器、同前置守卫码表。
 * 差异仅三点：
 *   1. async spawn 不阻塞宿主事件循环；
 *   2. exec.signal 触发即终止当前子进程并在**轮边界**停止——已完成轮次的状态/
 *      账本/flow 记录如实保留，绝不回滚已落盘事实；
 *   3. 返回体多 `aborted` 字段如实上报取消。
 *
 * cycle-72 T3 拆分说明：本函数原在 bootstrapOrchestrator.ts 内，加入前置守卫后
 * 该文件 261 行 > 250 上限（truthAudit T3 实测会拦）。按 CLAUDE.md「一域一文件」
 * 与既有先例（skillInvoker / skillInvokerAsync）拆出**执行循环**，编排器的状态机
 * 相位推进仍是唯一权威（enterPhase 留在编排器，经参数注入）。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { invokeSkillScriptAsync, resolveSkillScriptsDir } from '../skillInvoker.ts';
import {
  initialBootstrapState,
  loadBootstrapState,
  saveBootstrapState,
  advanceBootstrap,
  extractFailureReasons,
} from '../selfBootstrap.ts';
import { loadFlowTracker, startFlow, finishFlow } from './flowTracker.ts';
import { parseEvalScore, parseGateVerdict, parseFixApplied } from './scriptParsers.ts';
import { GATE_CHECK_ARGS, gateVerdictPassed } from './bootstrapSteps.ts';
import { enterPhase } from './bootstrapPhase.ts';
import { checkBootstrapPreconditions } from './bootstrapPreflight.ts';
// cycle-77（F-06）：与同步版同源同一默认值（BOOTSTRAP_STEP_TIMEOUT_MS）——
// 两版各自写 60000 曾使「显式传参缺省」时的行为与单一事实源分叉。
import { BOOTSTRAP_STEP_TIMEOUT_MS } from './bootstrapBudget.ts';
import type { BootstrapCycleResult } from './bootstrapOrchestrator.ts';

export async function runSelfBootstrapCycleAsync(
  workspace: string,
  maxRounds = 3,
  timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,
  options?: { signal?: AbortSignal },
): Promise<BootstrapCycleResult & { aborted: boolean }> {
  const cyclesDir = join(workspace, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const scriptsDir = resolveSkillScriptsDir(workspace);
  const signal = options?.signal;

  // 前置守卫（cycle-72 P0）：与同步版同一判据、同一码表——两版语义不得分叉。
  // 异步版额外要求：前置未就绪时**立即返回且不算中止**（aborted 恒 false）——
  // 「环境没准备好」与「调用方取消了」是两件事，混为一谈会让调用方误判可重试性。
  const preflight = checkBootstrapPreconditions(scriptsDir, cyclesDir);
  if (!preflight.ok) {
    return { state: loadBootstrapState(cyclesDir), rounds: [], converged: false, aborted: false, precondition: preflight };
  }

  let state = loadBootstrapState(cyclesDir);
  if (state.status === 'CONVERGED' || state.status === 'EXHAUSTED') {
    state = initialBootstrapState(maxRounds);
  }
  state = { ...state, maxRounds };

  let trackerState = loadFlowTracker(cyclesDir);
  const rounds: BootstrapCycleResult['rounds'] = [];
  let aborted = false;

  const runStep = async (
    script: 'eval-runner' | 'gate-check' | 'auto-fix-loop',
    args: string[],
  ): Promise<{ flowId?: string; result?: Awaited<ReturnType<typeof invokeSkillScriptAsync>> }> => {
    if (!scriptsDir) return {};
    const { state: s, flowId } = startFlow(cyclesDir, trackerState, script, workspace, args);
    trackerState = s;
    const result = await invokeSkillScriptAsync(scriptsDir, script, args, workspace, timeoutMs, { signal });
    trackerState = finishFlow(cyclesDir, trackerState, flowId, result);
    return { flowId, result };
  };

  while (state.round < state.maxRounds && state.status !== 'CONVERGED') {
    if (signal?.aborted) { aborted = true; break; }
    state = enterPhase(cyclesDir, state, 'start'); // 相位 0：EVALUATING

    const evalRun = await runStep('eval-runner', []);
    const evalScore = evalRun.result ? parseEvalScore(evalRun.result) : 0;

    state = enterPhase(cyclesDir, state, 'eval-done'); // 相位 1：GATE_CHECKING
    const gateRun = await runStep('gate-check', GATE_CHECK_ARGS);
    let gateVerdict = gateRun.result ? parseGateVerdict(gateRun.result) : 'unknown';

    if (signal?.aborted) { aborted = true; break; }

    let fixApplied: string | null = null;
    let fixFlowId: string | undefined;
    // cycle-72（P1-BOOTSTRAP-ROUNDS-FLOWID）：复检流 ID 必须与首次门禁**分开**记录。
    // 旧实现只 push evalFlowId，gate/fix/复检三个 flowId 虽已落 flow-tracker.json，
    // 却在返回体里不可见——大模型审计时只能看到「跑过一次 eval」，看不到
    // 「门禁查了两次（首次 + 复检）」，恰好抹掉 cycle-38 修好的那次真实复检。
    let verifyFlowId: string | undefined;
    let verifyRunResult: Awaited<ReturnType<typeof invokeSkillScriptAsync>> | undefined;
    if (!gateVerdictPassed(gateVerdict) && !signal?.aborted) {
      state = enterPhase(cyclesDir, state, 'gate-fail'); // 相位 2：FIXING
      const fixRun = await runStep('auto-fix-loop', []);
      fixApplied = fixRun.result ? parseFixApplied(fixRun.result) : null;
      fixFlowId = fixRun.flowId;
      state = enterPhase(cyclesDir, state, 'fix-done'); // 相位 3：VERIFYING（真实复检）
      const verifyRun = await runStep('gate-check', GATE_CHECK_ARGS);
      verifyFlowId = verifyRun.flowId;
      verifyRunResult = verifyRun.result;
      if (verifyRun.result) {
        const reVerdict = parseGateVerdict(verifyRun.result);
        if (gateVerdictPassed(reVerdict)) {
          gateVerdict = reVerdict; // 复检通过 → 新裁决结算
        } else {
          state = enterPhase(cyclesDir, state, 'verify-fail'); // 复检未过 → 回 GATE_CHECKING
        }
      }
    }

    // 根因如实落盘（cycle-72 P0-BOOTSTRAP-NO-ROOTCAUSE）：与同步版同口径、同一提取器——
    // 两版语义不得分叉（本文件头即声明「同一解析器、同一状态机」）。
    const failureReasons = [
      ...extractFailureReasons(gateRun.result),
      ...extractFailureReasons(verifyRunResult),
      ...extractFailureReasons(evalRun.result),
    ];
    state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied, failureReasons);
    saveBootstrapState(cyclesDir, state);

    rounds.push({
      round: state.round,
      evalScore,
      gateVerdict,
      fixApplied,
      evalFlowId: evalRun.flowId,
      gateFlowId: gateRun.flowId,
      fixFlowId,
      verifyFlowId,
    });
  }

  return { state, rounds, converged: state.status === 'CONVERGED', aborted };
}
