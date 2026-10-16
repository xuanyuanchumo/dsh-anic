/**
 * 原生实现路由（7 脚本原生等价物）：
 * POST /anic/hitl-audit · GET /anic/band-detect · GET /anic/org-status
 * GET /anic/fact-base · GET /anic/plan-sync · POST /anic/multi-agent-gate · POST /anic/fix-loop
 */
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { runHitlAudit } from '../governance/hitlAudit.ts';
import { runBandDetection, loadBandHistory } from '../evolution/bandDetector.ts';
import { runOrgStatus } from '../evolution/orgStatus.ts';
import { runFactBaseVerify } from '../governance/factBaseVerify.ts';
import { runPlanSync } from '../governance/planSync.ts';
import { runAllGates } from '../llm/multiAgentGate.ts';
import { collectGateEvidence, latestConvergenceVerdicts, CONVERGENCE_GATES } from '../llm/gateEvidence.ts';
import { runFixLoop } from '../evolution/fixLoop.ts';
import { verifyLedger } from '../runtime/ledger.ts';
import type { AgentCard } from '../agents.ts';

const log = createScoped('anic:route:native');

interface SendFn { (res: unknown, status: number, body: unknown, requestId?: string): void; }

/** 注册原生实现路由（7 脚本原生等价物）。 */
export function registerNativeRoute(
  ctx: unknown,
  deps: { send: SendFn; getWorkspaceRoot: (req?: unknown) => string | null; agentCards: Map<string, AgentCard> },
): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: { register: (opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void } }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const disposers: Array<(() => void) | null> = [];

  const reg = (method: string, path: string, handler: (req: unknown, res: unknown) => void) => {
    const d = ws.register({ kind: 'exact', path, handler });
    disposers.push(typeof d === 'function' ? d : null);
  };

  // POST /anic/hitl-audit
  reg('POST', '/anic/hitl-audit', (_req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runHitlAudit(root);
    deps.send(res, 200, result, rid);
  });

  // GET /anic/band-detect?score=0.75
  reg('GET', '/anic/band-detect', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const r = req as { url?: string };
    const scoreMatch = r?.url?.match(/score=([0-9.]+)/);
    const parsed = scoreMatch?.[1] ? parseFloat(scoreMatch[1]) : 1.0;
    const score = Math.max(0, Math.min(1, parsed)); // 限制 [0, 1] 范围
    const result = runBandDetection(root, score);
    deps.send(res, 200, result, rid);
  });

  // GET /anic/org-status
  reg('GET', '/anic/org-status', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runOrgStatus(root, {});
    deps.send(res, 200, result, rid);
  });

  // GET /anic/fact-base
  reg('GET', '/anic/fact-base', (_req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runFactBaseVerify(root);
    deps.send(res, 200, result, rid);
  });

  // GET /anic/plan-sync
  reg('GET', '/anic/plan-sync', (_req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runPlanSync(root);
    deps.send(res, 200, result, rid);
  });

  // POST /anic/multi-agent-gate
  //
  // P0-2（已修）：此前传 `evidenceByGate = {}` —— 五个门全部零证据，
  // `heuristicEvaluate` 恒 `doubt`，「多门评审」在真实工作区从未产出过一次
  // 有效裁决。现改为由 `collectGateEvidence()` 从**真实工件与真实账本**装配
  // 结构化证据（带 PASS/FAIL 三态）。缺失的工件产出 FAIL 而非静默跳过：
  // 「门禁要求的东西不存在」是确定的失败事实（INV-23）。
  reg('POST', '/anic/multi-agent-gate', (_req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const evidenceByGate = collectGateEvidence(root);
    const results = runAllGates(deps.agentCards, evidenceByGate);
    deps.send(
      res,
      200,
      {
        gates: results,
        allPassed: results.every((g) => g.passed),
        evidenceCounts: Object.fromEntries(Object.entries(evidenceByGate).map(([k, v]) => [k, v.length])),
      },
      rid,
    );
  });

  // POST /anic/fix-loop { verifyCommand?: string }
  //
  // 验证函数不再用 `existsSync(ledger.json)` 充数（那是「文件在即通过」的伪自信：
  // 账本被篡改、链断裂、G0-G3 从未记录，都照样报 all checks passed）。
  // 改为消费真实事实：哈希链校验 + G0-G3 收敛门最新裁决全绿。
  reg('POST', '/anic/fix-loop', (_req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot();
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const cyclesDir = join(root, '.cycles');
    const verifyFn = () => {
      const chain = verifyLedger(cyclesDir);
      const verdicts = latestConvergenceVerdicts(cyclesDir);
      const missing = CONVERGENCE_GATES.filter((g) => verdicts.get(g) !== 'PASS');
      const passed = chain.ok && missing.length === 0;
      const parts: string[] = [];
      if (!chain.ok) parts.push(`账本链断裂：${chain.reason ?? '未知'}（${String(chain.total)} 条）`);
      if (missing.length > 0) parts.push(`收敛门未全绿，缺失：${missing.join(', ')}`);
      return {
        passed,
        report: passed ? `哈希链校验通过（${String(chain.total)} 条）+ G0-G3 全绿` : parts.join('；'),
      };
    };
    const result = runFixLoop(root, verifyFn);
    deps.send(res, 200, result, rid);
  });

  return disposers;
}
