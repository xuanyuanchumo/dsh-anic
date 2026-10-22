/**
 * POST /anic/self/iterate 端点（cycle-72 T3 拆分：路由文件超 250 行上限）。
 *
 * 由 evaluate + gate-check 组成的微迭代：eval → gate → （未过）产 tech-debt 提案。
 * 承 R-31：**绝不自我改码**，产物只有提案。
 *
 * cycle-72 三态闸门（本文件的核心修复）：只有 outcome 为 `failed`（真跑过、真没过）
 * 才产提案；`not-run`（脚本没跑成）只推进相位并在响应里响亮标注——不写 0 分提案。
 * 旧实现把两者折叠成 evalScore 0 + gateVerdict FAIL，于是两轮自举唯一的产物就是
 * 两份误导性的 `self-bootstrap-round-N.json`，且自举永无收敛可能。
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  loadBootstrapState,
  saveBootstrapState,
  advanceBootstrap,
  initialBootstrapState,
} from '../selfBootstrap.ts';
import { verifyLedger } from '../runtime/ledger.ts';
import { applyPhase } from '../runtime/bootstrapPhase.ts';
import { runEvalTracked, runGateTracked, type TrackTarget } from './selfBootstrapRunners.ts';
import type { SendFn } from './selfBootstrapShared.ts';

/** gate-check 的标准参数（--record 让判定落账本）。 */
export const ITERATE_GATE_ARGS: string[] = ['--gate', 'all', '--quality', '--record'];

export function handleSelfIterate(
  target: TrackTarget,
  send: SendFn,
  res: unknown,
  maxRounds: number,
): void {
  let state = loadBootstrapState(target.cyclesDir);
  if (state.status === 'CONVERGED' || state.status === 'EXHAUSTED') {
    state = initialBootstrapState(maxRounds);
  }
  state.maxRounds = maxRounds;

  // Step 1: Evaluate —— 相位 EVALUATING（状态机写，落盘可观测）+ FlowTracker 记账
  const evalStep = runEvalTracked(target, state);
  state = evalStep.phase.state;
  const evalScore = evalStep.score;

  // Step 2: Gate check —— 相位 GATE_CHECKING
  state = applyPhase(target.cyclesDir, state, 'eval-done', { lastEvalScore: evalScore }).state;
  const gateStep = runGateTracked(target, ITERATE_GATE_ARGS);
  const gateVerdict = gateStep.verdict;

  // Step 3: 提案闸门（见文件头三态说明）
  const notRun = gateStep.outcome.state === 'not-run' || evalStep.outcome.state === 'not-run';
  const gateFailed = gateVerdict !== 'PASS' && gateVerdict !== 'approve';
  let fixApplied: string | null = null;

  if (gateFailed) {
    // 相位 FIXING：只在 GATE_CHECKING 起点合法（顺序错误会被状态机拒绝）
    state = applyPhase(target.cyclesDir, state, 'gate-fail', { lastGateVerdict: gateVerdict }).state;
  }
  if (gateFailed && !notRun) {
    const techDebtDir = path.join(target.cyclesDir, 'tech-debt');
    if (!fs.existsSync(techDebtDir)) fs.mkdirSync(techDebtDir, { recursive: true });
    const proposal = {
      round: state.round + 1,
      evalScore,
      gateVerdict,
      // 三态如实落盘：磁盘上也能分辨「质量失败」与「没跑成」（可观测面验收）
      evalOutcome: evalStep.outcome,
      gateOutcome: gateStep.outcome,
      gateStderr: gateStep.result.stderr.slice(0, 2000),
      timestamp: new Date().toISOString(),
      source: 'self-bootstrap',
      action: 'REVIEW_REQUIRED — no auto code modification (R-31)',
    };
    const tdFile = path.join(techDebtDir, `self-bootstrap-round-${state.round + 1}.json`);
    fs.writeFileSync(tdFile, JSON.stringify(proposal, null, 2), 'utf-8');
    fixApplied = `tech-debt/self-bootstrap-round-${state.round + 1}.json`;
  }

  // Step 3b（cycle-40，cycle-39 债务 #7 收口）：Post-Verify 写后回读断言。
  // 此路由的「fix」是 tech-debt 提案而非代码修复（R-31），盲目 re-gate 重跑
  // 门禁不会变绿——正确的复检形态是结构原则 7（效果即记录）：
  //   1. tech-debt 落盘后回读（文件存在 + JSON 可解析 + round 匹配）；
  //   2. gate-check --record 落账后验证账本链完整（写侧证据闭环）。
  // 任一失败都会把 verification.failed 带在响应里——「写了」与「写成了」
  // 是两件事，效果未确认的动作不得在响应里报告为已确认。
  const verification: { techDebtVerified: boolean; ledgerValid: boolean; ledgerEntries: number; failed?: string[] } = {
    techDebtVerified: true,
    ledgerValid: true,
    ledgerEntries: 0,
  };
  if (fixApplied) {
    const tdPath = path.join(target.cyclesDir, fixApplied);
    try {
      const reread = JSON.parse(fs.readFileSync(tdPath, 'utf-8')) as { round?: number };
      if (reread.round !== state.round + 1) {
        verification.techDebtVerified = false;
        verification.failed = [`tech-debt reread round mismatch (expected ${state.round + 1}, got ${String(reread.round)})`];
      }
    } catch (e) {
      verification.techDebtVerified = false;
      verification.failed = [`tech-debt reread failed: ${e instanceof Error ? e.message : String(e)}`];
    }
  }
  const ledgerVerify = verifyLedger(target.cyclesDir);
  verification.ledgerValid = ledgerVerify.ok;
  verification.ledgerEntries = ledgerVerify.total;
  if (!ledgerVerify.ok) {
    verification.failed = [...(verification.failed ?? []), `ledger chain broken at index ${String(ledgerVerify.brokenAt)} (${ledgerVerify.reason})`];
  }

  // Step 4: Advance state
  state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied);
  saveBootstrapState(target.cyclesDir, state);

  send(res, 200, {
    status: state.status,
    round: state.round,
    maxRounds: state.maxRounds,
    evalScore,
    gateVerdict,
    fixApplied,
    // cycle-72 三态：eval/gate 各自如实报告「跑过没有」。
    // 未跑成时 techDebtProposals 必为空，调用方据此区分「质量失败（有提案可修）」
    // 与「没跑成（要修环境）」。
    evalOutcome: evalStep.outcome,
    gateOutcome: gateStep.outcome,
    notRun,
    // 两次脚本调用的 flowId 都如实上报——大模型可据此在 anic_status.flows 里逐条核对
    evalFlowId: evalStep.flowId,
    gateFlowId: gateStep.flowId,
    techDebtProposals: fixApplied ? [fixApplied] : [],
    verification,
    converged: state.status === 'CONVERGED',
    exhausted: state.status === 'EXHAUSTED',
  });
}
