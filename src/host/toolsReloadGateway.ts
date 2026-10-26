/**
 * 热更新重载工具网关（cycle-80 WS-1 · 一域一文件）。
 *
 * `anic_reload_self` —— 请求宿主重载本插件，是 `ctx.hmr` 的**模型可调用**消费面。
 *
 * ## 为什么做成工具而不是只在启动时自动重载
 * 自动重载适合「改完代码立刻生效」，但它无法表达「为什么重载」「谁请求的」。做成工具后：
 * ① 调用进 DSH 轨迹（用户核心诉求：轨迹要能看到本插件动作）；② reason 必填并落
 * `.cycles/reload-history.json`；③ headless/SDK profile 无 hmr 时返回 `unavailable`
 * ——**诚实降级**，绝不假装重载成功（"没有证据 ≠ 通过"）。
 *
 * ## 与路由的分工
 * 工具面给模型/会话内用（走 in-process），`POST /anic/api/reload` 给运维/外部脚本用；
 * 两者共用 `reloadSelf` 同一实现（单一实现纪律，避免两套语义漂移）。
 */
import { join } from 'node:path';
import { genericCall, genericResult, normalizeToolResult } from './presentation.ts';
import { makeToolOutput, type ToolRegistration, type ToolsSlot } from './toolsSlot.ts';
import { probeHmr, reloadSelf } from './runtime/hotReload.ts';
import { resolvePluginRoot } from './pluginRoot.ts';

export interface ReloadGatewayDeps {
  getRoot: () => string | null;
  register: (tool: ToolRegistration) => (() => void) | null | undefined;
  /** 宿主上下文（用于 ctx.get('hmr', false) 可选探测——绝不写进 inject）。 */
  ctx: unknown;
}

/** 注册热更新重载工具（返回 disposer 数组，与其他网关同款聚合约定）。 */
export function registerReloadTools(tools: ToolsSlot, deps: ReloadGatewayDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_reload_self — 请求宿主重载本插件（先落 in-flight 再触发）
  disposers.push(deps.register({
    name: 'anic_reload_self',
    // SDO：触发条件 = 改完插件代码想让宿主加载新 dist；症状 = 用户说"热更新/重载插件"。
    description: 'Use when the dsh-anic plugin itself must be reloaded so the host picks up a fresh '
      + 'dist build (source is newer than dist). Records an in-flight handshake entry, then asks the '
      + 'host hmr service to reconcile the profile; returns scheduled | refused | unavailable. '
      + 'Honest degradation: headless/SDK profiles have no hmr service and return unavailable '
      + '(nothing is written, nothing is faked). Triggers: 热更新 / 热重载 / reload plugin / hmr / '
      + '重载插件 / 改完代码生效.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this reload is requested (required; recorded in .cycles/reload-history.json)' },
        force: { type: 'boolean', description: 'Reload even when dist is already newer than src (testing/demo only)' },
        workspace: { type: 'string', description: 'Target project directory (defaults to current workspace)' },
        requiredIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional profile plugin ids that must remain loaded after reconciliation',
        },
      },
      required: ['reason'],
    },
    presentCall: (args: Record<string, unknown>) =>
      genericCall('anic_reload_self', 'other', {
        reason: args.reason ?? '?',
        workspace: args.workspace ?? '.',
      }),
    presentResult: (_args, result) => {
      // cycle-22：官方 {content,isError,meta} 形状归一化（双形状兼容见 normalizeToolResult）
      const r = normalizeToolResult(result);
      return genericResult(`anic_reload_self: ${String(r.action ?? '?')}`);
    },
    execute: async (args) => {
      const root = typeof args.workspace === 'string' && args.workspace !== ''
        ? args.workspace
        : deps.getRoot() ?? '';
      if (root === '') return { error: 'no workspace' };
      const reason = typeof args.reason === 'string' && args.reason.trim() !== ''
        ? args.reason
        : 'reload requested without reason';
      const requiredIds = Array.isArray(args.requiredIds)
        ? args.requiredIds.filter((x): x is string => typeof x === 'string')
        : undefined;
      const result = await reloadSelf(deps.ctx, {
        cyclesDir: join(root, '.cycles'),
        pluginRoot: resolvePluginRoot(),
        reason,
        actor: 'anic_reload_self',
        requiredIds,
        force: args.force === true,
      });
      return {
        ...result,
        workspace: root,
        // 工具面把「hmr 在这个宿主上到底可不可用」一并回给模型：unavailable 时
        // action 已说明原因，探测结果让"为什么不可用"可被直接引用而不是猜。
        hmr: probeHmr(deps.ctx),
        historyFile: join(root, '.cycles', 'reload-history.json'),
      };
    },
  }) ?? null);

  return disposers;
}
