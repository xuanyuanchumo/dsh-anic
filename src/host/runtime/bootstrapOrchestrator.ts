/**
 * M10-b 自举链编排器：连通 eval-runner → gate-check → auto-fix-loop 自动驱动链。
 *
 * 此前 selfBootstrap.ts 只是被动状态机（记录转移但不驱动脚本）。
 * 本模块实现主动编排：每轮自动调用 eval → gate → fix，直到 CONVERGED 或 EXHAUSTED。
 * 每步通过 FlowTracker 记录，供 anic_status 查询和大模型审计。
 *
 * 拆分史（T3 250 行上限，两次拆分均因单文件越界）：
 *   - cycle-38：步骤执行（跑一步+记账+解析）→ bootstrapSteps.ts（gate 步骤在
 *     re-gate 环下出现三个调用点，重复第三次即拆分时机）；
 *   - cycle-72：异步执行循环 → bootstrapOrchestratorAsync.ts；相位推进 →
 *     bootstrapPhase.ts（同步/异步两版都必须有同一份状态机权威，不能各复制一份）。
 * 本文件保留：同步编排循环 + 轮次结算（advanceBootstrap）。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { resolveSkillScriptsDir } from '../skillInvoker.ts';
import {
  type BootstrapState,
  initialBootstrapState,
  loadBootstrapState,
  saveBootstrapState,
  advanceBootstrap,
  extractFailureReasons,
} from '../selfBootstrap.ts';
import { loadFlowTracker, type FlowTrackerState } from './flowTracker.ts';
import { runEvalStep, runGateStep, runFixStep, gateVerdictPassed } from './bootstrapSteps.ts';
import { enterPhase, type PhaseTrigger } from './bootstrapPhase.ts';
import { checkBootstrapPreconditions, type PreflightResult } from './bootstrapPreflight.ts';

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
    /** 复检（fix-done 后的第二次 gate-check）流 ID——与 gateFlowId 分开，见异步版注释。 */
    verifyFlowId?: string;
  }>;
  converged: boolean;
  /**
   * 前置未就绪时非空（cycle-72 P0）。非空即代表**本轮一步未跑**：
   * rounds 为空、状态未变、无提案落盘——调用方必须据此报错而不是读 evalScore。
   */
  precondition?: PreflightResult & { ok: false };
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

  // 前置守卫（cycle-72 P0）：缺 config / cycle 目录时**一步都不跑**。
  // 旧行为会把入口拒绝折叠成 evalScore 0 + gateVerdict FAIL，进而在每一轮写出
  // 一份 0 分 tech-debt 提案——把「环境未就绪」伪装成「质量结论」，自举永不收敛
  // 且持续污染债务队列。现在响亮返回专用码，调用方据此修复前置。
  const preflight = checkBootstrapPreconditions(scriptsDir, cyclesDir);
  if (!preflight.ok) {
    return { state: loadBootstrapState(cyclesDir), rounds: [], converged: false, precondition: preflight };
  }

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
    let verifyFlowId: string | undefined;
    if (!gateVerdictPassed(gateVerdict) && scriptsDir) {
      state = enterPhase(cyclesDir, state, 'gate-fail'); // 相位 2：FIXING
      const fixStep = runFixStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
      trackerState = fixStep.trackerState;
      fixApplied = fixStep.value;
      fixFlowId = fixStep.flowId;
      state = enterPhase(cyclesDir, state, 'fix-done'); // 相位 3：VERIFYING（真实复检）
      const verifyStep = runGateStep(scriptsDir, cyclesDir, trackerState, workspace, timeoutMs);
      trackerState = verifyStep.trackerState;
      verifyFlowId = verifyStep.flowId; // cycle-72：复检流 ID 不得丢弃（见异步版说明）
      if (gateVerdictPassed(verifyStep.value)) {
        gateVerdict = verifyStep.value; // 复检通过 → 新裁决结算
      } else {
        state = enterPhase(cyclesDir, state, 'verify-fail'); // 复检未过 → 回 GATE_CHECKING
      }
    }

    // 根因如实落盘（cycle-72 P0-BOOTSTRAP-NO-ROOTCAUSE）：门禁/评估各自的失败行都摘进来，
    // 「为什么没收敛」因此在磁盘上可见，而不是只能靠外侧读脚本 stdout 拼。
    const failureReasons = [
      ...extractFailureReasons(gateStep.result),
      ...extractFailureReasons(evalStep.result),
    ];
    state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied, failureReasons);
    saveBootstrapState(cyclesDir, state);

    rounds.push({
      round: state.round,
      evalScore,
      gateVerdict,
      fixApplied,
      evalFlowId: evalStep.flowId,
      gateFlowId: gateStep.flowId,
      fixFlowId,
      verifyFlowId,
    });
  }

  return { state, rounds, converged: state.status === 'CONVERGED' };
}

/**
 * 异步版自举循环已拆分至 bootstrapOrchestratorAsync.ts（cycle-72 T3：加入前置守卫后
 * 本文件 261 行 > 250 上限）。此处 re-export 保持既有 import 路径稳定
 * （toolsBootstrapGateway / bootstrapEngineIntegration 等调用方无需改动）。
 *
 * 相位权威不在此处转发：enterPhase 已迁至 bootstrapPhase.ts，同步与异步两版
 * 都从那一处 import——避免「编排器再导出一次」形成第二个引用入口。
 */
export { runSelfBootstrapCycleAsync } from './bootstrapOrchestratorAsync.ts';

