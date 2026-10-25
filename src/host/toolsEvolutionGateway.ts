/**
 * 进化域 DSH 工具网关（T3 ≤250 行模块化纪律：一域一文件）。
 *
 * anic_autonomy_downgrade —— 自主级证据化回退（R3 阶段 1 余量落地）。
 * anic_autonomy_upgrade   —— 自主级升级（cycle-77 T4：把「人类授权的 L4」做成
 *                            前置条件表 + 回读断言 + 结构化留痕，不再手改配置）。
 *
 * 模型可调用 = 轨迹可见（用户核心诉求③：DSH 轨迹要有本插件的调用），
 * 但动作本身有证据围栏：无熔断信号时降级维持不动（INV-28 精神），升级缺任一
 * 前置条件即拒绝且零写入；两条路径的落盘都走 Post-Verify 回读（技能 S-7 纪律）。
 */
import { join } from 'node:path';
import { genericCall, genericResult, normalizeToolResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { runAutonomyFallback } from './evolution/autonomyActions.ts';
import { upgradeAutonomy } from './evolution/autonomyUpgrade.ts';
import { MAX_HISTORY_ENTRIES } from './evolution/autonomyHistory.ts';

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
      + '自主级回退 / 回退一档 / autonomy downgrade / L4→L3.',
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
        // cycle-77：降级也进 autonomy-history.json（补齐「降级无审计」缺口）
        historyPath: result.historyPath ?? null,
        historyRecorded: result.historyRecorded ?? false,
        reason: result.reason,
        configPath: join(root, '.cycles', 'config.yml'),
      };
    },
  }) ?? null);

  // Tool: anic_autonomy_upgrade — 结构化前置条件 + 回读断言 + history 留痕的升级路径
  disposers.push(deps.register({
    name: 'anic_autonomy_upgrade',
    // SDO：触发条件 = 需要按人类授权把自主级提升一档；拒绝时点名缺哪条前置条件。
    description: 'Use when an ANIC-managed project should raise its autonomy level one step (L2→L3 or L3→L4) '
      + 'under machine-checked preconditions, or when a human-authorized L4 activation must be recorded '
      + 'in the audit trail. Refuses (with named missing preconditions, zero writes) unless the target is '
      + 'adjacent, no circuit breaker is tripped, the trust score meets the upgrade threshold (or a human '
      + 'explicitly assumes the risk) and L3→L4 carries humanAuthorized=true. '
      + 'Triggers: 自主级升级 / 提升自主级 / autonomy upgrade / 授权 L4 / human-authorized L4 / L3→L4.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['L3', 'L4'],
          description: 'Target autonomy band (adjacent single step only; downgrades use anic_autonomy_downgrade)',
        },
        reason: { type: 'string', description: 'Why this upgrade is justified (required, recorded in history)' },
        humanAuthorized: {
          type: 'boolean',
          description: 'Human explicitly authorizes this upgrade (required for L3→L4; also the only way to '
            + 'exempt an insufficient trust score, and the exemption is recorded)',
        },
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        record: {
          type: 'boolean',
          description: `Write the change to .cycles/autonomy-history.json (default true; false leaves an audit gap)`,
        },
      },
      required: ['target', 'reason'],
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_autonomy_upgrade', 'edit', {
        target: args.target ?? '?',
        workspace: args.workspace ?? '.',
      }),
    presentResult: (_args, result) => {
      const r = normalizeToolResult(result);
      return genericResult(`anic_autonomy_upgrade: ${String(r.action ?? '?')} ${String(r.from ?? '?')}→${String(r.observed ?? r.target ?? '?')}`);
    },
    execute: async (args) => {
      const root = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!root) return { error: 'no workspace' };
      const result = upgradeAutonomy(root, {
        target: String(args.target ?? ''),
        reason: String(args.reason ?? ''),
        humanAuthorized: args.humanAuthorized === true,
        actor: 'anic_autonomy_upgrade',
        record: args.record !== false,
      });
      return {
        action: result.action,
        from: result.from,
        target: result.target,
        observed: result.observed,
        missingPreconditions: result.missingPreconditions,
        threshold: result.threshold,
        trust: result.trust,
        trippedBreakers: result.trippedBreakers,
        authorization: result.authorization,
        historyRecorded: result.historyRecorded,
        historyPath: result.historyPath,
        historyLimit: MAX_HISTORY_ENTRIES,
        reason: result.reason,
        configPath: result.configPath,
      };
    },
  }) ?? null);

  return disposers;
}
