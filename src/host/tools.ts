/**
 * DSH tool registration — exposes dsh-anic capabilities as DSH tools
 * that other sessions/agents can invoke (M8 G-TOOL).
 * INV-24: 'tools' in inject but we probe ctx.get('tools', false) for graceful degradation.
 */
// cycle-89 T-12：拆卸隔离（单个 disposer 抛错不阻断其余）。
import { safeDisposeAll, disposeErrorSink } from './runtime/safeDispose.ts';
import { resolveWorkspaceRoots, type SnapshotCtx } from './snapshotRoute.ts';
import { registerSkillGatewayTools } from './toolsSkillGateway.ts';
import { registerBootstrapGatewayTools } from './toolsBootstrapGateway.ts';
import { registerStatusTool } from './toolsStatusGateway.ts';
import { registerIndexLoaderTools } from './toolsIndexLoaderGateway.ts';
import type { ToolsSlot } from './toolsSlot.ts';
import { createFaceRecorder } from './toolFaceRecorder.ts';
import { resolveSkillScriptsDir, invokeSkillScriptAsync, validateWorkspace } from './skillInvoker.ts';
import { join } from 'node:path';
import {
  evaluatePresentCall,
  iteratePresentCall,
  terminalResult,
  terminalCall,
  genericCall,
} from './presentation.ts';
import { t } from './i18n.ts';
import { makeToolOutput } from './toolsSlot.ts';
import { rootWithSessionFirst, setSessionWorkspaceCtx } from './runtime/sessionWorkspace.ts';
import { registerPointerTools } from './toolsPointerGateway.ts';
import { registerEvolutionTools } from './toolsEvolutionGateway.ts';
import { registerFlowsTools } from './toolsFlowsGateway.ts';
import { registerHitlTools } from './toolsHitlGateway.ts';
import { registerAutoFixTools } from './toolsAutoFixGateway.ts';
import { registerReloadTools } from './toolsReloadGateway.ts';

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

  // cycle-74：注册面记录器（边注册边记，供披露加载器读取）。
  // 它解的是**真实运行时环** tools.ts → toolsIndexLoaderGateway → toolsFaceCapture → tools.ts；
  // 详见 toolFaceRecorder.ts 头注（依赖倒置，不是绕过检测）。
  const { reg, faces: registeredFaces } = createFaceRecorder(tools);

  // 会话工作区解析（默认工作区缺陷修复）：ctx 交给出口包装层，wireGuard 每次
  // execute 从 exec.agent 解析 workingDirectory/header.cwd。
  setSessionWorkspaceCtx(c);

  // 根工作区解析：**会话 → registry 链**（顺序即多项目隔离的核心，见
  // `runtime/sessionWorkspace.rootWithSessionFirst` 头注）。
  const getRoot = (): string | null =>
    rootWithSessionFirst(() => resolveWorkspaceRoots(c as SnapshotCtx));

  // Tool: anic_evaluate — evaluate a project
  disposers.push(reg({
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
    // cycle-40（KB 吸收 #2）：脚本执行类超时预算——声明即断言 exec.signal 已
    // 转发（下方 invokeSkillScriptAsync({ signal })），60s 与内部默认一致。
    timeoutMs: 60000,
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
  disposers.push(reg({
    name: 'anic_iterate',
    // SDO：触发条件 = 已有基线、要走一轮完整迭代；症状 = 用户说「跑一轮迭代/一轮循环」。
    description: 'Use when an ANIC-managed project should run one full iteration round (evaluation + gate check together). '
      + 'Triggers: 跑一轮迭代 / run one iteration / one cycle / 迭代一轮 / 跑一轮完整的迭代 / 评估加门禁一起.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
        // cycle-40（cycle-39 债务 #6）：硬编码 60s 对大工作区（如测试场地 5390
        // 用例）不够——eval 与 gate 各自的脚本执行超时可配置，默认 90s。
        timeout: { type: 'number', description: 'Per-script timeout ms (default 90000; large workspaces need more)' },
      },
    },
    presentCall: iteratePresentCall,
    presentResult: () => ({ card: 'generic' as const, title: 'anic_iterate ✓' }),
    // cycle-40（KB 吸收 #2）：iterate 是 eval+gate 两段脚本——超时预算取内部
    // 上限档 300s（每脚本 90s 默认 + 余量；防宿主侧先于内部预算掐断）。
    timeoutMs: 300000,
    execute: async (args, exec) => {
      const ws = (args.workspace as string) ?? getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const scriptsDir = resolveSkillScriptsDir(ws);
      if (!scriptsDir) return { error: 'skill scripts not found' };
      // cycle-40：超时可配（默认 90s；上限 10min 与 autoFixFlow 对齐——
      // iterate 是"一轮完整评估+门禁"，不是常驻循环，10min 足够且防悬挂）。
      const timeout = typeof args.timeout === 'number' && args.timeout > 0
        ? Math.min(args.timeout, 600000)
        : 90000;
      const evalResult = await invokeSkillScriptAsync(scriptsDir, 'eval-runner', [], ws, timeout, { signal: exec?.signal });
      const gateResult = await invokeSkillScriptAsync(scriptsDir, 'gate-check', ['--gate', 'all', '--quality', '--record'], ws, timeout, { signal: exec?.signal });
      return {
        eval: { exitCode: evalResult.exitCode, stdout: evalResult.stdout.slice(0, 4000) },
        gate: { exitCode: gateResult.exitCode, stdout: gateResult.stdout.slice(0, 4000) },
      };
    },
  }) ?? null);

  // Tool: anic_gate_check — run gate checks on a project
  disposers.push(reg({
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
    // cycle-39 T-3907：调用透明性收角（19/19 presentCall 完备）。
    presentCall: (args) => terminalCall(
      `anic_gate_check: ${typeof args.gate === 'string' ? args.gate : 'all'}`,
      typeof args.workspace === 'string' ? args.workspace : '.',
      t('presentation.gateSummary', { gate: typeof args.gate === 'string' ? args.gate : 'all' }),
    ),
    presentResult: (_args, result) => terminalResult(result, 'anic_gate_check ✓'),
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
  disposers.push(reg({
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
    // cycle-39 T-3907：调用透明性收角。
    presentCall: (args) => genericCall('anic_bootstrap', 'other', { maxRounds: args.maxRounds }),
    presentResult: () => ({ card: 'generic' as const, title: 'anic_bootstrap ✓' }),
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
  disposers.push(...registerPointerTools(reg, getRoot));

  // 进化域工具（anic_autonomy_downgrade）拆分至 toolsEvolutionGateway.ts
  disposers.push(...registerEvolutionTools(tools, { getRoot, register: reg }));

  // Flows 域工具（anic_flows_gate_check，R3 阶段 2）拆分至 toolsFlowsGateway.ts
  disposers.push(...registerFlowsTools(tools, { getRoot, register: reg }));

  // HITL 三段修复工具（anic_flows_hitl，R3 阶段 4）拆分至 toolsHitlGateway.ts
  disposers.push(...registerHitlTools(tools, { getRoot, register: reg }));

  // 自动修复循环 / 热重载 / 状态全景均已按一域一文件拆出（T3 纪律）。
  disposers.push(...registerAutoFixTools(tools, { getRoot, register: reg }));
  disposers.push(...registerReloadTools(tools, { getRoot, register: reg, ctx: c }));
  disposers.push(...registerStatusTool(reg, getRoot));

  // 技能调用域（toolsSkillGateway）/ 自举域（toolsBootstrapGateway）已拆出（T3 纪律，cycle-16）；
  // cycle-74：加载器**注入**「已注册面」读取闭包（不自行 import 捕获模块——那会成真实环）。
  disposers.push(...registerIndexLoaderTools(reg, registeredFaces));
  disposers.push(...registerSkillGatewayTools(tools, { getRoot, register: reg }));
  disposers.push(...registerBootstrapGatewayTools(tools, { getRoot, register: reg }));

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function');
  if (cleanups.length === 0) return null;
  // T-12 拆卸隔离：单个 disposer 抛错不得阻断其余（它常包着能力撤销，一次抛错会让权限半途残留）。
  return () => { safeDisposeAll(cleanups, disposeErrorSink('anic tools'), 'anic tools'); };
}
