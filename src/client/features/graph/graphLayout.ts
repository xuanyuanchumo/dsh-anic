/**
 * 确定性分层布局（cycle-82 建立 · cycle-83 变尺寸卡片 · cycle-90 加泳道表头与布局模式）。
 *
 * ## 三条不变量（`tests/unit/graphLayout.test.ts` 逐条钉死）
 *
 * - 节点一个不少、位置两两不同（同坐标 = 其中一个永久不可见）；
 * - 边原样保留（布局不改拓扑；悬空边留给渲染层跳过）；
 * - 纯函数：不读 clock / random / DOM，两次调用深相等，**不修改输入**；
 * - **输出顺序 = 输入顺序**（不是 lane 顺序）。渲染层按 `data.nodes` 顺序生成
 *   节点，`graphA11y` 契约靠「circle 顺序 == 节点顺序」对齐裁决字形。
 *
 * ## 三步分工（本文件是**编排层**，不重复任何一步的推理）
 *
 * ① 折列（`graphLayoutPlan.planColumns`）：谁在哪一列、每段起点多少像素；
 * ② 表头带（`graphLanePlacement.placeLaneHeaders`）：在每段上方插入标注带，
 *    该列内容整体下移；
 * ③ 回填与包围盒（本文件）：按输入顺序回填，算出 viewBox。
 *
 * 拆分的理由是**职责**而非行数：折列决策（行数上限 + 像素高上限 + 不切半块）
 * 与表头几何是两件独立的事，混在一起时改折列参数（cycle-89 宽高比爆炸的那次
 * 改动）很难看清"我到底动了哪条判据"。
 *
 * ## 泳道表头为什么由布局算位置，而不是渲染层自己猜
 *
 * 渲染层能看见的只有「节点在哪」，看不见「这一列属于哪条 lane、这条 lane 从
 * 第几行开始」。若让渲染层按 `LaneSummary.columns` 反推表头位置，就得自己
 * 重算一遍「列内段序」—— 而段序是布局过程的**中间产物**。两处各算一遍必然
 * 漂移（改折列算法时表头会错位，而**没有任何断言会发现**）。
 *
 * ## 表头带不计入 columnBudgetPx —— 这是**有意的**
 *
 * `columnBudgetPx` 管的是「卡片内容一列能装多高」；表头是**标注**不是内容，
 * 计入它会让折列位置随「这一列恰好切在第几个 lane」而漂移（同一条 lane 在不同
 * 数据下落到不同列 ⇒ 同样的节点集合画出不同的列结构）。
 * 表头带只计入**包围盒高度**（它确实占地方），否则表头会被 viewBox 裁掉一半。
 *
 * ## 布局模式（cycle-90）
 *
 * `layoutGraph(nodes, edges, options?)` 的 `options.mode` 是**可选参数**：
 * 缺省 = `lane`（按泳道折列，与改造前同构，只是多了表头带）。
 * 两种模式的参数表在 `graphLayoutSpec.ts`（判据只有一份来源）。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { nodeBoxOf } from './graphNodeBox.ts';
import { placeLaneHeaders } from './graphLanePlacement.ts';
import { planColumns } from './graphLayoutPlan.ts';
import { specOf, type LayoutMode } from './graphLayoutSpec.ts';
// 空图包围盒（与旧布局基线同源，见 graphLegacyBounds.ts 头注）。
import { EMPTY_BOUNDS } from './graphLegacyBounds.ts';
import type {
  PositionedNode, LaneSummary, LaneHeaderPlacement, GraphBounds, GraphLayout,
} from './graphLayoutTypes.ts';

/**
 * 规格与判据的**再导出**（导入路径零变更的回归红线）。
 *
 * `tests/unit/graphLayout.test.ts` 与 `tests/contract/graphInteractiveContract.test.ts`
 * 都从本文件 import `LAYOUT` / `LAYOUT_ASPECT_BOUNDS` / `LANE_ORDER`——
 * 拆文件不该让它们改 import。
 */
export {
  LAYOUT, LAYOUT_ASPECT_BOUNDS, LAYOUT_MODES, LANE_HEADER_H, LANE_ORDER, specOf,
} from './graphLayoutSpec.ts';
export type { LayoutMode, LayoutSpec } from './graphLayoutSpec.ts';

/**
 * 形状契约的**再导出**（导入路径零变更的回归红线）。
 *
 * 12 个消费者（渲染层 / 视口 / 缩放 / 小地图 / 导出 / 契约测试）都从本文件
 * import `GraphLayout` / `PositionedNode` / `GraphBounds` 等类型 —— 拆文件
 * 不该让它们改 import。类型声明本体在 `graphLayoutTypes.ts`（纯静态）。
 */
export type {
  PositionedNode, LaneSummary, LaneHeaderPlacement, GraphBounds, GraphLayout,
} from './graphLayoutTypes.ts';

export { balancedChunks, laneOrderOf } from './graphLayoutPlan.ts';
export { legacyBounds, EMPTY_BOUNDS } from './graphLegacyBounds.ts';

/** 包围盒四边留白（卡片描边 + 焦点环不被 viewBox 裁掉）。 */
const PAD = 12;

/**
 * 布局主算法。
 *
 * @param options.mode 布局模式；缺省 `lane`（与改造前同构，只是多了表头带）。
 */
export function layoutGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  options?: { mode?: LayoutMode },
): GraphLayout {
  const mode: LayoutMode = options?.mode === 'compact' ? 'compact' : 'lane';
  const spec = specOf(mode);
  const plan = planColumns(nodes, spec);

  if (plan.lanes.length === 0) {
    return {
      nodes: [], edges: [...edges], bounds: EMPTY_BOUNDS, lanes: [],
      laneHeaders: [], mode, columns: 0,
    };
  }

  // ② 表头落位（几何约定见 graphLanePlacement 头注）。
  const { headers: laneHeaders, nodeShift } = placeLaneHeaders(
    plan.segments, plan.lanes, spec.columnPitch,
  );

  // ③ 回填：按输入顺序产出节点（位置表只承担「位置查表」职责，不改顺序）。
  // `seen` 与位置表是两件事：重复 id 会在输入里出现两次、在位置表里只有一个
  // 位置，若不在这里去重，同一个位置会被 push 两遍 ⇒ 位置唯一性被破坏。
  const ordered: PositionedNode[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const spot = spotOf(plan.segments, n.id);
    if (spot === undefined || seen.has(n.id)) continue;
    seen.add(n.id);
    const box = nodeBoxOf(spot.type);
    const shift = nodeShift.get(n.id) ?? 0;
    ordered.push({
      ...n,
      lane: spot.type,
      column: spot.column,
      row: spot.startRow + spot.index,
      x: spot.column * spec.columnPitch,
      y: spot.startPx + shift + spot.index * spot.pitch + box.h / 2,
      w: box.w,
      h: box.h,
    });
  }

  // 包围盒按**卡片外接矩形**算（不是按锚点）：锚点只是中心，卡片上下的半高
  // 若不算进来，最上一行会有一半被 viewBox 裁掉。表头带上沿也要算进去
  // ——否则表头会被裁掉一半（而这正是「表头看不见了」最常见的原因）。
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of ordered) {
    if (p.x < minX) minX = p.x;
    if (p.x + p.w > maxX) maxX = p.x + p.w;
    if (p.y - p.h / 2 < minY) minY = p.y - p.h / 2;
    if (p.y + p.h / 2 > maxY) maxY = p.y + p.h / 2;
  }
  for (const h of laneHeaders) if (h.y < minY) minY = h.y;
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;
  const lanes: LaneSummary[] = plan.lanes;
  return {
    nodes: ordered,
    edges: [...edges],
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    lanes,
    laneHeaders,
    mode,
    columns: plan.columns,
  };
}

/** 节点在折列计划里的落点（哪一段、段内第几个）。 */
interface Spot {
  type: string;
  column: number;
  startPx: number;
  pitch: number;
  startRow: number;
  index: number;
}

/**
 * 找出某个节点 id 落在哪一段的哪个位置。
 *
 * 复杂度 O(总段数)：段数 = 列数 × 每列段数 ≈ 几十，比「每节点建一张表」更省，
 * 且**不引入额外状态**（纯查表）。
 */
function spotOf(
  segments: ReadonlyMap<number, ReadonlyArray<{
    type: string; column: number; startPx: number; pitch: number; startRow: number; ids: string[];
  }>>,
  id: string,
): Spot | undefined {
  for (const segs of segments.values()) {
    for (const seg of segs) {
      const index = seg.ids.indexOf(id);
      if (index < 0) continue;
      return {
        type: seg.type,
        column: seg.column,
        startPx: seg.startPx,
        pitch: seg.pitch,
        startRow: seg.startRow,
        index,
      };
    }
  }
  return undefined;
}
