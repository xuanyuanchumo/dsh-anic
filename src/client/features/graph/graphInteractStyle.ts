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

/** LOD 分档 + 边命中 hover 样式（注入到图区 svg 的既有 <style> 里）。 */
export const GRAPH_INTERACT_STYLE = `
[data-anic-graph-scale="0.25"] [data-anic-node-label],
[data-anic-graph-scale="0.25"] [data-anic-edge-hit] ~ [data-anic-node-label],
[data-anic-graph-scale="0.4"] [data-anic-node-sub] { display: none; }
[data-anic-graph-scale="0.4"] [data-anic-node-label],
[data-anic-graph-scale="0.5"] [data-anic-node-sub] { display: none; }
[data-anic-graph-scale="0.6"] [data-anic-node-sub] { display: none; }
[data-anic-edge-hit] { transition: stroke .12s ease; }
[data-anic-edge-hit]:hover { stroke: ${token('anic-focus-ring')}; stroke-opacity: .55; }
@media (prefers-reduced-motion: reduce) {
  [data-anic-edge-hit] { transition: none; }
}
`;
