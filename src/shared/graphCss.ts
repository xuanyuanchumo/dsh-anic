/**
 * 图区**新增**样式块（cycle-90）——从 `panelCss.ts` 拆出，守 T3 ≤250 行。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `panelCss.ts` 在 cycle-90 追加视图组与泳道表头的样式后越过了 250 行硬限。
 * 拆分的界线是**职责**：本文件只承载「cycle-90 这一轮新增的图区样式」，
 * 既有图区规则（节点卡片 / 追溯 / 小地图 / 面包屑 / 跳转胶囊）**一行不动**
 * 留在 `panelCss.ts` —— 改既有条目会让「本轮新增」与「历史样式」纠缠在一起，
 * 审阅时无法只看新增部分。
 *
 * ## 为什么仍然从 `panelCss.ts` 汇出
 *
 * `PANEL_CSS` 是面板唯一的样式入口（宿主只注入它）。若图区样式另起一个注入面，
 * 宿主侧就要改（而 `WorkflowGraphPanel.ts` 是 Lead 独占）。所以本文件导出
 * `GRAPH_CSS`，由 `panelCss.ts` **拼进去** —— 面板侧零变更，import 路径零变更。
 *
 * ## 颜色纪律
 *
 * 全部颜色经 `v()` 引用语义令牌（`var(--anic-*, <同源 fallback>)`）——与
 * `panelCss.ts` 同一纪律（fallback 从 `SEMANTIC` 表插值，零十六进制字面量）。
 */
import { SEMANTIC, type TokenName } from './tokens.ts';

/** 令牌引用（与 `panelCss.ts` 的 `v()` 同形，但本文件独立持有）。 */
function v(name: TokenName): string {
  return `var(--${name}, ${SEMANTIC[name]})`;
}

/**
 * cycle-90 新增的图区样式（由 `panelCss.ts` 拼进 `PANEL_CSS`）。
 *
 * ## 选中态为什么用「边框加粗 + 字重」而不是背景色
 *
 * 颜色不能是唯一视觉手段（WCAG 1.4.1）：色盲用户与灰度打印下，背景色差异
 * 可能完全不可辨。而边框宽度与字重是**形状/结构**通道，任何渲染条件下都在。
 *
 * ## 禁用的「缩放到选中」为什么**不隐藏**按钮
 *
 * 按钮消失会让用户以为"这个功能不存在"（而它其实只是此刻没有选中节点）。
 * 保留但置灰（半透明 + not-allowed）表达的是"现在不能用"，这与"没有这个功能"
 * 是两种不同的信息。
 */
export const GRAPH_CSS: string = [
  // 布局模式 / 仅看异常：选中态用形状通道表达（边框加粗 + 字重加粗）。
  `[data-anic-graph-layout-mode][aria-pressed='true'],`,
  `[data-anic-graph-filter-anomaly][aria-pressed='true'] {`,
  `  border-width: 2px; font-weight: bold;`,
  `}`,
  // 禁用的「缩放到选中」：保留按钮但置灰（"现在不能用" ≠ "没有这个功能"）。
  `[data-anic-graph-fit-selection][disabled] {`,
  `  opacity: 0.45; cursor: not-allowed;`,
  `}`,
  // 全屏降级提示：`role=status` 让 AT 自动播报；视觉上与工具栏同层。
  `[data-anic-graph-fullscreen-note] {`,
  `  font-size: 10px; color: ${v('anic-warn-text')};`,
  `}`,
  // 泳道表头：纯标注，不该抢指针（否则会挡住下面卡片的点击）。
  `[data-anic-graph-viewport] [data-anic-graph-lane-header] {`,
  `  pointer-events: none;`,
  `}`,
].join('\n');
