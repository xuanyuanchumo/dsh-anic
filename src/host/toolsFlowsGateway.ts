/**
 * Flows 域 DSH 工具网关（R3 阶段 2；T3 ≤250 行一域一文件）。
 *
 * anic_flows_gate_check —— 经 FlowMachine 状态流转机运行 G0-G3 收敛门。
 * 三模式：script（正典脚本路径）/ native（原生引擎 + 插件侧账本）/
 * diff（双跑对账，观测两侧判定是否分叉——双真相源守卫的运行时形态）。
 *
 * 模型可调用 = DSH 轨迹可见（tool/call + tool/result）；状态推进进
 * .cycles/flows/gate-check.json 投影（GET /anic/flows/state 可查）。
 */
import { genericCall, genericResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runGateFlow, type GateFlowMode } from './flows/gateCheckFlow.ts';
import { validateWorkspace } from './skillInvoker.ts';

export interface FlowsGatewayDeps {
  getRoot: () => string | null;
  register: (tool: ToolRegistration) => (() => void) | null | undefined;
}

/** 注册 flows 域工具。返回 disposer 数组（与 toolsPointerGateway 同款聚合约定）。 */
export function registerFlowsTools(tools: ToolsSlot, deps: FlowsGatewayDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_flows_gate_check — 状态机化收敛门运行
  disposers.push(deps.register({
    name: 'anic_flows_gate_check',
    description:
      'Run G0-G3 convergence gates through the ANIC flow state machine. '
      + 'mode=script runs the canonical skill script (ledger of record); '
      + 'mode=native runs the native TypeScript engine (records to plugin ledger with same dedup semantics); '
      + 'mode=diff runs BOTH and reports any verdict drift between them (dual-source-of-truth guard). '
      + 'Returns per-gate verdicts, quality-gate verdicts, final flow state (IDLE/RUNNING/PASSED/FAILED) and transition events.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        gate: { type: 'string', description: 'Gate to check: G0, G1, G2, G3 or all (default: all)' },
        mode: { type: 'string', description: 'Execution mode: script (default), native, or diff' },
        quality: { type: 'boolean', description: 'Also run quality-gate dimensions (default: true)' },
        record: { type: 'boolean', description: 'Record verdicts to the gate ledger (script mode passes --record; native mode appends with dedup). Default: false' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_flows_gate_check', 'other', {
        workspace: args.workspace ?? '.',
        gate: args.gate ?? 'all',
        mode: args.mode ?? 'script',
      }),
    presentResult: (_args, result) =>
      genericResult(`anic_flows_gate_check: ${String(result.state ?? '?')} (${result.allPass === true ? 'all-pass' : 'has-fail'})`),
    execute: async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const gate = typeof args.gate === 'string' ? args.gate : 'all';
      if (gate !== 'all' && !/^G[0-3]$/.test(gate)) return { error: `invalid gate "${gate}" (expected G0-G3 or all)` };
      const mode = typeof args.mode === 'string' && ['script', 'native', 'diff'].includes(args.mode)
        ? args.mode as GateFlowMode
        : 'script';
      const result = runGateFlow(ws, {
        gate,
        mode,
        quality: args.quality !== false,
        record: args.record === true,
        timeoutMs: 120000,
      });
      if (result.error) return { error: result.error };
      return {
        flowState: result.state,
        mode: result.mode,
        allPass: result.allPass,
        exitCode: result.exitCode,
        gates: result.gates,
        quality: result.quality,
        events: result.events,
        ...(result.drift !== null ? { drift: result.drift } : {}),
        ...(result.recorded !== undefined ? { recorded: result.recorded } : {}),
        ...(result.fatal !== undefined ? { fatal: result.fatal } : {}),
        ...(result.stdout !== undefined ? { stdout: result.stdout.slice(0, 8000) } : {}),
      };
    },
  }) ?? null);

  return disposers;
}
