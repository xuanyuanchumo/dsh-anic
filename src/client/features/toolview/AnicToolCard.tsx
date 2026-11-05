/**
 * anic_* 工具调用的终端卡片渲染（cycle-107 命令窗口显示修复）。
 *
 * **问题根因**（官方契约核验，kb/site/reference/cookbook/adding-a-tool.md:95）：
 *   内置 Web Client **不消费** `presentCall`/`presentResult`。Host 侧 `presentation.ts`
 *   精心构造的 `TerminalCallView`/`TerminalResultView`（含 ANSI 剥离、诚实截断、
 *   meta marker）永远不会被内置 UI 渲染——anic_* 工具调用只能落到 generic 行。
 *
 * **修复**：client 半部在 `tool.call.toolview` keyed slot 注册 anic_* 工具名，
 * 从 wire `ToolCallBlock` 派生 props 并渲染终端卡片。这与官方 `dsh-tool-bash` 的
 * `presentResult` 用 `parseExitStatus` 拆分输出正文与退出状态 pill 同构。
 *
 * 纪律：
 *   - 稳定 function component（模块作用域声明，非渲染期内联）——React 把变化的类型
 *     当作另一个组件，会卸载/重挂整棵子树（kb/extra/defensive-patterns/client-components.zh.md:95-102）。
 *   - 组件不接收 Cordis context、不导入 service 类、不读 React context（同上 :135-139）。
 *   - 防御式访问 wire 值：格式错误回退 generic 行，不崩。
 *   - CSS 走 `createElement('style')` + `cg-` 前缀 + 主题 CSS 变量（与既有面板同风格）。
 */
import { createElement, type ReactElement } from 'react';
import { SEMANTIC, tokenCssBlock, type TokenName } from '../../../shared/tokens.ts';

/** 令牌引用（panelCss.ts 的 v() 同形：`var(--name, <同源 fallback>)`）。 */
function v(name: TokenName): string {
  return `var(--${name}, ${SEMANTIC[name]})`;
}

/**
 * 终端卡片 CSS（cg- 前缀 + 语义令牌）——**单一样式真源**。
 *
 * 上游场地 C142 修复（两个缺陷一并根修）：
 *   ① 初版直接写裸 `var(--dsw-alias-*, #hex)` —— 两类违例：颜色字面量进源码
 *     （clientRenderContract P1-TOKENS：一律经语义层）；直接消费宿主别名绕过
 *     SEMANTIC 表，暗色主题切换时这份 CSS 不跟随（宿主别名管暗色值，本面板
 *     令牌块按 data-anic-theme 跟随宿主主题，两套机制漂移）。
 *   ② 初版与 ToolViewIntegration.ts 各持一份 CSS（紧凑/完整两份手写副本）——
 *     「两份清单必然漂移」教训原样复发。现在**只有这里一份**，集成侧导入本常量。
 *
 * 正确形态（与 panelCss.ts 同一纪律）：`tokenCssBlock()` 注入 `--anic-*` 令牌块
 * （浅/暗两档都由 SEMANTIC 表权威定义），卡片 CSS 经 `v()` 消费——每处引用都带
 * 同源 fallback，BARE_VAR_RE（裸 `var(--anic-x)` 无 fallback）不触发。
 * monospace 字体族不是颜色，保留宿主别名引用。
 */
export const TOOLVIEW_CSS = `
${tokenCssBlock()}
.anic-toolview-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px; border-radius: 6px;
  background: ${v('anic-surface')};
  border: 1px solid ${v('anic-border')};
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  font-size: 12px; line-height: 1.5; color: ${v('anic-text')};
}
.anic-toolview-card .anic-tv-title {
  font-weight: 600; color: ${v('anic-text-strong')};
  display: flex; align-items: center; gap: 6px;
}
.anic-toolview-card .anic-tv-desc {
  color: ${v('anic-text-dim')}; font-size: 11px;
}
.anic-toolview-card .anic-tv-output {
  margin: 0; padding: 6px 8px; border-radius: 4px;
  background: ${v('anic-surface-hover')};
  color: ${v('anic-text')};
  white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow: auto;
}
.anic-toolview-card .anic-tv-output.anic-tv-err {
  color: ${v('anic-fail')};
}
.anic-toolview-card .anic-tv-meta {
  display: flex; gap: 8px; align-items: center;
  font-size: 10px; color: ${v('anic-text-dim')};
}
.anic-toolview-card .anic-tv-exit-ok { color: ${v('anic-pass')}; }
.anic-toolview-card .anic-tv-exit-bad { color: ${v('anic-fail')}; }
.anic-toolview-card .anic-tv-pending {
  color: ${v('anic-text-dim')}; font-style: italic;
}
`;

/** 从 wire block 里安全取字段（防御式——wire 形状由宿主控制，客户端本地校验）。 */
function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function safeNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * 从 result block 提取输出文本与退出码。
 *
 * 防御式：`block` 形状由宿主控制，客户端必须本地校验并回退。
 * 优先读 `meta`（host 侧 `presentationMeta` 持久化的事实：exitCode/signal/durationMs），
 * 其次从 `content` 文本块拼接兜底。
 */
function extractResult(block: unknown): {
  output: string;
  isError: boolean;
  exitCode: number | undefined;
  signal: string | undefined;
  durationMs: number | undefined;
} {
  const b = (block && typeof block === 'object' ? block : {}) as Record<string, unknown>;
  const meta = (b.meta && typeof b.meta === 'object' ? b.meta : {}) as Record<string, unknown>;
  const content = Array.isArray(b.content) ? b.content : [];
  // content 是 ContentBlock[]——拼接 text 块
  const text = content
    .map((c) => {
      const cb = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return cb.type === 'text' ? safeString(cb.text) : '';
    })
    .filter(Boolean)
    .join('\n');
  // 输出：meta 里的 stdout 优先（host 侧 presentationMeta 可能带），否则 content 文本
  const stdout = safeString(meta.stdout) || safeString(b.stdout) || text;
  const stderr = safeString(meta.stderr) || safeString(b.stderr);
  const output = stderr ? `${stdout}\n-- stderr --\n${stderr}` : stdout;
  return {
    output,
    isError: b.isError === true,
    exitCode: safeNumber(meta.exitCode) ?? safeNumber(b.exitCode),
    signal: safeString(meta.signal) || safeString(b.signal) || undefined,
    durationMs: safeNumber(meta.durationMs) ?? safeNumber(b.durationMs),
  };
}

/** 从 args 提取工具参数摘要（用于 pending 卡片的描述行）。 */
function summarizeArgs(args: unknown, toolName: string): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof a.workspace === 'string') parts.push(`ws=${a.workspace}`);
  if (typeof a.script === 'string') parts.push(`script=${a.script}`);
  if (typeof a.dimensions === 'string') parts.push(`dims=${a.dimensions}`);
  if (typeof a.gate === 'string') parts.push(`gate=${a.gate}`);
  if (typeof a.target === 'string') parts.push(`target=${a.target}`);
  if (typeof a.maxRounds === 'number') parts.push(`rounds=${a.maxRounds}`);
  if (parts.length === 0) return `${toolName} …`;
  return `${toolName} ${parts.join(' ')}`;
}

/**
 * anic_* 工具调用的终端卡片（稳定 function component，模块作用域）。
 *
 * props 契约见 kb/site/reference/subsystems/tools.md:493 的 `ToolCallView` union 与
 * `tool.call.toolview` owner props（`ToolCallCommonProps` + `ToolCallPhaseProps`）。
 */
export function AnicToolCard(props: Record<string, unknown>): ReactElement {
  const { phase, block, toolName, cwd } = props as {
    phase?: string;
    block?: unknown;
    toolName?: string;
    cwd?: string;
  };
  const name = safeString(toolName);
  const phaseVal = safeString(phase);

  if (phaseVal === 'preparing') {
    return createElement('div', { className: 'anic-toolview-card', 'data-anic-toolview': name },
      createElement('div', { className: 'anic-tv-title' }, name),
      createElement('div', { className: 'anic-tv-pending' }, 'preparing…'),
    );
  }

  if (phaseVal === 'start') {
    const b = (block && typeof block === 'object' ? block : {}) as Record<string, unknown>;
    return createElement('div', { className: 'anic-toolview-card', 'data-anic-toolview': name },
      createElement('div', { className: 'anic-tv-title' }, name),
      createElement('div', { className: 'anic-tv-desc' }, summarizeArgs(b.arguments ?? b.args, name)),
      cwd ? createElement('div', { className: 'anic-tv-desc' }, `cwd: ${cwd}`) : null,
    );
  }

  // result 阶段
  const r = extractResult(block);
  const exitCode = r.exitCode;
  const exitClass = exitCode === 0 ? 'anic-tv-exit-ok' : 'anic-tv-exit-bad';
  const exitLabel = r.signal ? `signal: ${r.signal}` : exitCode !== undefined ? `exit ${exitCode}` : 'done';

  return createElement('div', { className: 'anic-toolview-card', 'data-anic-toolview': name },
    createElement('div', { className: 'anic-tv-title' }, name),
    r.output
      ? createElement('pre', { className: `anic-tv-output${r.isError ? ' anic-tv-err' : ''}` }, r.output)
      : null,
    createElement('div', { className: 'anic-tv-meta' },
      createElement('span', { className: exitClass }, exitLabel),
      r.durationMs !== undefined ? createElement('span', null, `${Math.round(r.durationMs)}ms`) : null,
    ),
  );
}
