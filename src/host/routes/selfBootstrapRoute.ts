/**
 * Self-bootstrap routes — dsh-anic evaluates itself using the skill.
 * M7: self/evaluate + self/iterate + self/gate-check + self/status
 */

import path from 'node:path';
import fs from 'node:fs';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import { resolveWorkspaceRoots, sendJson } from '../snapshotRoute.ts';
import {
  type BootstrapState,
  type BootstrapTrigger,
  loadBootstrapState,
  saveBootstrapState,
  advanceBootstrap,
  initialBootstrapState,
  transitionBootstrap,
} from '../selfBootstrap.ts';
import {
  resolveSkillScriptsDir,
  invokeSkillScript,
} from '../skillInvoker.ts';
import { verifyLedger } from '../runtime/ledger.ts';
// cycle-96：解析器移至 runtime/scriptParsers.ts 单一实现
// （本文件原有一份重复实现，与 bootstrapOrchestrator 的旧版一样按虚构格式解析）
import { parseEvalScore, parseGateVerdict } from '../runtime/scriptParsers.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

/**
 * 相位推进（唯一写 status 的入口，cycle-38）。
 *
 * 旧实现直接 `state.status = 'EVALUATING'` 改写字段，绕过状态机：
 *   - 非法转移（如从未评估直接跳 FIXING）无人拒绝；
 *   - `VERIFYING` 全仓零赋值，声明了却不可达。
 * 现在一律走 `transitionBootstrap`（表驱动，非法即拒绝），拒绝时**响亮**返回
 * 原因而不是静默继续——路由是裁决面，不能把非法转移伪装成成功。
 */
function applyPhase(
  cyclesDir: string,
  state: BootstrapState,
  trigger: BootstrapTrigger,
  patch?: Partial<Pick<BootstrapState, 'lastEvalScore' | 'lastGateVerdict'>>,
): { state: BootstrapState; rejected: string | null } {
  const moved = transitionBootstrap(state, trigger, patch);
  if (!moved.ok) return { state, rejected: moved.reason };
  saveBootstrapState(cyclesDir, moved.state);
  return { state: moved.state, rejected: null };
}

function getLatestCycleDir(cyclesDir: string): string | null {
  const cyclesRoot = path.join(cyclesDir, 'cycles');
  if (!fs.existsSync(cyclesRoot)) return null;
  const dirs = fs.readdirSync(cyclesRoot)
    .filter(d => /^cycle-\d+$/.test(d))
    .map(d => ({ name: d, num: parseInt(d.replace('cycle-', ''), 10) }))
    .sort((a, b) => b.num - a.num);
  return dirs.length > 0 ? path.join(cyclesRoot, dirs[0]!.name) : null;
}

/** 注册自举路由（evaluate/gate-check/iterate/status）。 */
export function registerSelfBootstrapRoutes(
  ctx: SnapshotCtx,
  send: SendFn,
): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws?.register) return [];

  const reg = (p: string, handler: (req: RouteReq, res: unknown) => void) => {
    const d = ws.register!({ kind: 'exact', path: p, handler: handler as (req: unknown, res: unknown) => void });
    return typeof d === 'function' ? d : null;
  };

  return [
    // POST /anic/self/evaluate — run eval-runner on dsh-anic itself
    reg('/anic/self/evaluate', (_req, res) => {
      const roots = resolveWorkspaceRoots(ctx);
      if (!roots) { send(res, 500, { error: 'no workspace' }); return; }
      const cyclesDir = path.join(roots, '.cycles');
      const scriptsDir = resolveSkillScriptsDir(roots);
      if (!scriptsDir) { send(res, 404, { error: 'skill scripts not found' }); return; }

      const result = invokeSkillScript(scriptsDir, 'eval-runner', [], roots, 60000);
      const score = parseEvalScore(result);

      // 相位推进：走状态机（唯一写 status 的入口），非法即响亮返回原因
      const state = loadBootstrapState(cyclesDir);
      const phase = applyPhase(cyclesDir, state, 'start', { lastEvalScore: score });

      send(res, 200, {
        exitCode: result.exitCode,
        score,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        status: phase.state.status,
        rejected: phase.rejected,
      });
    }),

    // POST /anic/self/gate-check — run gate-check on dsh-anic itself
    reg('/anic/self/gate-check', (_req, res) => {
      const roots = resolveWorkspaceRoots(ctx);
      if (!roots) { send(res, 500, { error: 'no workspace' }); return; }
      const cyclesDir = path.join(roots, '.cycles');
      const scriptsDir = resolveSkillScriptsDir(roots);
      if (!scriptsDir) { send(res, 404, { error: 'skill scripts not found' }); return; }

      const result = invokeSkillScript(
        scriptsDir, 'gate-check',
        ['--gate', 'all', '--quality', '--record'],
        roots, 60000,
      );
      const verdict = parseGateVerdict(result);

      const state = loadBootstrapState(cyclesDir);
      const phase = applyPhase(cyclesDir, state, 'eval-done', { lastGateVerdict: verdict });

      send(res, 200, {
        exitCode: result.exitCode,
        verdict,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        timedOut: result.timedOut,
        status: phase.state.status,
        rejected: phase.rejected,
      });
    }),

    // POST /anic/self/iterate — full micro-iteration (eval→gate→tech-debt)
    reg('/anic/self/iterate', (req, res) => {
      void readBody(req).then((body) => {
      const maxRounds = typeof body.maxRounds === 'number' ? body.maxRounds : 3;

      const roots = resolveWorkspaceRoots(ctx);
      if (!roots) { send(res, 500, { error: 'no workspace' }); return; }
      const cyclesDir = path.join(roots, '.cycles');
      const scriptsDir = resolveSkillScriptsDir(roots);
      if (!scriptsDir) { send(res, 404, { error: 'skill scripts not found' }); return; }

      let state = loadBootstrapState(cyclesDir);
      if (state.status === 'CONVERGED' || state.status === 'EXHAUSTED') {
        state = initialBootstrapState(maxRounds);
      }
      state.maxRounds = maxRounds;

      // Step 1: Evaluate —— 相位 EVALUATING（状态机写，落盘可观测）
      state = applyPhase(cyclesDir, state, 'start').state;
      const evalResult = invokeSkillScript(scriptsDir, 'eval-runner', [], roots, 60000);
      const evalScore = parseEvalScore(evalResult);

      // Step 2: Gate check —— 相位 GATE_CHECKING
      state = applyPhase(cyclesDir, state, 'eval-done', { lastEvalScore: evalScore }).state;
      const gateResult = invokeSkillScript(
        scriptsDir, 'gate-check',
        ['--gate', 'all', '--quality', '--record'],
        roots, 60000,
      );
      const gateVerdict = parseGateVerdict(gateResult);

      // Step 3: If FAIL, produce tech-debt proposal (do NOT self-modify code — R-31)
      let fixApplied: string | null = null;
      if (gateVerdict !== 'PASS' && gateVerdict !== 'approve') {
        // 相位 FIXING：只在 GATE_CHECKING 起点合法（顺序错误会被状态机拒绝）
        state = applyPhase(cyclesDir, state, 'gate-fail', { lastGateVerdict: gateVerdict }).state;
        // Write tech-debt proposal (not a code fix)
        const techDebtDir = path.join(cyclesDir, 'tech-debt');
        if (!fs.existsSync(techDebtDir)) fs.mkdirSync(techDebtDir, { recursive: true });
        const proposal = {
          round: state.round + 1,
          evalScore,
          gateVerdict,
          gateStderr: gateResult.stderr.slice(0, 2000),
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
        const tdPath = path.join(cyclesDir, fixApplied);
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
      const ledgerVerify = verifyLedger(cyclesDir);
      verification.ledgerValid = ledgerVerify.ok;
      verification.ledgerEntries = ledgerVerify.total;
      if (!ledgerVerify.ok) {
        verification.failed = [...(verification.failed ?? []), `ledger chain broken at index ${String(ledgerVerify.brokenAt)} (${ledgerVerify.reason})`];
      }

      // Step 4: Advance state
      state = advanceBootstrap(state, evalScore, gateVerdict, fixApplied);
      saveBootstrapState(cyclesDir, state);

      send(res, 200, {
        status: state.status,
        round: state.round,
        maxRounds: state.maxRounds,
        evalScore,
        gateVerdict,
        fixApplied,
        techDebtProposals: fixApplied ? [fixApplied] : [],
        verification,
        converged: state.status === 'CONVERGED',
        exhausted: state.status === 'EXHAUSTED',
      });
      });
    }),

    // GET /anic/self/status — bootstrap state
    reg('/anic/self/status', (_req, res) => {
      const roots = resolveWorkspaceRoots(ctx);
      if (!roots) { send(res, 500, { error: 'no workspace' }); return; }
      const cyclesDir = path.join(roots, '.cycles');
      const state = loadBootstrapState(cyclesDir);
      send(res, 200, state);
    }),
  ];
}
