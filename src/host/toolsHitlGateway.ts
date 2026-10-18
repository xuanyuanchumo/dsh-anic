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
import { genericCall, genericResult, normalizeToolResult } from './presentation.ts';
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
    // SDO：触发条件 = HITL 审计发现熔断门需要「先修复后降级」处置、或要跑三段修复流程；
    // 与 anic_hitl 区分：本工具执行修复流程（native 引擎/正典脚本），非路由指针。
    description: 'Use when HITL-audited gates are circuit-broken and need the three-phase repair flow '
      + '(audit → auto-fix circuit gates → re-audit), or a full HITL audit with repair semantics is needed. '
      + 'H4 ledger conflicts stay BLOCKED (append-only, human-only). Triggers: HITL 修复 / '
      + '三段修复 / hitl circuit / 修复后降级.',
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
    presentResult: (_args, result) => {
      // cycle-22：官方 {content,isError,meta} 形状归一化（双形状兼容见 normalizeToolResult）
      const r = normalizeToolResult(result);
      return genericResult(`anic_flows_hitl: ${String(r.verdict ?? '?')} (${String(r.state ?? '?')})`
        + (r.suggestedNextStep === 'autonomy-fallback' ? ' -> autonomy-fallback suggested' : ''));
    },
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
