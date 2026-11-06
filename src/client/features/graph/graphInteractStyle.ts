/**
 * 图谱交互层 CSS（cycle-98 · 图谱交互增强 ①②）。
 *
 * 承 statusDot.ts 同一纪律：样式文本常量 + 消费方一处 `<style>` 注入；
 * 动画最小化（只有 hover 过渡，无 keyframes；`prefers-reduced-motion` 下
 * transition 关闭不影响信息获取——hover 高亮本身不是动效依赖）。
 *
 * 颜色纪律：CSS 里**不得裸写 `var(--anic-*)`**（clientRenderContract 守卫）——
 * 必须经 `token()` 产出带同源 fallback 的引用。本文件用模板串拼 token() 表达式。
 *
 * ## 两块样式解决的两个真实缺陷（研究实测）
 *
 * 1. **LOD 文本降采样**：缩放 0.5× 时主标签只有 ~5px（不可读），但 188 份
 *    `<text>` 仍全量渲染。分档隐藏：scale ≤0.6 藏次级文本，≤0.4 连主标签
 *    一起藏（卡片色块仍表达裁决与角色）——渲染量降一半以上，缩放更顺滑。
 *    数据通道 `data-anic-graph-scale` 已存在（graphCanvas.ts:70），零 JS。
 * 2. **边命中层 hover 视觉**：overlay（`data-anic-edge-hit`）默认透明宽描边，
 *    hover 时点亮为高亮描边——让"悬停到边"有可见反馈，而非只有系统 tooltip。
 */
import { token } from '../../../shared/tokens.ts';

/**
 * LOD 分档 + 边命中 hover + 卡片交互态（cycle-109 视觉现代化追加）样式。
 *
 * ## cycle-109 修的一个既有缺陷：LOD 的次级文本选择器指向了**不存在的锚点**
 *
 * 原三条降采样规则选择的是 `[data-anic-node-sub]`，而卡片实际渲染的次标签锚点是
 * `data-anic-node-meta`（`graphNodeCard.ts`）。⇒ "缩放 ≤0.6 藏次标签"这条**从未生效**：
 * 188 份 `<text>` 在 0.5× 下仍然全量渲染，而且 5px 高的粘连文字照样画在屏幕上。
 * 选择器改成 `-meta` 后才真正省掉渲染量与视觉噪声（这正是该文件头注声称的能力）。
 *
 * ## 追加的三条（全部是**属性/状态选择器**，零新元素、零新逻辑）
 *
 * 1. **悬停/聚焦时次标签提亮**：次标签默认用 `anic-text-dim`（弱化是对的），但悬停
 *    那一刻用户正想读它 —— 提亮到 `anic-text-strong` 让"看细节"不需要眯眼。
 *    改的是 `fill`（CSS 覆盖 SVG 呈现属性，合法且不回写 DOM 属性）。
 * 2. **聚焦/钉住卡片的描边层次**：卡片默认 0.8px 描边；聚焦/钉住态加粗到 1.9px。
 *    这是"形状/线宽"通道（WCAG 1.4.1），灰度与色盲下依然可分。
 * 3. **边 hover 加粗**：命中层 hover 时描边从 10px 加宽到 12px 并提高不透明度——
 *    细线图里"我到底指着哪条边"此前只能靠系统 tooltip。
 *
 * 为什么这些放 `<svg>` 内的 `<style>` 而不是内联 style：`stroke-width` / `fill`
 * 作为**属性**无法表达 `:hover`，而内联 style 又压不住伪类（内联优先级最高）。
 */
export const GRAPH_INTERACT_STYLE = `
[data-anic-graph-scale="0.25"] [data-anic-node-label],
[data-anic-graph-scale="0.25"] [data-anic-edge-hit] ~ [data-anic-node-label],
[data-anic-graph-scale="0.4"] [data-anic-node-meta] { display: none; }
[data-anic-graph-scale="0.4"] [data-anic-node-label],
[data-anic-graph-scale="0.5"] [data-anic-node-meta] { display: none; }
[data-anic-graph-scale="0.6"] [data-anic-node-meta] { display: none; }
[data-anic-edge-hit] { transition: stroke .12s ease, stroke-width .12s ease; }
[data-anic-edge-hit]:hover { stroke: ${token('anic-focus-ring')}; stroke-opacity: .75; stroke-width: 12; }
[data-anic-node] [data-anic-node-card] { transition: stroke-width .12s ease; }
[data-anic-node]:hover [data-anic-node-card],
[data-anic-node]:focus [data-anic-node-card] { stroke-width: 1.9; }
[data-anic-node] [data-anic-node-meta] { transition: fill .12s ease; }
[data-anic-node]:hover [data-anic-node-meta],
[data-anic-node]:focus [data-anic-node-meta] { fill: ${token('anic-text-strong')}; }
@media (prefers-reduced-motion: reduce) {
  [data-anic-edge-hit], [data-anic-node] [data-anic-node-card],
  [data-anic-node] [data-anic-node-meta] { transition: none; }
}
`;
