/**
 * 边命中层（cycle-98 · 图谱交互增强 ①）——让边可以被悬停感知。
 *
 * ## 缺陷（研究实测）
 *
 * 边描边 0.7–1.0px（`graphEdgeRender.EDGE_STYLES`），且 `<path>` 默认只在
 * 描边像素上响应指针 —— 292 条边在真机上**一条都悬停不到**。9 种边类型的
 * 语义（时序 / 证据 / 回退 / 反馈环）只能靠图例背，图上看不出"这条线是什么关系"。
 *
 * ## 方案：透明宽描边 overlay + CSS hover 放大 + 原生 `<title>` 提示
 *
 * - overlay `<path>` 与可见边**同几何**（同 `d`），但 `stroke: transparent`
 *   且 `strokeWidth: 10`（命中区），`pointer-events: stroke` 只在描边上命中，
 *   填充区不拦截——点到两条边之间的空隙仍然透到节点/拖拽层；
 * - hover 视觉走**纯 CSS**（`:hover` 兄弟选择器不可靠 ⇒ overlay 自身加粗 +
 *   高亮色，叠加在可见边上方即可读），**零新 React 状态**——不重建 292 个
 *   闭包，2s 轮询下的重建成本与改造前相同；
 * - 提示用 SVG 原生 `<title>` 子元素：桌面端悬停出系统 tooltip，AT 读得到，
 *   jsdom 断言可查（`querySelectorAll('title')`）。
 *
 * ## 契约安全性
 *
 * 边计数断言按 `[data-anic-edge]` 锚点数——overlay 用**独立锚点**
 * `data-anic-edge-hit`，不带 `data-anic-edge`，既有计数与形态断言零变化。
 * overlay 挂在**每条可见边之后**（同一数组内紧随），保证叠加顺序 = 绘制顺序。
 */
import { createElement, type ReactElement } from 'react';

/** 边类型的语义一句话（tooltip 用；与 EDGE_STYLES 的线型表同源同序）。 */
export const EDGE_LABELS: Record<string, string> = {
  'cycle-seq': '轮次相继（时序）',
  evidences: '事件是该门禁的证据',
  'event-seq': '账本事件流（时序）',
  'human-gate': '阶段推进到人工门（人判）',
  'micro-entry': '宏观阶段进入微观循环',
  'micro-exit': '微观循环退出回宏观阶段',
  'gate-chain': '门禁链（G0→G1→G2→G3 严格顺序）',
  'phase-transition': '宏观阶段推进',
  'circuit-breaker': '熔断反馈（回退信号）',
  next: '无条件顺序推进',
  'on-pass': '裁决通过时的推进',
  'on-fail': '裁决失败时的回退',
};

/** 未登记边类型的缺省提示。 */
export const EDGE_LABEL_FALLBACK = '关系边';

/** 边类型的一句话语义（缺省不退化）。 */
export function edgeLabelOf(type: string): string {
  return EDGE_LABELS[type] ?? EDGE_LABEL_FALLBACK;
}

/** 命中区宽度（世界坐标 px；10 ≈ 0.25 倍缩放下仍有 ~2.5px 真实命中区）。 */
export const EDGE_HIT_WIDTH = 10;

/** 命中层单条 overlay 的入参（与 renderEdge 的几何输入完全一致）。 */
export interface EdgeHitInput {
  from: string;
  to: string;
  type: string;
  /** 与可见边同源的路径数据（同 `d` ⇒ 同几何）。 */
  d: string;
}

/**
 * 渲染一条边的命中层（透明宽描边 + `<title>`）。
 *
 * 为什么不在这里重算几何：`d` 由 `renderEdges` 调 `edgePath` 后**已经拿到**，
 * 再算一遍是 O(E) 的纯浪费，且两处算式一旦漂移，命中区会偏离可见线。
 */
export function renderEdgeHit(input: EdgeHitInput): ReactElement {
  return createElement('path', {
    key: `edge-hit-${input.from}-${input.to}`,
    // 独立锚点：不带 data-anic-edge，既有边计数/形态断言零变化（见文件头）。
    'data-anic-edge-hit': input.type,
    'data-anic-edge-hit-from': input.from,
    'data-anic-edge-hit-to': input.to,
    d: input.d,
    fill: 'none',
    stroke: 'transparent',
    strokeWidth: EDGE_HIT_WIDTH,
    // 只在描边区命中：填充区透明且不拦截，两条边之间的空隙仍透到下层。
    style: { pointerEvents: 'stroke', cursor: 'help' },
  }, createElement('title', { key: 'edge-hit-title' }, edgeLabelOf(input.type)));
}
