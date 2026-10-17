/**
 * 自动修复循环 DSH 工具网关（R3 阶段 5；T3 ≤250 行一域一文件）。
 *
 * anic_flows_auto_fix —— 自动修复循环流程（test → 失败识别 → retest → 判定，
 * 耗尽后失败模式分析 repeating/cascading/transient → incident 熔断）。
 * 两模式：native（TypeScript autoFixEngine，缺省——逐 attempt 推进状态机，
 * ITERATING 轨迹进投影历史）/ script（正典技能 auto-fix-loop.mjs，黑盒单次推进）。
 *
 * 脚本侧 L4 桩语义（技能同款）：同步执行无 AI 介入窗口，retest 是同一命令重跑——
 * 模型在对话层看失败详情修复后重调本工具，差异即瞬态失败的判定信号。
 *
 * 模型可调用 = DSH 轨迹可见（tool/call + tool/result）；状态推进进
 * .cycles/flows/auto-fix.json 投影（GET /anic/flows/state?flow=auto-fix 可查）。
 */
import { genericCall, genericResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runAutoFixFlow } from './flows/autoFixFlow.ts';
import { validateWorkspace } from './skillInvoker.ts';

export interface AutoFixGatewayDeps {
  getRoot: () => string | null;
  register: (tool: ToolRegistration) => (() => void) | null | undefined;
}

/** 注册自动修复循环工具。返回 disposer 数组（与 toolsHitlGateway 同款聚合约定）。 */
export function registerAutoFixTools(_tools: ToolsSlot, deps: AutoFixGatewayDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_flows_auto_fix — 自动修复循环流程（R3 阶段 5，第 17 工具）
  disposers.push(deps.register({
    name: 'anic_flows_auto_fix',
    // SDO：触发条件 = 验证/测试失败需要自动修复循环；症状 = 测试红了、修复反复失败要失败模式分析。
    description: 'Use when tests or verification keep failing and an auto-fix loop should run — '
      + 'retrying the test command, analyzing failure patterns (repeating/cascading/transient) on exhaustion, '
      + 'and circuit-breaking with an incident when repair fails. Triggers: 自动修复 / auto-fix / '
      + '测试一直红 / 修复循环 / fix loop.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        maxRetries: { type: 'number', description: 'Max fix attempts per run (default: 3, max: 10)' },
        testCmd: { type: 'string', description: 'Test command override (default: test_cmd from .cycles/config.yml)' },
        mode: { type: 'string', description: 'Execution mode: native (default) or script' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_flows_auto_fix', 'other', {
        workspace: args.workspace ?? '.',
        maxRetries: args.maxRetries ?? 3,
        mode: args.mode ?? 'native',
      }),
    presentResult: (_args, result) =>
      genericResult(`anic_flows_auto_fix: ${String(result.verdict ?? '?')} (${String(result.state ?? '?')}`
        + `, ${String(result.attemptsCount ?? 0)} attempt(s)`
        + (result.pattern !== undefined && result.pattern !== null ? `, pattern=${String(result.pattern)}` : '')),
    execute: async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const maxRetries = typeof args.maxRetries === 'number' && Number.isInteger(args.maxRetries) && args.maxRetries > 0 && args.maxRetries <= 10
        ? args.maxRetries
        : undefined;
      const testCmd = typeof args.testCmd === 'string' && args.testCmd.trim() !== '' ? args.testCmd : undefined;
      // 每条测试命令 120s × 每轮两跑 × ≤10 轮 —— 工具级超时上限 10 分钟
      const result = runAutoFixFlow(ws, {
        maxRetries,
        testCmd,
        mode: args.mode === 'script' ? 'script' : 'native',
        timeoutMs: 600000,
      });
      return {
        verdict: result.verdict,
        exitCode: result.exitCode,
        flowState: result.state,
        testCmd: result.testCmd,
        maxRetries: result.maxRetries,
        attempts: result.attempts,
        attemptsCount: result.attemptsCount,
        ...(result.pattern !== null ? { pattern: result.pattern } : {}),
        incidentPath: result.incidentPath,
        reportPath: result.reportPath,
        ...(result.suggestedNextStep !== null ? { suggestedNextStep: result.suggestedNextStep } : {}),
        events: result.events,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.stdout !== undefined ? { stdout: result.stdout.slice(0, 8000) } : {}),
      };
    },
  }) ?? null);

  return disposers;
}
