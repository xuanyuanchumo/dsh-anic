/**
 * HITL 三段修复 DSH 工具网关（R3 阶段 4 后半；T3 ≤250 行一域一文件）。
 *
 * anic_flows_hitl —— HITL 三段修复流程（Phase0 审计 → Phase1 修复 → Phase2 重审）。
 * 两模式：native（TypeScript hitlThreePhase，缺省）/ script（正典技能 hitl-audit.mjs）。
 * 判定语义：pass（exit 0）/ fail（exit 1）/ circuit（exit 2，BLOCKED——需要人类介入，
 * suggestedNextStep=autonomy-fallback）。
 *
 * 模型可调用 = DSH 轨迹可见（tool/call + tool/result）；状态推进进
 * .cycles/flows/hitl.json 投影（GET /anic/flows/state?flow=hitl 可查）。
 */
import { genericCall, genericResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runHitlFlow, type HitlGateArg } from './flows/hitlFlow.ts';
import { validateWorkspace } from './skillInvoker.ts';

export interface HitlGatewayDeps {
  getRoot: () => string | null;
  register: (tool: ToolRegistration) => (() => void) | null | undefined;
}

/** 注册 HITL 三段修复工具。返回 disposer 数组（与 toolsFlowsGateway 同款聚合约定）。 */
export function registerHitlTools(tools: ToolsSlot, deps: HitlGatewayDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_flows_hitl — HITL 三段修复流程（R3 阶段 4 后半，第 16 工具）
  disposers.push(deps.register({
    name: 'anic_flows_hitl',
    description:
      'Run the ANIC HITL three-phase flow: Phase 0 audits H1-H4 (sensitive-data protection, rollback safety, gate-green, ledger arbitration), '
      + 'Phase 1 attempts automatic fixes for circuit-broken gates ONLY (e.g. .gitignore patterns, git baseline, audit log creation), '
      + 'Phase 2 re-audits fixed gates; still-circuit gates get an incident file and suggestedNextStep=autonomy-fallback. '
      + 'Verdicts: pass (exit 0), fail (exit 1), circuit (exit 2 -> BLOCKED, needs human intervention). '
      + 'H4 ledger conflicts are NEVER auto-fixed (ledger is append-only; hash chain would break). '
      + 'mode=native (default) runs the TypeScript engine; mode=script runs the canonical skill hitl-audit script. '
      + 'gate=all (default) or a single gate H1/H2/H3/H4. Returns per-gate checks, fixes, rechecks, incidents and flow events.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        gate: { type: 'string', description: 'Gate to audit: H1, H2, H3, H4 or all (default: all)' },
        mode: { type: 'string', description: 'Execution mode: native (default) or script' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_flows_hitl', 'other', {
        workspace: args.workspace ?? '.',
        gate: args.gate ?? 'all',
        mode: args.mode ?? 'native',
      }),
    presentResult: (_args, result) =>
      genericResult(`anic_flows_hitl: ${String(result.verdict ?? '?')} (${String(result.state ?? '?')})`
        + (result.suggestedNextStep === 'autonomy-fallback' ? ' -> autonomy-fallback suggested' : '')),
    execute: async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const gateRaw = typeof args.gate === 'string' ? args.gate : 'all';
      if (gateRaw !== 'all' && !/^H[1-4]$/.test(gateRaw)) {
        return { error: `invalid gate "${gateRaw}" (expected H1-H4 or all)` };
      }
      const gate: HitlGateArg = gateRaw === 'H1' || gateRaw === 'H2' || gateRaw === 'H3' || gateRaw === 'H4' ? gateRaw : 'all';
      const result = runHitlFlow(ws, {
        gate,
        mode: args.mode === 'script' ? 'script' : 'native',
        timeoutMs: 60000,
      });
      return {
        verdict: result.verdict,
        exitCode: result.exitCode,
        flowState: result.state,
        checks: result.checks,
        circuits: result.circuits,
        fixes: result.fixes,
        rechecks: result.rechecks,
        incidents: result.incidents,
        auditLogPath: result.auditLogPath,
        ...(result.suggestedNextStep !== null ? { suggestedNextStep: result.suggestedNextStep } : {}),
        events: result.events,
        ...(result.verdict !== 'pass' ? { error: result.error } : {}),
        ...(result.stdout !== undefined ? { stdout: result.stdout.slice(0, 8000) } : {}),
      };
    },
  }) ?? null);

  return disposers;
}
