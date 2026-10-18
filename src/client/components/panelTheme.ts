/**
 * 面板主题/CSS 注入 hooks（cycle-18 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * 两个 hook 都是「面板作用域样式」这一个关注点的两半：
 *   - useTokenCss：注入令牌块（--anic-* 变量）+ 面板交互态/响应式 CSS 块；
 *   - useShellTheme：跟踪宿主主题运行时状态并写到面板根属性。
 */
import { useEffect, useState } from 'react';
import { resolveShellTheme, observeShellTheme, tokenCssBlock, type ShellTheme } from '../../shared/tokens.ts';
import { PANEL_CSS } from '../../shared/panelCss.ts';

/**
 * 注入面板作用域的样式（P1-TOKENS 令牌块 + P1-1 面板 CSS 块）。
 *
 * 令牌块定义 `--anic-*` 变量；面板块消费它们实现交互态（:hover/:focus-visible）
 * 与响应式（@container）——这两者在内联 style 里表达不了（见 panelCss.ts 头注释）。
 * 挂在 document.head，卸载时移除；同页面多个面板实例不会重复注入（id 去重）。
 */
export function useTokenCss(): void {
  useEffect(() => {
    const id = 'anic-panel-css';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = `${tokenCssBlock()}\n${PANEL_CSS}`;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);
}

/**
 * 跟踪宿主主题并把它写到面板根属性上（P0-THEME-MISMATCH）。
 *
 * 为什么不能只靠 CSS：宿主主题是**运行时状态**（用户在设置里切），而我们的
 * 暗色令牌必须跟着它走。原实现用 `@media (prefers-color-scheme: dark)` 近似，
 * 在"OS 暗色 + 宿主浅色"时套用暗色令牌 → 深底深字，实测几乎不可读。
 *
 * 这里读 `body[data-ds-dark-theme]`（宿主 theme-presenter 的权威输出，
 * 见 `tokens.ts` 注释），并订阅其变化，把结果写成 `[data-anic-theme]`。
 * 惰性求值 + 订阅，二者缺一不可：缓存初始值会让设置里切换主题后面板不跟随；
 * 不订阅则只能等下次重挂载。
 */
export function useShellTheme(): ShellTheme {
  const [theme, setTheme] = useState<ShellTheme>(() => resolveShellTheme());
  useEffect(() => {
    // 挂载后立刻再读一次：属性可能晚于首次渲染到达（DOMContentLoaded 之前）。
    setTheme(resolveShellTheme());
    return observeShellTheme(setTheme);
  }, []);
  return theme;
}
