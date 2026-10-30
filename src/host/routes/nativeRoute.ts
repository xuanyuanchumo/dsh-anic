/**
 * 原生实现路由（7 脚本原生等价物）：
 * POST /anic/hitl-audit · GET /anic/band-detect · GET /anic/org-status
 * GET /anic/fact-base · GET /anic/plan-sync · POST /anic/multi-agent-gate · POST /anic/fix-loop
 */
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { runHitlAudit } from '../governance/hitlAudit.ts';
import { runBandDetection } from '../evolution/bandDetector.ts';
import { runOrgStatus } from '../evolution/orgStatus.ts';
import { runFactBaseVerify } from '../governance/factBaseVerify.ts';
import { runPlanSync } from '../governance/planSync.ts';
import { runAllGatesWithLlm } from '../llm/multiAgentTier2.ts';
import { collectGateEvidence, latestConvergenceVerdicts, CONVERGENCE_GATES } from '../llm/gateEvidence.ts';
import { runFixLoop } from '../evolution/fixLoop.ts';
import { verifyLedger } from '../runtime/ledger.ts';
import { loadWorkspaceConfig } from '../config.ts';
import type { AgentCard } from '../agents.ts';

const log = createScoped('anic:route:native');

interface SendFn { (res: unknown, status: number, body: unknown, requestId?: string): void; }

/** 注册原生实现路由（7 脚本原生等价物）。 */
export function registerNativeRoute(
  ctx: unknown,
  deps: {
    send: SendFn;
    getWorkspaceRoot: (req?: unknown) => string | null;
    agentCards: Map<string, AgentCard>;
    /** 工作区层开关态（cycle-91：`agentsOrchestration` 的真实值来源）。 */
    loadFlows?: () => { selfInit: boolean; agentsOrchestration: boolean };
  },
): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: { register: (opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void } }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const disposers: Array<(() => void) | null> = [];

  const reg = (method: string, path: string, handler: (req: unknown, res: unknown) => void) => {
    const d = ws.register({ kind: 'exact', path, handler });
    disposers.push(typeof d === 'function' ? d : null);
  };

  // POST /anic/hitl-audit
  // getWorkspaceRoot(req)（cycle-21）：全部 7 路由统一带 req——X-ANIC-Workspace
  // 头参与解析（桌面多会话纠偏，见 snapshotRoute P2 注）。此前仅 org-status
  // 带 req，band-detect 等写侧路由在多会话宿主上会写到首条会话的工作区
  // （cycle-21 真机实测：header 声明 dsh-anic，band-history 却写进 codegraph）。
  reg('POST', '/anic/hitl-audit', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runHitlAudit(root);
    deps.send(res, 200, result, rid);
  });

  // GET /anic/band-detect?score=0.75
  reg('GET', '/anic/band-detect', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
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
    const root = deps.getWorkspaceRoot(req); // cycle-20 起带头；cycle-21 全域统一
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    // cycle-91：把工作区层的开关态喂进去 —— 否则 `agentsOrchestration` 的
    // `?? {true,true}` 兜底恒真 ⇒ 面板永远显示「启用」。
    const result = runOrgStatus(root, { flows: deps.loadFlows?.() ?? { selfInit: true, agentsOrchestration: true } });
    deps.send(res, 200, result, rid);
  });

  // GET /anic/fact-base
  reg('GET', '/anic/fact-base', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const result = runFactBaseVerify(root);
    deps.send(res, 200, result, rid);
  });

  // GET /anic/plan-sync
  reg('GET', '/anic/plan-sync', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
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
  //
  // R3 阶段 1：currentBand 从 config.yml（INV-25 唯一 loader）读出后传入
  // runAllGates —— 卡片授权带超出当前自主级的 agent 以 SELF_REFUSAL 拒绝
  // 出裁决（此前授权带只有字段没有执行点）。
  //
  // R3 阶段 4 前半（cycle-9）：runAllGates → runAllGatesWithLlm。probeLlm
  // 可用时逐门逐角色跑真 LLM 评审（Tier-2），不可用整体降级 Tier-1 并在
  // summary.tier 诚实标注。handler 因此 async（webServer 槽位支持异步）。
  reg('POST', '/anic/multi-agent-gate', async (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) return deps.send(res, 404, { error: 'no workspace' }, rid);
    const evidenceByGate = collectGateEvidence(root);
    const currentBand = loadWorkspaceConfig(join(root, '.cycles')).values.autonomyLevel;
    const { results, summary } = await runAllGatesWithLlm(ctx, deps.agentCards, evidenceByGate, { currentBand });
    deps.send(
      res,
      200,
      {
        gates: results,
        allPassed: results.every((g) => g.passed),
        currentBand,
        evidenceCounts: Object.fromEntries(Object.entries(evidenceByGate).map(([k, v]) => [k, v.length])),
        summary,
      },
      rid,
    );
  });

  // POST /anic/fix-loop { verifyCommand?: string }
  //
  // 验证函数不再用 `existsSync(ledger.json)` 充数（那是「文件在即通过」的伪自信：
  // 账本被篡改、链断裂、G0-G3 从未记录，都照样报 all checks passed）。
  // 改为消费真实事实：哈希链校验 + G0-G3 收敛门最新裁决全绿。
  reg('POST', '/anic/fix-loop', (req, res) => {
    const rid = newRequestId();
    const root = deps.getWorkspaceRoot(req);
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
