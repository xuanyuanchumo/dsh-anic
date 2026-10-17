/**
 * 进化域 DSH 工具网关（T3 ≤250 行模块化纪律：一域一文件）。
 *
 * anic_autonomy_downgrade —— 自主级证据化回退（R3 阶段 1 余量落地）。
 * 模型可调用 = 轨迹可见（用户核心诉求③：DSH 轨迹要有本插件的调用），
 * 但动作本身有证据围栏：无熔断信号时维持不动（INV-28 精神），
 * 降级写入走 Post-Verify 回读（autonomyActions.ts，技能 S-7 纪律）。
 */
import { join } from 'node:path';
import { genericCall, genericResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runAutonomyFallback } from './evolution/autonomyActions.ts';

export interface EvolutionGatewayDeps {
  getRoot: () => string | null;
  register: (tool: ToolRegistration) => (() => void) | null | undefined;
}

/**
 * 注册进化域工具。返回 disposer 数组（与 toolsPointerGateway 同款聚合约定）。
 */
export function registerEvolutionTools(tools: ToolsSlot, deps: EvolutionGatewayDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_autonomy_downgrade — 证据化自主级回退（评估熔断信号，仅证据支持时执行）
  disposers.push(deps.register({
    name: 'anic_autonomy_downgrade',
    description:
      'Evaluate the 8 circuit-breaker signals of a workspace and, ONLY if evidence supports it, '
      + 'downgrade the autonomy level one step (L4→L3 or L3→L2) in .cycles/config.yml with '
      + 'Post-Verify re-read and an incident record in .cycles/incidents/. '
      + 'Refuses when no breaker is tripped (level maintained, nothing written) or at L1/L2 floor.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_autonomy_downgrade', 'edit', { workspace: args.workspace ?? '.' }),
    presentResult: (_args, result) =>
      genericResult(`anic_autonomy_downgrade: ${String(result.action ?? '?')}`),
    execute: async (args) => {
      const root = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!root) return { error: 'no workspace' };
      const result = runAutonomyFallback(root);
      return {
        action: result.action,
        currentBand: result.currentBand,
        targetBand: result.targetBand,
        observedBand: result.observedBand,
        trippedBreakers: result.trippedBreakers,
        incidentPath: result.incidentPath,
        reason: result.reason,
        configPath: join(root, '.cycles', 'config.yml'),
      };
    },
  }) ?? null);

  return disposers;
}
