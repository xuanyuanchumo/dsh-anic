/**
 * 自举端点的「记账 + 解析」执行体（cycle-72 T3 拆分：路由文件 265 行 > 250 上限）。
 *
 * 为什么单独成文件：evaluate / gate-check / iterate 三个端点都要「跑一次脚本、
 * 记一次 FlowTracker、解析成三态」。若各写一份，就是同一语义的第二、第三份实现
 * （CLAUDE.md 单一实现纪律）。这里收成两个函数，端点只做响应装配。
 */
import type { BootstrapState } from '../selfBootstrap.ts';
import {
  parseEvalScore,
  parseEvalOutcome,
  parseGateOutcome,
  type ScriptOutcome,
} from '../runtime/scriptParsers.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import { invokeTracked } from '../runtime/selfBootstrapFlow.ts';
import { applyPhase } from '../runtime/bootstrapPhase.ts';
import type { InvokeResult } from '../skillInvoker.ts';

/** 已解析的自举靶标（与 routes/selfBootstrapShared.ts 的 SelfTarget 同形）。 */
export interface TrackTarget {
  cyclesDir: string;
  scriptsDir: string;
  roots: string;
}

export interface EvalTrackedResult {
  result: InvokeResult;
  flowId: string;
  /** 二值分数（既有契约，0/1）。 */
  score: number;
  /** 三态裁决：区分「质量失败」与「根本没跑成」。 */
  outcome: ScriptOutcome;
  phase: { state: BootstrapState; rejected: string | null };
}

export interface GateTrackedResult {
  result: InvokeResult;
  flowId: string;
  verdict: string;
  outcome: ScriptOutcome & { verdict: string };
}

/**
 * 运行一次 eval（记账 + 解析 + 推进到 EVALUATING）。
 *
 * 同时返回 flowId 与三态 outcome：只记不报等于换个地方藏证据；只报二值分数
 * 则会把「没跑成」和「质量失败」混成一个 0。
 */
export function runEvalTracked(target: TrackTarget, state: BootstrapState): EvalTrackedResult {
  const trackerState = loadFlowTracker(target.cyclesDir);
  const { result, flowId } = invokeTracked(
    target.scriptsDir, 'eval-runner', [], target.roots, 60000, trackerState, target.cyclesDir,
  );
  const score = parseEvalScore(result);
  const outcome = parseEvalOutcome(result);
  const phase = applyPhase(target.cyclesDir, state, 'start', { lastEvalScore: score });
  return { result, flowId, score, outcome, phase };
}

/** 运行一次 gate-check（记账 + 解析）。args 由调用方给定（--record 由 iterate 控制）。 */
export function runGateTracked(target: TrackTarget, args: string[]): GateTrackedResult {
  const trackerState = loadFlowTracker(target.cyclesDir);
  const { result, flowId } = invokeTracked(
    target.scriptsDir, 'gate-check', args, target.roots, 60000, trackerState, target.cyclesDir,
  );
  const outcome = parseGateOutcome(result);
  return { result, flowId, verdict: outcome.verdict, outcome };
}
