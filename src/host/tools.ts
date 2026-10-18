/**
 * DSH tool registration — exposes dsh-anic capabilities as DSH tools
 * that other sessions/agents can invoke (M8 G-TOOL).
 * INV-24: 'tools' in inject but we probe ctx.get('tools', false) for graceful degradation.
 */
import { resolveWorkspaceRoots, type SnapshotCtx } from './snapshotRoute.ts';
import { registerSkillGatewayTools } from './toolsSkillGateway.ts';
import { registerBootstrapGatewayTools } from './toolsBootstrapGateway.ts';
import type { ToolsSlot } from './toolsSlot.ts';
import { resolveSkillScriptsDir, invokeSkillScriptAsync, validateWorkspace, inlineSkillRoot } from './skillInvoker.ts';
import { skillIntegritySummary } from './skillIntegrity.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadFlowTracker, recentFlows, flowStats } from './runtime/flowTracker.ts';
import { analyzeSkillHealth, formatHealthSummary } from './runtime/continuousLearning.ts';
import {
  evaluatePresentCall,
  iteratePresentCall,
  statusPresentCall,
  terminalResult,
} from './presentation.ts';
import { makeToolOutput } from './toolsSlot.ts';
import { registerPointerTools } from './toolsPointerGateway.ts';
import { registerEvolutionTools } from './toolsEvolutionGateway.ts';
import { registerFlowsTools } from './toolsFlowsGateway.ts';
import { registerHitlTools } from './toolsHitlGateway.ts';
import { registerAutoFixTools } from './toolsAutoFixGateway.ts';

interface HostContext {
  tools?: ToolsSlot;
  get?: <T = unknown>(key: string, strict?: boolean) => T | undefined;
}

/** 注册 ANIC DSH 工具（evaluate/gate/skill 等）。 */
export function registerAnicTools(ctx: unknown): (() => void) | null {
  const c = ctx as HostContext;

  // INV-24: probe tools slot, don't hard-fail if absent
  let tools: ToolsSlot | undefined;
  if (c.tools) {
    tools = c.tools;
  } else if (typeof c.get === 'function') {
    tools = c.get<ToolsSlot>('tools', false);
  }
  if (!tools?.register) return null;

  const disposers: Array<(() => void) | null> = [];

  const getRoot = (): string | null => {
    try {
      return resolveWorkspaceRoots(c as SnapshotCtx);
    } catch {
      return null;
    }
  };

  // Tool: anic_evaluate — evaluate a project
  disposers.push(tools.register({
    name: 'anic_evaluate',
    // SDO 纪律（superpowers writing-skills）：description 只写触发条件与症状，不总结工作流，
    // 防 agent 抄 description 捷径而不读工具/技能正文。触发词双语覆盖中英文查询。
    description: 'Use when an ANIC-managed project needs its quality evaluation report — e.g. starting a cycle, '
      + 'refreshing a stale baseline, or gates need fresh evidence. '
      + 'Triggers: 评估 / evaluation / eval report / E1-E8 / Q1-Q8 / 质量基线.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        dimensions: { type: 'string', description: 'Comma-separated dimension IDs (e.g. E1,E2,E3)' },
      },
    },
    presentCall: evaluatePresentCall,
    // cycle-22：terminalResult 内置 normalizeToolResult 双形状归一化
    presentResult: (_args, result) => terminalResult(result, 'anic_evaluate ✓'),
    // P1-EXEC-SIGNAL：execute 第二参 exec 携带宿主 AbortSignal（官方契约「遵守
    execute: async (args, exec) => {
      const ws = (args.workspace as string) ?? getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const scriptsDir = resolveSkillScriptsDir(ws);
      if (!scriptsDir) return { error: 'skill scripts not found' };
      const dimArgs = args.dimensions ? ['--dimensions', args.dimensions as string] : [];
      const result = await invokeSkillScriptAsync(scriptsDir, 'eval-runner', dimArgs, ws, 60000, { signal: exec?.signal });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 8000),
        stderr: result.stderr.slice(0, 4000),
        timedOut: result.timedOut,
        ...(result.aborted ? { aborted: true } : {}),
      };
    },
  }) ?? null);

  // Tool: anic_iterate — run one iteration cycle on a project
  disposers.push(tools.register({
    name: 'anic_iterate',
    // SDO：触发条件 = 已有基线、要走一轮完整迭代；症状 = 用户说「跑一轮迭代/一轮循环」。
    description: 'Use when an ANIC-managed project should run one full iteration round (evaluation + gate check together). '
      + 'Triggers: 跑一轮迭代 / run one iteration / one cycle / 迭代一轮 / 跑一轮完整的迭代 / 评估加门禁一起.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
      },
    },
    presentCall: iteratePresentCall,
    presentResult: () => ({ card: 'generic' as const, title: 'anic_iterate ✓' }),
    execute: async (args, exec) => {
      const ws = (args.workspace as string) ?? getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const scriptsDir = resolveSkillScriptsDir(ws);
      if (!scriptsDir) return { error: 'skill scripts not found' };
      const evalResult = await invokeSkillScriptAsync(scriptsDir, 'eval-runner', [], ws, 60000, { signal: exec?.signal });
      const gateResult = await invokeSkillScriptAsync(scriptsDir, 'gate-check', ['--gate', 'all', '--quality', '--record'], ws, 60000, { signal: exec?.signal });
      return {
        eval: { exitCode: evalResult.exitCode, stdout: evalResult.stdout.slice(0, 4000) },
        gate: { exitCode: gateResult.exitCode, stdout: gateResult.stdout.slice(0, 4000) },
      };
    },
  }) ?? null);

  // Tool: anic_gate_check — run gate checks on a project
  disposers.push(tools.register({
    name: 'anic_gate_check',
    // SDO：触发条件 = 需要收敛门判定/判定已产出（进阶段、发版、登记账本）。
    description: 'Use when convergence-gate verdicts are needed for an ANIC-managed project — before advancing a phase, '
      + 'before delivery/release, or to record gate results to the ledger. '
      + 'Triggers: 门禁 / gate check / G0-G3 / 收敛门 / gate verdict.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
        gate: { type: 'string', description: 'Specific gate (default: all)' },
      },
    },
    execute: async (args, exec) => {
      const ws = (args.workspace as string) ?? getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const scriptsDir = resolveSkillScriptsDir(ws);
      if (!scriptsDir) return { error: 'skill scripts not found' };
      const gate = (args.gate as string) ?? 'all';
      const result = await invokeSkillScriptAsync(scriptsDir, 'gate-check', ['--gate', gate, '--quality', '--record'], ws, 60000, { signal: exec?.signal });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 8000),
        stderr: result.stderr.slice(0, 4000),
      };
    },
  }) ?? null);

  // Tool: anic_bootstrap — self-bootstrap (evaluate dsh-anic itself)
  disposers.push(tools.register({
    name: 'anic_bootstrap',
    // SDO：触发条件 = 评估 dsh-anic 插件自身（自举）；症状 = 用户问「插件自己健康吗/自举一次」。
    description: 'Use when the dsh-anic plugin ITSELF needs evaluation (self-bootstrap) — checking plugin health, '
      + 'producing tech-debt proposals from its own codebase. Triggers: 自举 / self-bootstrap / '
      + '插件自检评估 / evaluate dsh-anic itself.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        maxRounds: { type: 'number', description: 'Max bootstrap rounds (default 3)' },
      },
    },
    execute: async (args, exec) => {
      const root = getRoot();
      if (!root) return { error: 'no workspace' };
      const scriptsDir = resolveSkillScriptsDir(root);
      if (!scriptsDir) return { error: 'skill scripts not found' };
      // Run eval + gate on dsh-anic's own workspace
      const evalResult = await invokeSkillScriptAsync(scriptsDir, 'eval-runner', [], root, 60000, { signal: exec?.signal });
      const gateResult = await invokeSkillScriptAsync(scriptsDir, 'gate-check', ['--gate', 'all', '--quality', '--record'], root, 60000, { signal: exec?.signal });
      return {
        selfBootstrap: true,
        eval: { exitCode: evalResult.exitCode, stdout: evalResult.stdout.slice(0, 4000) },
        gate: { exitCode: gateResult.exitCode, stdout: gateResult.stdout.slice(0, 4000) },
        note: 'Tech-debt proposals written to .cycles/tech-debt/. No code was auto-modified (R-31).',
      };
    },
  }) ?? null);

  // 指针型工具（anic_snapshot/anic_self_check/anic_hitl）拆分至 toolsPointerGateway.ts
  disposers.push(...registerPointerTools((tool) => tools.register!(tool), getRoot));

  // 进化域工具（anic_autonomy_downgrade）拆分至 toolsEvolutionGateway.ts
  disposers.push(...registerEvolutionTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));

  // Flows 域工具（anic_flows_gate_check，R3 阶段 2）拆分至 toolsFlowsGateway.ts
  disposers.push(...registerFlowsTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));

  // HITL 三段修复工具（anic_flows_hitl，R3 阶段 4）拆分至 toolsHitlGateway.ts
  disposers.push(...registerHitlTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));

  // 自动修复循环工具（anic_flows_auto_fix，R3 阶段 5）拆分至 toolsAutoFixGateway.ts
  disposers.push(...registerAutoFixTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));

  // Tool: anic_status — get full org status panorama + recent flow tracker records
  disposers.push(tools.register({
    name: 'anic_status',
    // SDO：触发条件 = 要看项目全景/调用历史/技能健康/技能完整性；只读查询，无副作用。
    description: 'Use when an ANIC-managed project needs a status panorama — cycles, ledger, trust/autonomy level, '
      + 'band violations, recent skill-invocation flows, skill health report, or installed-skill integrity. '
      + 'Read-only. Triggers: 项目状态 / org status / 自主级 / 技能健康 / flow records / 全景.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
        flowLimit: { type: 'number', description: 'Max recent flow records to return (default 10, max 50)' },
      },
    },
    presentCall: statusPresentCall,
    execute: async (args) => {
      const root = (args.workspace as string) ?? getRoot() ?? '';
      const flowLimit = Math.min(Math.max(typeof args.flowLimit === 'number' ? args.flowLimit : 10, 1), 50);
      // M10-a/e：FlowTracker 最近记录 + 统计 + 持续学习健康报告
      const cyclesDir = join(root, '.cycles');
      let flows: unknown[] = []; let stats: Record<string, unknown> = {};
      let health: unknown = null; let healthSummary = '';
      if (existsSync(cyclesDir)) {
        const ts = loadFlowTracker(cyclesDir);
        flows = recentFlows(ts, flowLimit); stats = flowStats(ts);
        const report = analyzeSkillHealth(ts);
        health = report; healthSummary = formatHealthSummary(report);
      }
      // eco P0：技能完整性（doctor 语义），installedDir 解析收窄为本地函数
      const installedDir = existsSync(join(root, '.dsh', 'skills', 'ai-native-iteration-cycle'))
        ? join(root, '.dsh', 'skills', 'ai-native-iteration-cycle')
        : null;
      const skillIntegrity = skillIntegritySummary(installedDir, inlineSkillRoot());
      return { statusUrl: `/anic/org-status?workspace=${encodeURIComponent(root)}`, flows, flowStats: stats, health, healthSummary, skillIntegrity };
    },
  }) ?? null);

  // 技能调用域工具（anic_install + anic_skill 通用网关）拆分至 toolsSkillGateway.ts；
  // 自举域工具（anic_bootstrap_cycle + anic_bootstrap_analyze）拆分至 toolsBootstrapGateway.ts
  // （T3 ≤250 行模块化纪律，cycle-16）；disposer 一并纳入本聚合器的清理面。
  disposers.push(...registerSkillGatewayTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));
  disposers.push(...registerBootstrapGatewayTools(tools, { getRoot, register: (tool) => tools.register!(tool) }));

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function');
  if (cleanups.length === 0) return null;
  return () => { for (const d of cleanups) d(); };
}
