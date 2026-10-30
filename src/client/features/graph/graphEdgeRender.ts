/**
 * 边的语义化渲染（cycle-83 · V 战线）——六种边不再共用一条 0.7px 实线。
 *
 * ## 被修掉的缺陷（实测）
 *
 * cycle-82 的 `renderEdge` 对**所有** `edge.type` 画同一条
 * `strokeWidth: 0.7` 直线 + 同一个箭头。于是「轮次前后相继（纯时序）」
 * 「某条门禁事件是某门的证据（证据）」「账本内事件流顺序（事件流）」
 * 三种**决策语义完全不同**的边在图上不可区分 —— 读者能看出"有连接"，
 * 却看不出"这条连接是什么关系"，而那正是这张图唯一的价值。
 *
 * ## 线型表（每条都有语义理由，不是随机选样式）
 *
 * | type | 语义 | 形态 |
 * | --- | --- | --- |
 * | `cycle-seq` | 轮次相继（确定边·时序） | 细实线 + 箭头（有方向、要跟着走） |
 * | `evidences` | 事件是门禁的证据（确定边） | 虚线 + 淡色（"它支撑它"，不是流程推进） |
 * | `event-seq` | 账本事件流（确定边·时序） | 点线（密而轻，122 条同名边不能压过节点） |
 * | `human-gate` | 阶段 → 人工门（条件边·人判） | 长划 + 箭头（人判环节要显眼） |
 * | `micro-entry`/`micro-exit` | 宏观 ↔ 微观七步（条件边） | 短划（进出关系的双向感） |
 * | 其它 | 未登记类型 | 细实线（缺省不退化成不可见） |
 *
 * ## 为什么跨列边必须是贝塞尔 `<path>`
 *
 * 292 条边里绝大多数是跨列/跨 lane 的。直线在 12 列 × 188 节点的图上会互相
 * 穿越成一团（读者分不清哪条线来自哪个节点）。曲线让"来自左侧同一卡片"的
 * 多条边自然收束，这是图可读性的关键一步，不是装饰。
 *
 * ## 每个边元素必须带 `data-anic-edge`
 *
 * `scripts/offline-smoke.mjs` 与 `graphInteractiveContract` 都按**锚点数**断言
 * 边数（cycle-83 由 Lead 把判据从"数 `<line>` 标签"升级为"数锚点"）。这样
 * "直线换贝塞尔"不会假红，而"渲染了边但忘打锚点"会真红。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';

/** 边类型 → 线型。缺省（未登记类型）走 `DEFAULT_EDGE`。 */
export interface EdgeStyle {
  /** `stroke-dasharray`；undefined = 实线。 */
  dash: string | undefined;
  /** 描边宽（0.7~1.0：再粗会压过节点卡片，再细在 0.25 倍缩放下消失）。 */
  width: number;
  /** 描边令牌名（颜色只能经 token()）。 */
  stroke: Parameters<typeof token>[0];
  /** 是否带箭头（只有"有方向的推进/人判"才需要方向感）。 */
  arrow: boolean;
  /** 曲率系数（0 = 直线；>0 = 贝塞尔控制点占水平跨距的比例）。 */
  curve: number;
}

export const EDGE_STYLES: Record<string, EdgeStyle> = {
  'cycle-seq': { dash: undefined, width: 0.9, stroke: 'anic-border-strong', arrow: true, curve: 0.45 },
  evidences: { dash: '3 2', width: 0.7, stroke: 'anic-text-faint', arrow: false, curve: 0.45 },
  'event-seq': { dash: '0.5 2.4', width: 0.7, stroke: 'anic-text-faint', arrow: false, curve: 0.2 },
  'human-gate': { dash: '6 3', width: 0.8, stroke: 'anic-border-strong', arrow: true, curve: 0.45 },
  'micro-entry': { dash: '2 2', width: 0.8, stroke: 'anic-border-strong', arrow: false, curve: 0.45 },
  'micro-exit': { dash: '2 2', width: 0.8, stroke: 'anic-border-strong', arrow: false, curve: 0.45 },
};

/** 未登记边类型：细实线无箭头 —— 宁可"少语义"也不要"不可见"。 */
export const DEFAULT_EDGE: EdgeStyle = {
  dash: undefined, width: 0.7, stroke: 'anic-border-strong', arrow: false, curve: 0.45,
};

export function edgeStyleOf(type: string): EdgeStyle {
  return EDGE_STYLES[type] ?? DEFAULT_EDGE;
}

/**
 * 边的路径几何（纯函数，可单测；也是"曲率形态至少 3 种"的可断言来源）。
 *
 * - 同一列（dx = 0）：垂直直线——两条同列相邻节点之间画曲线只会让它偏移到
 *   隔壁 lane 的视觉区，反而制造歧义；
 * - 跨列：三次贝塞尔，控制点在**两端水平外推** `curve * dx`，曲线在列间空地
 *   完成弯折，不压住任何卡片。
 */
export function edgePath(
  fromPos: { x: number; y: number },
  toPos: { x: number; y: number },
  curve: number,
): { d: string; kind: 'line' | 'curve' } {
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const round = (v: number): string => String(Math.round(v * 100) / 100);
  if (Math.abs(dx) < 1) {
    return { d: `M ${round(fromPos.x)} ${round(fromPos.y)} L ${round(toPos.x)} ${round(toPos.y)}`, kind: 'line' };
  }
  const c = dx * curve;
  const d = [
    `M ${round(fromPos.x)} ${round(fromPos.y)}`,
    `C ${round(fromPos.x + c)} ${round(fromPos.y)},`,
    `${round(toPos.x - c)} ${round(toPos.y)},`,
    `${round(toPos.x)} ${round(toPos.y)}`,
  ].join(' ');
  void dy; // dy 只用于"是否退化"的判断（见上），不参与控制点——对称曲线更稳。
  return { d, kind: 'curve' };
}

/** 单边渲染入参。 */
export interface EdgeRenderInput {
  from: string;
  to: string;
  /**
   * 边的语义类型（`cycle-seq` / `evidences` / `event-seq` / `human-gate` /
   * `micro-entry` / `micro-exit`）。
   *
   * cycle-83：从可选变必填。理由不只是"要多画几种线型"——它是**决策语义**的载体：
   * 六种边在图上读法完全不同（时序 vs 证据 vs 分支），而改造前六种语义共用一条
   * 实线，读者无从区分。必填让"新增一种边却忘了想它该怎么画"在**编译期**就红。
   */
  type: string;
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
  /** 两端中**较亮**的透明度（一端可见就该看得见这条边，见调用点注释）。 */
  opacity: number | undefined;
  /**
   * 追溯角色（cycle-84）：'up' = 这条边位于"原因链"上，'down' = 位于"结果链"上。
   * undefined = 未启用追溯（渲染与改造前逐字节等价）。
   */
  trace?: 'up' | 'down' | undefined;
}

export function renderEdge(input: EdgeRenderInput): ReactElement {
  const { from, to, fromPos, toPos, opacity } = input;
  const style = edgeStyleOf(input.type);
  const path = edgePath(fromPos, toPos, style.curve);
  const trace = input.trace ?? null;
  // 追溯态：加粗 + 换语义色（上游用 pass 绿 = "健康的方向来源"，下游用 warn 琥珀）。
  const traceStroke = trace === null ? null : trace === 'up' ? 'anic-pass' : 'anic-warn-text';
  return createElement('path', {
    // 数据派生稳定 key（from→to）：数组序号 key 在节点集插入/删除时全图错位 patch。
    key: `edge-${from}-${to}`,
    // 边锚点。smoke 与契约按**锚点数**断言边数，所以任何形态都必须带它。
    'data-anic-edge': input.type,
    'data-anic-edge-from': from,
    'data-anic-edge-to': to,
    // 追溯角色进 DOM：视觉加粗是 AT 读不到的通道（与节点 data-anic-trace 同纪律）。
    'data-anic-trace-edge': trace ?? 'none',
    // 线型与曲率进 DOM：既让"六种边至少三种形态"可断言，也让强制高对比模式下
    // 能单独给点线/虚线换成系统色（见 panelCss 的 forced-colors 块）。
    'data-anic-edge-dash': style.dash ?? 'solid',
    'data-anic-edge-curve': path.kind,
    d: path.d,
    fill: 'none',
    stroke: token(traceStroke ?? style.stroke),
    strokeWidth: trace === null ? style.width : style.width + 0.6,
    strokeDasharray: style.dash,
    markerEnd: style.arrow ? 'url(#anic-spike-arrow)' : undefined,
    opacity: trace === null ? opacity : (opacity === undefined ? 1 : Math.max(opacity, 0.85)),
  });
}

/** 箭头 marker（`<defs>` 内容；id 被 renderEdge 的 markerEnd 引用）。 */
export function renderArrowMarker(): ReactElement {
  return createElement(
    'marker',
    {
      key: 'arrow', id: 'anic-spike-arrow', viewBox: '0 0 10 10',
      refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse',
    },
    createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: token('anic-text-faint') }),
  );
}
