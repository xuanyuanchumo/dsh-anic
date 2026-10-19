/**
 * M10-b 自举链编排器：连通 eval-runner → gate-check → auto-fix-loop 自动驱动链。
 *
 * 此前 selfBootstrap.ts 只是被动状态机（记录转移但不驱动脚本）。
 * 本模块实现主动编排：每轮自动调用 eval → gate → fix，直到 CONVERGED 或 EXHAUSTED。
 * 每步通过 FlowTracker 记录，供 anic_status 查询和大模型审计。
 *
 * 步骤执行（跑一步+记账+解析）已拆分至 bootstrapSteps.ts（cycle-38 T3：re-gate
 * 环让 gate 步骤出现三个调用点，重复第三次即拆分时机）。本文件只保留状态机
 * 编排：相位推进（enterPhase）与轮次结算（advanceBootstrap）。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { invokeSkillScriptAsync, resolveSkillScriptsDir } from '../skillInvoker.ts';
import {
  type BootstrapState,
  type BootstrapTrigger,
  initialBootstrapState,
  loadBootstrapState,
  saveBootstrapState,
  advanceBootstrap,
  transitionBootstrap,
} from '../selfBootstrap.ts';
import { loadFlowTracker, startFlow, finishFlow, type FlowTrackerState } from './flowTracker.ts';
import { runEvalStep, runGateStep, runFixStep, gateVerdictPassed, GATE_CHECK_ARGS } from './bootstrapSteps.ts';
import { parseEvalScore, parseGateVerdict, parseFixApplied } from './scriptParsers.ts';

export interface BootstrapCycleResult {
  state: BootstrapState;
  rounds: Array<{
    round: number;
    evalScore: number;
    gateVerdict: string;
    fixApplied: string | null;
    evalFlowId?: string;
    gateFlowId?: string;
    fixFlowId?: string;
  }>;
  converged: boolean;
}

/**
 * 相位推进：把中间态落盘（cycle-38 修 doc18 P1-6「中间态空转」）。
 *
 * 旧实现里 EVALUATING / GATE_CHECKING / VERIFYING 三个状态**从不被赋值**，
 * 编排器跑动期间 `self-bootstrap.json` 里的 status 只在轮末结算时变化，
 * 于是「正在评估」「正在查门禁」在磁盘上不可见——白盒面板看不到进行中的事实。
 *
 * 现在每个相位边界都走 `transitionBootstrap`（唯一写 status 的函数）并立即落盘。
 * 非法触发词不推进也不抛：返回原状态并让调用方继续，因为**相位记录是观测手段，
 * 不是裁决手段**——不能因为记账失败而让整轮自举停摆。
 */
function enterPhase(cyclesDir: string, state: BootstrapState, trigger: BootstrapTrigger): BootstrapState {
  const moved = transitionBootstrap(state, trigger);
  if (!moved.ok) return state;
  saveBootstrapState(cyclesDir, moved.state);
  return moved.state;
}

/**
 * 运行完整自举循环：eval → gate → (fix if fail) → verify(re-gate) → repeat。
 *
 * cycle-38 re-gate 环（doc18 P1-6 的收尾）：旧实现 fix-done 进 VERIFYING 后
 * **立即用修复前的 gateVerdict 结算**——「复检」是假的。现在 VERIFYING 相位
 * 真实重跑 gate-check：
 *   - re-gate PASS → 以新裁决结算（修复生效的直接证据）；
 *   - re-gate 未过 → fire 'verify-fail' 回 GATE_CHECKING（表驱动边），结算走
 *     旧裁决，下一轮 while 迭代重新 eval+gate（round 自增是结算的副作用，无死循环）。
 * 两次门禁（修复前后）都经 FlowTracker 记账——「复检发生在磁盘上」。
 */
export function runSelfBootstrapCycle(
  workspace: string,
  maxRounds = 3,
  timeoutMs = 60000,
): BootstrapCycleResult {
  const cyclesDir = join(workspace, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const scriptsDir = resolveSkillScriptsDir(workspace);

  let state = loadBootstrapState(cyclesDir);
  if (state.status === 'CONVERGED' || state.status === 'EXHAUSTED') {
    state = initialBootstrapState(maxRounds);
  }
  state = { ...state, maxRounds };

  let trackerState = loadFlowTracker(cyclesDir);
  const rounds: BootstrapCycleResult['rounds'] = [];

  while (state.round < state.maxRounds && state.status !== 'CONVERGED') {
    state = enterPhase(cyclesDir, state, 'start'); // 相位 0：EVALUATING

    const evalStep = runEvalStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
    trackerState = evalStep.trackerState;
    const evalScore = evalStep.value;

    state = enterPhase(cyclesDir, state, 'eval-done'); // 相位 1：GATE_CHECKING

    const gateStep = runGateStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
    trackerState = gateStep.trackerState;
    let gateVerdict = gateStep.value;

    let fixApplied: string | null = null;
    let fixFlowId: string | undefined;
    if (!gateVerdictPassed(gateVerdict) && scriptsDir) {
      state = enterPhase(cyclesDir, state, 'gate-fail'); // 相位 2：FIXING
      const fixStep = runFixStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
      trackerState = fixStep.trackerState;
      fixApplied = fixStep.value;
      fixFlowId = fixStep.flowId;
      state = enterPhase(cyclesDir, state, 'fix-done'); // 相位 3：VERIFYING（真实复检）
      const verifyStep = runGateStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
      trackerState = verifyStep.trackerState;
      if (gateVerdictPassed(verifyStep.value)) {
        gateVerdict = verifyStep.value; // 复检通过 → 新裁决结算
      } else {
        state = enterPhase(cyclesDir, state, 'verify-fail'); // 复检未过 → 回 GATE_CHECKING
      }
    }

    state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied);
    saveBootstrapState(cyclesDir, state);

    rounds.push({
      round: state.round,
      evalScore,
      gateVerdict,
      fixApplied,
      evalFlowId: evalStep.flowId,
      gateFlowId: gateStep.flowId,
      fixFlowId,
    });
  }

  return { state, rounds, converged: state.status === 'CONVERGED' };
}

/**
 * 异步版自举循环（P1-EVENT-LOOP / P1-EXEC-SIGNAL，cycle-16）。
 *
 * 语义与同步版逐字相同（同 FlowTracker 记账、同状态机推进、同解析器），
 * 差异仅三点：async spawn 不阻塞宿主事件循环；exec.signal 触发即终止当前
 * 子进程并在当前轮边界停止（已完成轮次的状态/账本/flow 记录如实保留——
 * 绝不回滚已落盘事实）；返回体多 aborted 字段如实上报取消。
 * re-gate 环语义与同步版一致（fix-done 后真实复检）。
 */
export async function runSelfBootstrapCycleAsync(
  workspace: string,
  maxRounds = 3,
  timeoutMs = 60000,
  options?: { signal?: AbortSignal },
): Promise<BootstrapCycleResult & { aborted: boolean }> {
  const cyclesDir = join(workspace, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const scriptsDir = resolveSkillScriptsDir(workspace);
  const signal = options?.signal;

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
  ): Promise<{ flowId?: string; result?: Awaited<ReturnType<typeof invokeSkillScriptAsync>> } > => {
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
    if (!gateVerdictPassed(gateVerdict) && !signal?.aborted) {
      state = enterPhase(cyclesDir, state, 'gate-fail'); // 相位 2：FIXING
      const fixRun = await runStep('auto-fix-loop', []);
      fixApplied = fixRun.result ? parseFixApplied(fixRun.result) : null;
      state = enterPhase(cyclesDir, state, 'fix-done'); // 相位 3：VERIFYING（真实复检）
      const verifyRun = await runStep('gate-check', GATE_CHECK_ARGS);
      if (verifyRun.result) {
        const reVerdict = parseGateVerdict(verifyRun.result);
        if (gateVerdictPassed(reVerdict)) {
          gateVerdict = reVerdict; // 复检通过 → 新裁决结算
        } else {
          state = enterPhase(cyclesDir, state, 'verify-fail'); // 复检未过 → 回 GATE_CHECKING
        }
      }
    }

    state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied);
    saveBootstrapState(cyclesDir, state);

    rounds.push({ round: state.round, evalScore, gateVerdict, fixApplied, evalFlowId: evalRun.flowId });
  }

  return { state, rounds, converged: state.status === 'CONVERGED', aborted };
}
