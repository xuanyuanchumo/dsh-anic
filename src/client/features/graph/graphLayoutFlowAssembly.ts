/**
 * `flow` 布局的**装配层**（cycle-94 · WS-A 收口）—— 把 `graphLayoutFlow.ts` 的四步
 * 纯算法装配成一个 `GraphLayout`，并补两个 `graphLayout.ts` 需要的入口。
 *
 * ## 为什么装配要单独一个文件（不是行数问题）
 *
 * `graphLayoutFlow.ts` 里全是**判据**：怎么分层、怎么排序、怎么铺排、怎么数交叉。
 * 它们各自可以被独立断言（`tests/unit/graphLayoutFlow.test.ts`），谁都不需要知道
 * 「最终要产出 `GraphLayout` 这个形状」。
 *
 * 本文件相反：它只做**形状适配**——把 `PositionedNode[]` / 包围盒 / `lanes` /
 * `crossings` 拼成渲染层要的那个对象。混进算法文件里，会让「想改铺排判据的人」
 * 必须从装配代码里把它捞出来；而装配代码与 `graphLayout.ts` 的 `GraphLayout`
 * 类型是同步演进的，两者变更节奏一致，所以它们在一起是对的。
 *
 * ## 宽高比与 PAD 为什么与 lane 模式共用同一套常量
 *
 * `PAD = 12` 与 `LAYOUT_ASPECT_BOUNDS` 是**验收线**（`graphLayout.test.ts` 与
 * `graphInteractiveContract.test.ts ⑤` 用同一对数）。若 flow 自己写一份 PAD，
 * 两份数一旦漂移，同一条验收线就会对着两张不同的图判定 —— 那正是本仓
 * `LAYOUT_ASPECT_BOUNDS` 头注反复强调「判据只有一个来源」的原因。
 *
 * ⇒ 从 `graphLayout.ts` 侧**注入**这两个量（依赖方向是 装配 → 算法，不是反过来）。
 *
 * ## 边界
 *
 * 纯函数、零 IO、零 DOM。不改输入。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { specOf } from './graphLayoutSpec.ts';
import { assignCoordinates, crossingsOf, layerAssign, orderWithinLayers } from './graphLayoutFlow.ts';
import type { GraphBounds, GraphLayout, LaneSummary, PositionedNode } from './graphLayoutTypes.ts';

/**
 * 从**已定位**的节点表算交叉数（同口径：`lane` 与 `flow` 都用这一把尺）。
 *
 * 为什么要有这个包装而不是让调用方自己建两张 Map：`PositionedNode` 上已有
 * `column` / `row` 两个语义量，调用方各建一次 Map 就多两处「谁是列谁是行」的
 * 约定 —— 而这两处约定一旦有一处写反，交叉数会**静默**变成另一个数（不会报错，
 * 只是比较结果无意义）。收在一处，写反只有一次机会。
 */
export function crossingsFromPositions(
  edges: readonly WorkflowEdge[],
  nodes: readonly PositionedNode[],
): number {
  const columnOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  for (const n of nodes) {
    columnOf.set(n.id, n.column);
    rowOf.set(n.id, n.row);
  }
  return crossingsOf(edges, columnOf, rowOf);
}

/** 计算节点外接矩形的包围盒（含 `pad` 四边留白）。空输入 → 零尺寸盒（不抛）。 */
function boundsOf(nodes: readonly PositionedNode[], pad: number): GraphBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    // 卡片以 y 为**垂直中心**（见 graphLayoutTypes.PositionedNode.y 的注释）。
    if (n.y - n.h / 2 < minY) minY = n.y - n.h / 2;
    if (n.y + n.h / 2 > maxY) maxY = n.y + n.h / 2;
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 按 lane 汇总（flow 模式没有"列"，所以 `columns` 恒为空数组 —— 渲染层据此
 *  知道"不要画泳道表头"，而不是去猜 mode）。 */
function summarizeLanes(nodes: readonly PositionedNode[]): LaneSummary[] {
  const byType = new Map<string, { count: number }>();
  for (const n of nodes) {
    const cur = byType.get(n.type);
    if (cur === undefined) byType.set(n.type, { count: 1 });
    else cur.count += 1;
  }
  return [...byType.entries()].map(([type, v]) => ({ type, count: v.count, columns: [] }));
}

/**
 * `flow` 模式的布局入口：分层 → 层内排序 → 坐标分配 → 交叉计数 → 装配。
 *
 * `crossings` 是**本模式唯一的可断言质量读数**：它让「flow 比 lane 少交叉」
 * 从断言变成契约（`tests/unit/graphLayoutFlowContract.test.ts`）。
 *
 * @param pad 包围盒四边留白（由 `graphLayout.ts` 注入，判据单一来源）
 */
export function flowLayout(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  pad: number,
): GraphLayout {
  const spec = specOf('flow');
  // 空图：与 lane 模式同形的空结果（不是抛错 —— 未 init 项目必须可用）。
  if (nodes.length === 0) {
    return {
      nodes: [], edges: [...edges], bounds: boundsOf([], pad),
      lanes: [], laneHeaders: [], mode: 'flow', columns: 0, crossings: 0,
    };
  }
  const layering = layerAssign(nodes, edges);
  const ordered = orderWithinLayers(layering.layers, edges);
  const positioned = assignCoordinates(nodes, ordered, spec);
  const crossings = crossingsFromPositions(edges, positioned);
  const columns = positioned.reduce((m, n) => Math.max(m, n.column + 1), 0);
  return {
    nodes: positioned,
    edges: [...edges],
    bounds: boundsOf(positioned, pad),
    lanes: summarizeLanes(positioned),
    // flow 没有泳道表头：表头的语义是"这一列属于哪条 lane"，而 flow 的列是**层**，
    // 一层里混着多种 lane。画表头会撒谎 ⇒ 空数组。
    laneHeaders: [],
    mode: 'flow',
    columns,
    crossings,
  };
}
