/**
 * 进化域 DSH 工具网关（T3 ≤250 行模块化纪律：一域一文件）。
 *
 * anic_autonomy_downgrade —— 自主级证据化回退（R3 阶段 1 余量落地）。
 * 模型可调用 = 轨迹可见（用户核心诉求③：DSH 轨迹要有本插件的调用），
 * 但动作本身有证据围栏：无熔断信号时维持不动（INV-28 精神），
 * 降级写入走 Post-Verify 回读（autonomyActions.ts，技能 S-7 纪律）。
 */
import { join } from 'node:path';
import { genericCall, genericResult, normalizeToolResult } from './presentation.ts';
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
    // SDO：触发条件 = 熔断信号出现/需要评估是否降自主级；证据围栏语义保留（拒绝无证据降级）。
    description: 'Use when an ANIC-managed project shows circuit-breaker signals and the autonomy level may need '
      + 'an evidence-based step-down, or when checking whether a downgrade is warranted. '
      + 'Refuses without tripped-breaker evidence. Triggers: 熔断 / circuit breaker / '
      + '自主级回退 / autonomy downgrade / L4→L3.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
      },
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_autonomy_downgrade', 'edit', { workspace: args.workspace ?? '.' }),
    presentResult: (_args, result) => {
      // cycle-22：官方 {content,isError,meta} 形状归一化（双形状兼容见 normalizeToolResult）
      const r = normalizeToolResult(result);
      return genericResult(`anic_autonomy_downgrade: ${String(r.action ?? '?')}`);
    },
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
