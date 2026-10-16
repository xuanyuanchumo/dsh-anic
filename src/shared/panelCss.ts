/**
 * 面板静态 CSS（P1-1 响应式 + 交互态）。
 *
 * ## 为什么是"手写静态 CSS 字符串"而不是别的
 *
 * 内联 style 对象表达不了 `:hover` / `:focus-visible` / `@container` / `@media` /
 * `@keyframes` / `[data-state]` —— 这些只能活在样式表里。本工程零 bundle 依赖
 * （react 之外全外置或内联），不引 CSS-in-JS；`tokenCssBlock()`（tokens.ts）已经
 * 确立了「挂载时注入 `<style>`」的范式，本文件是同一范式的第二块：令牌块负责
 * **变量定义**，本块负责**结构与交互态**。
 *
 * ## 颜色纪律
 *
 * 全部颜色经 `v()` 引用语义令牌（`var(--anic-*, <同源 fallback>)`）——fallback
 * 从 `SEMANTIC` 表插值而来，保证：① 本文件零十六进制字面量（单一事实源）；
 * ② 裸 `var(--x)` 禁令（clientRenderContract BARE_VAR_RE）不触发——每处都带
 * fallback；③ 令牌改名时这里编译期报错，而不是静默落到旧色。
 *
 * ## 响应式策略：容器查询优先
 *
 * 面板宽度 ≠ 视口宽度（宿主把它挂在会话视图里，旁边还有侧栏/标签栏），
 * 所以断点挂在 `[data-anic-workflow]` 的 `container-type: inline-size` 上
 * （自身宽度），`@media` 只留给与视口真正相关的 `prefers-*` 查询。
 */
import { SEMANTIC, type TokenName } from './tokens.ts';

/** 令牌引用（与组件侧 token() 同形，但用于 CSS 文本——不能走 token() 因为那是给 style 对象的）。 */
function v(name: TokenName): string {
  return `var(--${name}, ${SEMANTIC[name]})`;
}

/** 面板级静态样式块（注入一次，作用域全部锚在 [data-anic-workflow] 之下）。 */
export const PANEL_CSS: string = [
  // 容器查询锚点：面板自身宽度（不是视口——见文件头「响应式策略」）。
  // inline-size 只做行向包含：宽度已由 style 显式定 100%，内容不再反向影响它。
  `[data-anic-workflow] { container-type: inline-size; }`,

  // 工具栏按钮：基态从内联 BTN 迁到类（内联样式会压住 :hover——迁移是
  // 交互态能生效的前提）。颜色全走令牌，暗色档由令牌块切换。
  `.anic-btn {`,
  `  font-size: 12px; padding: 2px 10px; cursor: pointer;`,
  `  border: 1px solid ${v('anic-border')}; border-radius: 4px;`,
  `  background: ${v('anic-surface')}; color: ${v('anic-text')};`,
  `  transition: background-color 0.12s ease;`,
  `}`,
  `.anic-btn:hover { background: ${v('anic-surface-hover')}; }`,
  `.anic-btn:active { background: ${v('anic-surface-active')}; }`,
  `.anic-btn[disabled] { cursor: default; }`,

  // 焦点环：面板内一切可聚焦元素的键盘焦点指示（鼠标点击不触发 :focus-visible，
  // 不会给普通点击加一圈蓝框）。outline-offset 让环不压住控件自身描边。
  `[data-anic-workflow] :focus-visible {`,
  `  outline: 2px solid ${v('anic-focus-ring')}; outline-offset: 1px;`,
  `}`,

  // 图区：svg 容器是唯一的 Tab 停靠点（roving tabindex），节点 tabIndex=-1、
  // 由方向键聚焦——环画在 svg 外框与被聚焦节点的 circle 描边上。
  `svg[data-anic-graph]:focus-visible {`,
  `  outline: 2px solid ${v('anic-focus-ring')}; outline-offset: 2px;`,
  `}`,
  `[data-anic-node]:focus circle {`,
  `  stroke: ${v('anic-focus-ring')}; stroke-width: 2;`,
  `}`,
  `[data-anic-node] { cursor: pointer; }`,

  // 屏幕阅读器专用（等价数据表）：视觉上折叠为 1px，AT 照常朗读。
  `.anic-sr-only {`,
  `  position: absolute; width: 1px; height: 1px; margin: -1px;`,
  `  padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;`,
  `}`,

  // 窄面板（宿主侧栏挤占 / 小窗口）：工具栏换行、数据行降密。
  `@container (max-width: 640px) {`,
  `  [data-anic-toolbar] { flex-wrap: wrap; row-gap: 4px; }`,
  `  [data-anic-invocation] { flex-wrap: wrap; }`,
  `}`,

  // 更窄：实时调用条目参数预览整行换行，不再与状态点挤一行。
  `@container (max-width: 420px) {`,
  `  [data-anic-invocation] { flex-direction: column; gap: 2px; }`,
  `}`,

  // 动画最小化（与 FAIL_PULSE_STYLE / LIVE_PULSE_STYLE 同纪律：全局逃逸）。
  `@media (prefers-reduced-motion: reduce) {`,
  `  .anic-btn { transition: none; }`,
  `}`,

  // 强制颜色模式（Windows 高对比）：系统接管配色，边框用系统色恢复可辨识性。
  `@media (forced-colors: active) {`,
  `  .anic-btn { border: 1px solid ButtonText; }`,
  `}`,
].join('\n');
