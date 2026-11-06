/**
 * 工作台 CSS（cycle-110）—— 六域网格 / 域卡 / 粘性导航 / 三档容器查询。
 *
 * ## 为什么是静态 CSS 字符串（与 panelCss 同范式）
 *
 * 网格断点（`@container`）、hover 抬起（`:hover`）、减少动效覆盖
 * （`@media (prefers-reduced-motion)`）都表达不了在内联 style 对象里——
 * 它们只能活在样式表里。本块经 `panelCss.ts` 的 `PANEL_CSS` 数组末尾追加
 * （单一注入点不变，见该文件头注）。
 *
 * ## 颜色纪律（零颜色字面量）
 *
 * 本文件**禁**出现十六进制或 rgb/rgba/hsl 形式的颜色字面量。状态点四档颜色
 * 经本地 v() helper 引用语义令牌（`var(--anic-*, <同源 fallback>)`）——与
 * panelCss 的 v() 同形但不共用：shared 内互引只许类型与常量，复制 4 行
 * helper 换取两个文件各自可独立审读（fallback 同源 SEMANTIC，漂移不可能——
 * 单一来源在 tokens.ts，改令牌名时这里编译期报错）。所需令牌名逐一对照
 * tokens.ts 的 SEMANTIC 实际存在者选取。
 *
 * ## 容器查询三档（断点挂面板自身宽度）
 *
 * 父容器 `[data-anic-workflow]` 已是 `container-type: inline-size`
 * （panelCss.ts 头注：面板宽度 ≠ 视口宽度——宿主把它挂在会话视图里）。
 * 断点：<560px 单列 / 560–900px 两列 / >900px 三列；`span:'full'` 的卡
 * `grid-column: 1/-1`。
 */
import { SEMANTIC, type TokenName } from './tokens.ts';

/** 令牌引用（CSS 文本形态；组件侧 token() 是给 style 对象的，二者不可混用）。 */
function v(name: TokenName): string {
  return `var(--${name}, ${SEMANTIC[name]})`;
}

/** 状态点颜色令牌（四档——与 workbenchStatus 的状态集合同构，色值单一来源）。 */
const STATUS_COLOR: Record<string, string> = {
  fail: v('anic-fail'),
  warn: v('anic-warn-text'),
  ok: v('anic-pass'),
  idle: v('anic-text-faint'),
};

/** 工作台样式块（panelCss 数组末尾追加项；全部锚在 data-anic-wb-* 之下）。 */
export const WORKBENCH_CSS: string = [
  // ── 网格 ─────────────────────────────────────────────────────────────
  // 默认单列（窄容器）；两档断点在下方 @container 里抬列数。
  `[data-anic-wb-grid] { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }`,
  // 三档容器查询：断点挂 [data-anic-workflow]（inline-size 容器，见文件头）。
  // minmax(0,1fr) 而非 1fr：允许卡内容收缩，防长路径/长文案把列撑爆。
  `@container (min-width: 560px) {`,
  `  [data-anic-wb-grid] { grid-template-columns: repeat(2, minmax(0, 1fr)); }`,
  `}`,
  `@container (min-width: 900px) {`,
  `  [data-anic-wb-grid] { grid-template-columns: repeat(3, minmax(0, 1fr)); }`,
  `}`,
  // 通栏卡（overview / settings）：横跨全部列。
  `[data-anic-wb-grid] [data-anic-wb-span='full'] { grid-column: 1 / -1; }`,

  // ── 域卡 ─────────────────────────────────────────────────────────────
  // 卡片基态：圆角 + 细边 + 面色（全部经 v()——本文件零颜色字面量）。
  `section[data-anic-wb-card] {`,
  `  border: 1px solid ${v('anic-border')}; border-radius: 8px;`,
  `  background: ${v('anic-surface')}; padding: 8px;`,
  // hover 抬起：投影 + 上移 1px。transform 不触发重排（位移用 transform
  // 而非 top——panelCss 图区卡片同款纪律）。
  `  transition: box-shadow 0.12s ease, transform 0.12s ease;`,
  `}`,
  `section[data-anic-wb-card]:hover {`,
  `  box-shadow: 0 2px 8px ${v('anic-row-border')};`,
  `  transform: translateY(-1px);`,
  `}`,
  // 减少动效：hover 抬起整个关掉（全局逃逸纪律——用户明示要静就不要动）。
  `@media (prefers-reduced-motion: reduce) {`,
  `  section[data-anic-wb-card] { transition: none; transform: none; }`,
  `}`,
  // 卡头：小标签行（域标签 + 状态点 + 计数），11-12px。
  `[data-anic-wb-card-head] {`,
  `  display: flex; align-items: baseline; gap: 6px;`,
  `  font-size: 12px; font-weight: 600; color: ${v('anic-text-strong')};`,
  `  padding: 0 2px 4px; border-bottom: 1px solid ${v('anic-row-border')};`,
  `}`,
  // 计数退一档：它是元信息不是内容（弱化但可读）。
  `[data-anic-wb-card-count-text] { font-size: 11px; font-weight: 400; color: ${v('anic-text-faint')}; margin-left: auto; }`,

  // ── 状态点（nav chip 与卡头共用；四档色全经令牌）─────────────────────
  `[data-anic-wb-chip-status], [data-anic-wb-card-status-dot] { font-weight: 700; }`,
  ...Object.entries(STATUS_COLOR).map(([state, color]) =>
    `[data-anic-wb-chip-status='${state}'], [data-anic-wb-card-status-dot='${state}'] { color: ${color}; }`),

  // ── 域导航 ───────────────────────────────────────────────────────────
  // sticky：工具栏已钉在 top:0（panelLayoutContract 契约），nav 必须让出
  // 工具栏一条的厚度再粘（top 给偏移），否则滚动时 nav 会钻到工具栏底下。
  // 工具栏 6px×2 padding + ~20px 行高 ≈ 32px，取 34px 留 1px 呼吸缝。
  `nav[data-anic-wb-nav] {`,
  `  position: sticky; top: 34px; z-index: 1;`,
  `  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;`,
  `  padding: 4px 10px; background: ${v('anic-surface')};`,
  `  border-bottom: 1px solid ${v('anic-border')};`,
  `}`,
  // chip：小圆角按钮（类 .anic-btn 的近亲但独立锚点——计数守卫只认
  // data-anic-toolbar 子树，chip 不在那棵子树里）。
  `button[data-anic-wb-nav-chip] {`,
  `  display: inline-flex; align-items: center; gap: 4px;`,
  `  font-size: 11px; padding: 2px 8px; cursor: pointer;`,
  `  border: 1px solid ${v('anic-border')}; border-radius: 999px;`,
  `  background: ${v('anic-surface')}; color: ${v('anic-text')};`,
  `  transition: background-color 0.12s ease;`,
  `}`,
  `button[data-anic-wb-nav-chip]:hover { background: ${v('anic-surface-hover')}; }`,
  `@media (prefers-reduced-motion: reduce) {`,
  `  button[data-anic-wb-nav-chip] { transition: none; }`,
  `}`,
].join('\n');
