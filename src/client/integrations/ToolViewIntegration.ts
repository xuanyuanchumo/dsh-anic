/**
 * `tool.call.toolview` 席位注册（cycle-107 命令窗口显示修复）。
 *
 * **问题根因**（官方契约核验，kb/site/reference/cookbook/adding-a-tool.md:95）：
 *   内置 Web Client **不消费** `presentCall`/`presentResult`。Host 侧 `presentation.ts`
 *   构造的 `TerminalCallView`/`TerminalResultView` 永远不会被内置 UI 渲染——
 *   anic_* 工具调用落到 generic 行，命令窗口（命令 + cwd + 输出 + 退出码）不可见。
 *
 * **修复**：client 半部在 `tool.call.toolview` keyed slot 注册每个 anic_* 工具名，
 * 从 wire `ToolCallBlock` 派生 props 并渲染 `AnicToolCard` 终端卡片。
 *
 * 契约（kb/site/reference/subsystems/tools.md:493 的 `tool.call.toolview` owner props）：
 *   - kind: 'keyed'，scope: 'session'
 *   - 注册项 `key` = wire 工具名（`anic_*`）；已占用的 key 替换既有视图
 *   - 组件 props = `ToolCallCommonProps`（useDisclosure/callId/toolName/cwd/home/openFile/loadImage/inspect）
 *     + `ToolCallPhaseProps`（phase: 'preparing'|'start'|'result' + block）
 *
 * 纪律（kb/extra/defensive-patterns/client-components.zh.md）：
 *   - 每个注册包在 `ctx.slots.inject('tool.call.toolview', cb)` 里——席位由宿主
 *     ToolCallTree 声明，只在会话面板挂载时存在；
 *   - 注册失败即回滚（disposer 数组 + catch 逆序释放）；
 *   - 幂等守卫：`slots.entries()` 反查，命中即跳过（防热重载双挂载）；
 *   - 组件是模块作用域的稳定 function component（非渲染期内联）。
 */
import { createElement, type ReactElement } from 'react';
import { ANIC_TOOL_IDS } from '../../shared/anicToolIds.ts';
import { AnicToolCard, TOOLVIEW_CSS } from '../features/toolview/AnicToolCard.tsx';

const CSS_ID = 'anic-toolview-css';

interface SlotsApi {
  inject(slot: string, cb: () => void): (() => void) | void;
  register(
    definition: { name: string; key: string },
    render: (props?: unknown) => ReactElement,
  ): (() => void) | void;
  entries?(slot: string): Array<{ key?: string }> | undefined;
}

function injectCssOnce(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement('style');
  style.id = CSS_ID;
  // 上游场地 C142：CSS 唯一副本在 AnicToolCard.tsx 的 TOOLVIEW_CSS（语义令牌版）——
  // 此前这里另持一份紧凑副本，两份手写清单漂移（CLAUDE.md 教训原样复发）。
  style.textContent = TOOLVIEW_CSS;
  document.head.appendChild(style);
}

/**
 * 注册 `tool.call.toolview` 席位（每个 anic_* 工具名一条）。
 *
 * @returns disposer 数组（卸载时逆序释放），或 null（slots 缺席）
 */
export function integrateToolView(ctx: unknown): Array<() => void> | null {
  const c = ctx as { slots?: unknown };
  const api = c.slots as SlotsApi | undefined;
  if (!api || typeof api.inject !== 'function' || typeof api.register !== 'function') {
    return null;
  }

  injectCssOnce();

  const disposers: Array<(() => void) | null> = [];
  let registered = 0;

  const doRegister = (): void => {
    // 幂等守卫：已注册则跳过（防热重载/重复挂载双注册）
    const existing = api.entries?.('tool.call.toolview') ?? [];
    const taken = new Set(existing.map((e) => e.key).filter((k): k is string => typeof k === 'string'));

    for (const toolName of ANIC_TOOL_IDS) {
      if (taken.has(toolName)) continue;
      try {
        const reg = api.register(
          { name: 'tool.call.toolview', key: toolName },
          (props?: unknown) => createElement(AnicToolCard, props as Record<string, unknown>),
        );
        if (typeof reg === 'function') disposers.push(reg);
        registered += 1;
      } catch {
        // 单个工具注册失败不阻断其余——inject 回调里抛错会杀死整个注册批次
      }
    }
  };

  try {
    const injectDisposer = api.inject('tool.call.toolview', () => {
      doRegister();
    });
    if (typeof injectDisposer === 'function') disposers.push(injectDisposer);
  } catch {
    // 席位未声明（无会话面板）——静默降级，不崩
  }

  // 暴露注册计数供调试（J0 探针可查）
  try {
    (globalThis as { __ANIC_TOOLVIEW__?: { count: number } }).__ANIC_TOOLVIEW__ = { count: registered };
  } catch { /* 无 globalThis 可写（旧宿主）——忽略 */ }

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function');
  return cleanups.length > 0 ? cleanups : null;
}
