/**
 * 自举端点的「记账 + 解析」执行体（cycle-96 从 `routes/selfBootstrapRunners.ts` **下沉**到 runtime）。
 *
 * ## 为什么搬（是分层问题，不是行数问题）
 *
 * 原位置在 `routes/`，因为它最初只服务 HTTP 端点（cycle-72 T3 拆分：路由文件 265 行）。
 * cycle-96 起 `anic_bootstrap_other` 工具也要在**目标工作区**跑一次 eval/gate ——
 * 于是「跑脚本 + 记 FlowTracker + 解析三态」这段**纯执行逻辑**出现了工具面的消费者。
 * 若工具继续 `import '../routes/selfBootstrapRunners.ts'`，依赖方向就变成
 * `tools → routes`（反向）：路由是**装配层**，工具是**入口层**，两者都应当向下依赖
 * 执行层。故执行体搬到 `runtime/`（L0 执行层），两侧各自向下 import。
 *
 * ## 原文件为什么保留为薄 re-export
 *
 * `routes/selfBootstrapRoute.ts` / `selfBootstrapIterate.ts` / `selfBootstrapRunners.ts`
 * 的调用点属于别的工作流写域（本任务书**禁止**触碰那三个文件）。删掉旧路径会让
 * 不属于本任务的代码编译失败。故 `routes/selfBootstrapRunners.ts` 保留为
 * **一行式转发**（无逻辑、无第二份实现）——这是分层搬迁的过渡锚点，不是兼容层：
 * 它里面没有任何判断，语义只有一处（本文件）。
 *
 * ## 语义（一字未改，逐字搬自 cycle-72 实现）
 *
 * evaluate / gate-check 两个动作都要「跑一次脚本、记一次 FlowTracker、解析成三态」。
 * 若各写一份，就是同一语义的第二、第三份实现（CLAUDE.md 单一实现纪律）。
 */
import type { BootstrapState } from '../selfBootstrap.ts';
import {
  parseEvalScore,
  parseEvalOutcome,
  parseGateOutcome,
  type ScriptOutcome,
} from './scriptParsers.ts';
import { loadFlowTracker } from './flowTracker.ts';
import { invokeTracked } from './selfBootstrapFlow.ts';
import { applyPhase } from './bootstrapPhase.ts';
import { BOOTSTRAP_STEP_TIMEOUT_MS } from './bootstrapBudget.ts';
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
    // cycle-108：预算取**单一事实源**（240s）。cycle-96 把这份执行体从 routes 下沉到
    // runtime 时，位置参数 `60000` 被原样搬过来——它不是"函数默认值"形态，所以
    // bootstrapBudget 的静态守卫（扫 `timeoutMs = 60000`）**扫不到**，于是 P0-BOOTSTRAP-STEP-TIMEOUT
    // 在 HTTP 路由路径上静默复发（真机实测：POST /anic/self/evaluate 恰在 60.03s 被掐断，
    // outcome=not-run / exit=-1）。工具路径用的是 240s，两条路径预算不一致 = 同一语义两份真相。
    target.scriptsDir, 'eval-runner', [], target.roots, BOOTSTRAP_STEP_TIMEOUT_MS, trackerState, target.cyclesDir,
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
    // 同上：gate-check 会跑构建（单次 120s 上限）+ 读全部门禁证据，60s 同样不够。
    target.scriptsDir, 'gate-check', args, target.roots, BOOTSTRAP_STEP_TIMEOUT_MS, trackerState, target.cyclesDir,
  );
  const outcome = parseGateOutcome(result);
  return { result, flowId, verdict: outcome.verdict, outcome };
}
