/**
 * Flows 域 DSH 工具网关（R3 阶段 2/3；T3 ≤250 行一域一文件）。
 *
 * anic_flows_gate_check —— 经 FlowMachine 状态流转机运行 G0-G3 收敛门。
 * 三模式：script（正典脚本路径）/ native（原生引擎 + 插件侧账本）/
 * diff（双跑对账，观测两侧判定是否分叉——双真相源守卫的运行时形态）。
 *
 * anic_flows_advance —— 宏观六相推进（R3 阶段 3：plan→design→build→test→
 * deploy→maintain 单向流转；守卫 = 当前相门禁曾在账本 PASS）。
 *
 * anic_flows_archive —— 归档流程（R3 阶段 3 后半：--cycle N 归档已完成循环 /
 * clean 清理旧归档 / list 清单；完成判定与 G1 共用同一任务行解析器——
 * 「G1 说完成、归档说没完成」分叉的根治面；账本只追加永不触碰 INV-9）。
 *
 * 模型可调用 = DSH 轨迹可见（tool/call + tool/result）；状态推进进
 * .cycles/flows/*.json 投影（GET /anic/flows/state 可查）。
 */
import { genericCall, genericResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runGateFlow, type GateFlowMode } from './flows/gateCheckFlow.ts';
import { runMacroPhaseFlow, type MacroFlowMode } from './flows/macroPhaseFlow.ts';
import { runArchiveFlow } from './flows/archiveFlow.ts';
import { PHASE_IDS } from './flows/macroPhaseEngine.ts';
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

  // Tool: anic_flows_advance — 宏观六相推进（R3 阶段 3）
  disposers.push(deps.register({
    name: 'anic_flows_advance',
    description:
      'Advance the ANIC macro phase state machine (plan -> design -> build -> test -> deploy -> maintain, forward-only). '
      + 'The guard requires the current phase convergence gate(s) to have PASS entries in the gate ledger (G0 for plan/design, G1 for build, G2 for test, G3 for deploy). '
      + 'mode=script runs the canonical skill workflow-state script (default); mode=native runs the TypeScript engine + flow machine. '
      + 'dryRun=true (native only) reports the would-be transition without writing. '
      + 'Returns from/to phase, next gates, and transition events.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        target: { type: 'string', description: 'Explicit target phase (forward-only); omit for next phase' },
        mode: { type: 'string', description: 'Execution mode: script (default) or native' },
        dryRun: { type: 'boolean', description: 'Compute without writing (native mode only). Default: false' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_flows_advance', 'other', {
        workspace: args.workspace ?? '.',
        target: args.target ?? 'next',
        mode: args.mode ?? 'script',
      }),
    presentResult: (_args, result) =>
      genericResult(`anic_flows_advance: ${result.ok === true ? `${String(result.from)}->${String(result.to ?? result.state)}` : 'blocked'}`),
    execute: async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const target = typeof args.target === 'string' ? args.target : undefined;
      if (target !== undefined && !PHASE_IDS.includes(target)) {
        return { error: `invalid target phase "${target}" (expected one of: ${PHASE_IDS.join(', ')})` };
      }
      const mode = typeof args.mode === 'string' && ['script', 'native'].includes(args.mode)
        ? args.mode as MacroFlowMode
        : 'script';
      if (args.dryRun === true && mode === 'script') {
        return { error: 'dryRun is only supported with mode=native' };
      }
      const result = runMacroPhaseFlow(ws, { target, mode, dryRun: args.dryRun === true, timeoutMs: 120000 });
      return {
        ok: result.ok,
        from: result.from ?? null,
        to: result.to ?? null,
        phase: result.state,
        message: result.message,
        nextGates: result.nextGates ?? [],
        ...(result.final === true ? { final: true } : {}),
        ...(result.dryRun === true ? { dryRun: true } : {}),
        ...(result.drift === true ? { drift: true } : {}),
        events: result.events,
        ...(result.stdout !== undefined ? { stdout: result.stdout.slice(0, 8000) } : {}),
      };
    },
  }) ?? null);

  // Tool: anic_flows_archive — 归档流程（R3 阶段 3 后半）
  disposers.push(deps.register({
    name: 'anic_flows_archive',
    description:
      'Run the ANIC archive flow: archive a completed cycle (cycle=N), clean old archives (clean=true, keep=<N> default 5), '
      + 'or list the cycle inventory (list=true / no arguments). '
      + 'Completeness uses the SAME task-row parser as gate G1 (no G1-says-done-but-archive-disagrees fork). '
      + 'The gate ledger is never touched (append-only hash chain). '
      + 'mode=native (default) runs the TypeScript engine; mode=script runs the canonical skill archive-cycle script. '
      + 'Returns ok, affected cycles, flow state (IDLE/RUNNING/DONE/BLOCKED) and the human-readable refusal message on failure.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        cycle: { type: 'number', description: 'Cycle number to archive (e.g. 7 for cycle-7); requires all tasks complete' },
        clean: { type: 'boolean', description: 'Clean old archives beyond the keep limit (destructive to archived dirs only). Default: false' },
        keep: { type: 'number', description: 'Number of recent archives to keep when clean=true (default: 5)' },
        list: { type: 'boolean', description: 'Return the cycle inventory (read-only). Default when no cycle/clean given' },
        mode: { type: 'string', description: 'Execution mode: native (default) or script' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_flows_archive', 'other', {
        workspace: args.workspace ?? '.',
        action: args.cycle !== undefined ? `cycle-${String(args.cycle)}`
          : args.clean === true ? `clean(keep ${String(args.keep ?? 5)})`
          : 'list',
        mode: args.mode ?? 'native',
      }),
    presentResult: (_args, result) =>
      genericResult(`anic_flows_archive: ${result.ok === true ? `${String(result.action)} ok (${(result.affected as string[] | undefined)?.length ?? 0} affected)` : 'blocked'}`),
    execute: async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      if (args.cycle !== undefined && typeof args.cycle !== 'number') return { error: 'cycle must be a number' };
      if (args.keep !== undefined && typeof args.keep !== 'number') return { error: 'keep must be a number' };
      const result = runArchiveFlow(ws, {
        cycle: typeof args.cycle === 'number' ? args.cycle : undefined,
        clean: args.clean === true,
        keep: typeof args.keep === 'number' ? args.keep : undefined,
        list: args.cycle === undefined && args.clean !== true,
        mode: args.mode === 'script' ? 'script' : 'native',
        timeoutMs: 60000,
      });
      return {
        ok: result.ok,
        action: result.action,
        flowState: result.state,
        message: result.message,
        affected: result.affected,
        ...(result.inventory !== undefined ? { inventory: result.inventory } : {}),
        events: result.events,
        ...(result.ok !== true ? { error: result.message } : {}),
        ...(result.stdout !== undefined ? { stdout: result.stdout.slice(0, 8000) } : {}),
      };
    },
  }) ?? null);

  return disposers;
}
