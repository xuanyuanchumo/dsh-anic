/**
 * 自举域 DSH 工具（T3 拆分，cycle-16）：anic_bootstrap_cycle + anic_bootstrap_analyze。
 *
 * 从 toolsSkillGateway.ts 拆出（254 行 > 250 守卫；一域一文件纪律）：
 * anic_install + anic_skill（技能网关）留在原文件，本文件承载 M10-b/c 自举编排工具。
 *
 * ## cycle-96：本文件同时聚合「举他」工具
 *
 * `anic_bootstrap_other` 的实现放在 `toolsCrossBootstrapGateway.ts`（本文件再加一个
 * 工具就会越过 250 行机械守卫）。聚合放在这里而不是 `tools.ts`：注册序与
 * 「自举域」语义保持一处，`tools.ts` 无需新增 import（它对本域仍是单一入口）。
 */

import type { ToolRegistration, ToolsSlot } from './toolsSlot.ts';
import { safeHandler, makeToolOutput } from './toolsSlot.ts';
import { runSelfBootstrapCycleAsync } from './runtime/bootstrapOrchestrator.ts';
import { runBootstrapWithEngines } from './runtime/bootstrapEngineIntegration.ts';
// cycle-72 P0-BOOTSTRAP-STEP-TIMEOUT：每步默认预算的唯一事实源（两个入口共用，
// 不再各写一份字面量）。描述文本也由常量插值，模型可见值与实际预算不可能分叉。
import { BOOTSTRAP_STEP_TIMEOUT_MS, resolveBootstrapStepTimeout } from './runtime/bootstrapBudget.ts';
import {
  bootstrapCyclePresentCall,
  bootstrapAnalyzePresentCall,
} from './presentation.ts';
import { buildCrossBootstrapTool } from './toolsCrossBootstrapGateway.ts';

/** 注册自举域工具（anic_bootstrap_cycle / anic_bootstrap_analyze / anic_bootstrap_other）。 */
export function registerBootstrapGatewayTools(
  tools: ToolsSlot,
  deps: { getRoot: () => string | null; register: (tool: ToolRegistration) => (() => void) | null | undefined },
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const register = deps.register; // 调用方已在槽位守卫后收窄

  // Tool: anic_bootstrap_cycle — M10-b 自举链编排：eval → gate → fix 自动驱动循环。
  // 大模型可调用此工具驱动完整自举循环，无需手动逐步调用 eval/gate/fix。
  // 每步通过 FlowTracker 记录，供 anic_status 查询审计。
  disposers.push(register({
    name: 'anic_bootstrap_cycle',
    description: 'Use when a full self-bootstrap cycle should be driven automatically (instead of manually '
      + 'invoking eval/gate/fix step by step) — converging the workspace or driving it to exhaustion. '
      + 'Triggers: 自举循环 / bootstrap cycle / 自动收敛 / converge.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
        maxRounds: { type: 'number', description: 'Maximum bootstrap rounds (default 3, max 10)' },
        timeout: { type: 'number', description: `Per-step timeout ms (default ${BOOTSTRAP_STEP_TIMEOUT_MS}; matches the full test pyramid)` },
      },
    },
    presentCall: bootstrapCyclePresentCall,
    presentResult: () => ({ card: 'generic' as const, title: 'anic_bootstrap_cycle ✓' }),
    execute: safeHandler(async (args, exec) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!ws) return { error: 'no workspace' };
      if (ws.includes('..')) return { error: 'path traversal not allowed' };
      const maxRounds = Math.min(Math.max(typeof args.maxRounds === 'number' ? args.maxRounds : 3, 1), 10);
      const timeout = resolveBootstrapStepTimeout(args.timeout);

      // P1-EVENT-LOOP：自举循环可能跑数分钟——异步版 + signal（轮边界协作取消）。
      const result = await runSelfBootstrapCycleAsync(ws, maxRounds, timeout, { signal: exec?.signal });
      // cycle-72 P0：前置未就绪时**不**把结果报成 evalScore 0 / FAIL。
      // 折叠会在工具面重演同一个缺陷（大模型看到 0 分会去"修代码"，而真正要做的
      // 是补齐 .cycles 前置），故此处响亮返回专用码 + 修复指引，并显式标注未跑。
      if (result.precondition) {
        return {
          error: 'ANIC_BOOTSTRAP_PRECONDITION',
          preconditionCode: result.precondition.code,
          message: result.precondition.message,
          remedy: result.precondition.remedy,
          roundsExecuted: 0,
        };
      }
      return {
        status: result.state.status,
        round: result.state.round,
        converged: result.converged,
        aborted: result.aborted,
        lastEvalScore: result.state.lastEvalScore,
        lastGateVerdict: result.state.lastGateVerdict,
        rounds: result.rounds,
      };
    }),
  }) ?? null);

  // Tool: anic_bootstrap_analyze — M10-c 模块引擎接入：编排器 + 引擎深度分析。
  // 大模型可调用此工具获取 tech-debt + HITL 审计 + fact-base 验证 + 风险评分。
  disposers.push(register({
    name: 'anic_bootstrap_analyze',
    description: 'Use when self-bootstrap results need deep analysis for developer review — '
      + 'tech-debt proposals, HITL audit findings, fact-base verification, and a risk score. '
      + 'Triggers: 自举分析 / bootstrap analyze / 技术债 / tech debt / 风险评分.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
        maxRounds: { type: 'number', description: 'Maximum bootstrap rounds (default 3, max 10)' },
        timeout: { type: 'number', description: `Per-step timeout ms (default ${BOOTSTRAP_STEP_TIMEOUT_MS}; matches the full test pyramid)` },
      },
    },
    presentCall: bootstrapAnalyzePresentCall,
    presentResult: () => ({ card: 'generic' as const, title: 'anic_bootstrap_analyze ✓' }),
    execute: safeHandler(async (args) => {
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!ws) return { error: 'no workspace' };
      if (ws.includes('..')) return { error: 'path traversal not allowed' };
      const maxRounds = Math.min(Math.max(typeof args.maxRounds === 'number' ? args.maxRounds : 3, 1), 10);
      const timeout = resolveBootstrapStepTimeout(args.timeout);

      const { cycle, insights } = runBootstrapWithEngines(ws, maxRounds, timeout);
      return {
        cycle: {
          status: cycle.state.status,
          round: cycle.state.round,
          converged: cycle.converged,
          rounds: cycle.rounds,
        },
        insights: {
          techDebtCount: insights.techDebt.length,
          techDebtFiles: insights.techDebtFiles,
          hitlAllPassed: insights.hitlAllPassed,
          hitlChecks: insights.hitlChecks,
          factBase: insights.factBase,
          riskScore: insights.riskScore,
        },
      };
    }),
  }) ?? null);

  // Tool: anic_bootstrap_other — cycle-96「举他」工具化（实现见 toolsCrossBootstrapGateway.ts）。
  disposers.push(buildCrossBootstrapTool(tools, deps));

  return disposers;
}
