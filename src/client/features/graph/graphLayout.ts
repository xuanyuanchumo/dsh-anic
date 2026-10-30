/**
 * 确定性分层布局（cycle-82 建立 · cycle-83 改为**变尺寸卡片**）。
 *
 * ## 为什么必须变尺寸（这是 cycle-83 的根因，不是审美）
 *
 * cycle-82 用统一 46→26px 行距把 1520×5626 的竖条压成 9 列紧凑图，节点仍是
 * `<circle r=4~6>` + 一行 6.4px 文本。cycle-83 把节点升级成药丸卡片后，**卡片
 * 高度按类型分级**（phase/gate 46px、事件 34px），于是「统一行距」不再是布局参数，
 * 而是**每 lane 的 pitch = max(rowPitch, 该 lane 卡片高 + gap)**。若仍按 26px 排，
 * 46px 的卡片会压到下一张卡片上 —— 重叠是硬缺陷（用户看到的是一个糊在一起的块，
 * 而任何"节点数"断言都发现不了）。
 *
 * ## 三条不变量（`tests/unit/graphLayout.test.ts` 逐条钉死）
 *
 * - 节点一个不少、位置两两不同（同坐标 = 其中一个永久不可见）；
 * - 边原样保留（布局不改拓扑；悬空边留给渲染层跳过）；
 * - 纯函数：不读 clock / random / DOM，两次调用深相等；
 * - **输出顺序 = 输入顺序**（不是 lane 顺序）。渲染层按 `data.nodes` 顺序生成
 *   节点，`graphA11y` 契约靠「circle 顺序 == 节点顺序」对齐裁决字形。
 *
 * ## 折列判据从「行数」升级为「行数 + 像素高度」
 *
 * 变尺寸后"24 行"不再等价于"一屏高"：24 × 46px = 1104px，远超 cycle-82 的单列
 * 高度。现在同时守两条上限：`rowsPerColumn`（与既有测试同口径）与
 * `columnBudgetPx`（视觉上的单列像素高上限）。`columnBudgetPx: 840` 是取舍：
 * 它让 122 个门禁事件折成 7 列、总高 850px —— 仍是原高度 5626 的 **15.1%**，
 * 而宽高比 1.64 落在合同要求的 0.8~2.6 区间。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { nodeBoxOf } from './graphNodeBox.ts';

/**
 * lane 优先级 = 读图时的语义顺序（宏观 → 门禁 → 循环 → 事件 → 兜底）。
 * 写成常量而不是从数据里推导：类型集合是闭合的，顺序是**设计决定**，
 * 让它随数据首现顺序漂移会让同一份数据在不同 cycle 下画出不同图。
 */
export const LANE_ORDER: readonly string[] = [
  'phase', 'micro-step', 'gate', 'human-gate', 'cycle', 'gate-event', 'incident', 'autonomy',
];

/**
 * 布局尺度。四个数字都有明确依据，改动必须同时改测试里的量化断言：
 * - `rowPitch: 26`：**最小**行距（cycle-82 原值）。卡片比 26 高时以卡片高为准；
 * - `columnPitch: 120`：最宽卡片 112 + 8px 列间净空。改它要同步改契约 ⑤ 的取模断言；
 * - `rowsPerColumn: 24`：与既有测试同口径的行数上限（折列位置）；
 * - `columnBudgetPx: 840`：单列像素高上限。变尺寸后这才是真正的"一屏高"判据；
 * - `gap: 8`：同 lane 相邻卡片的垂直净空（小于 6 时卡片描边会在 0.5 倍缩放下粘连）。
 */
export const LAYOUT = {
  rowsPerColumn: 24,
  columnPitch: 120,
  rowPitch: 26,
  columnBudgetPx: 840,
  gap: 8,
} as const;

/** 包围盒四边留白（卡片描边 + 焦点环不被 viewBox 裁掉）。 */
const PAD = 12;

export interface PositionedNode extends WorkflowNode {
  /** 所属 lane（= node.type；未知类型也自成一 lane，不丢弃）。 */
  lane: string;
  column: number;
  row: number;
  /** 卡片左上角 x（= column * columnPitch）。 */
  x: number;
  /** 卡片**垂直中心** y。为什么是中心：色标圆点、裁决字形、两行文本全部围绕它居中。 */
  y: number;
  /** 卡片宽高（渲染层不再自己查表，避免布局与渲染各持一份尺寸）。 */
  w: number;
  h: number;
}

export interface LaneSummary {
  type: string;
  count: number;
  /** 该 lane 占用的列号（折列后可能多列，按填充顺序）。 */
  columns: number[];
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  /** 与输入 `nodes` **同序**（见文件头「输出顺序 = 输入顺序」）。 */
  nodes: PositionedNode[];
  edges: WorkflowEdge[];
  bounds: GraphBounds;
  lanes: LaneSummary[];
  columns: number;
}

/** lane 排序：已知类型按 LANE_ORDER，未知类型按字母序追加在尾部（确定性）。 */
function laneOrderOf(types: readonly string[]): string[] {
  const present = new Set(types);
  const known = LANE_ORDER.filter((t) => present.has(t));
  const unknown = types.filter((t) => !LANE_ORDER.includes(t)).sort();
  return [...known, ...unknown];
}

/**
 * 把 `total` 个节点均衡切成 `cols` 份：前 `total % cols` 份各多 1 个。
 * 切分结果之和恒等于 total（有断言），且任一份 ≤ ceil(total / cols)。
 */
export function balancedChunks(total: number, cols: number): number[] {
  if (cols <= 0 || total <= 0) return [];
  const base = Math.floor(total / cols);
  const extra = total % cols;
  return Array.from({ length: cols }, (_, i) => base + (i < extra ? 1 : 0));
}

/** 空图包围盒：给一个最小可见面，避免 viewBox 出现 0 宽高（SVG 会整块不渲染）。 */
const EMPTY_BOUNDS: GraphBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };

export function layoutGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): GraphLayout {
  const { rowsPerColumn, columnPitch, rowPitch, columnBudgetPx, gap } = LAYOUT;

  // 先按类型分桶，桶内**保持输入顺序**（cycle 序号、事件时间序都在输入顺序里）。
  const buckets = new Map<string, WorkflowNode[]>();
  for (const n of nodes) {
    const list = buckets.get(n.type);
    if (list === undefined) buckets.set(n.type, [n]);
    else list.push(n);
  }

  const placed = new Map<string, PositionedNode>();
  /** 每列已用像素高 / 已放节点数（两个上限各自记账，不能互相替代）。 */
  const colPx = new Map<number, number>();
  const colRows = new Map<number, number>();
  const lanes: LaneSummary[] = [];
  let column = 0;

  for (const type of laneOrderOf([...buckets.keys()])) {
    const list = buckets.get(type) ?? [];
    if (list.length === 0) continue;
    const box = nodeBoxOf(type);
    // lane pitch：卡片高 + 净空，但不得小于最小行距（矮卡片不该被排得更密）。
    const pitch = Math.max(rowPitch, box.h + gap);
    const perColumn = Math.max(1, Math.min(rowsPerColumn, Math.floor(columnBudgetPx / pitch)));
    const cols = Math.max(1, Math.ceil(list.length / perColumn));
    const sizes = balancedChunks(list.length, cols);
    const columnsOfLane: number[] = [];
    let cursor = 0;

    for (const size of sizes) {
      let usedPx = colPx.get(column) ?? 0;
      let usedRows = colRows.get(column) ?? 0;
      // 整块必须同时装进当前列的**像素高**与**行数**；装不下就换列。**不切半块**：
      // 同一 lane 的相邻节点被列边界任意切开后，读者找不到"下一个去哪"。
      if (usedPx + size * pitch > columnBudgetPx || usedRows + size > rowsPerColumn) {
        column += 1;
        usedPx = 0;
        usedRows = 0;
      }
      columnsOfLane.push(column);
      for (let i = 0; i < size; i += 1) {
        const node = list[cursor + i];
        if (node === undefined) continue;
        // 重复 id：**首个胜出**并跳过后续。位置唯一性是本模块的硬不变量，
        // 若让两个同 id 项各占一格，它们会在 `placed` 里互相覆盖而 DOM 里各留一份
        // ——两个点叠在同一坐标，其中一个永久不可见，而任何计数断言都看不出问题。
        if (placed.has(node.id)) continue;
        const top = usedPx + i * pitch;
        placed.set(node.id, {
          ...node,
          lane: type,
          column,
          row: usedRows + i,
          x: column * columnPitch,
          y: top + box.h / 2,
          w: box.w,
          h: box.h,
        });
      }
      colPx.set(column, usedPx + size * pitch);
      colRows.set(column, usedRows + size);
      cursor += size;
    }
    lanes.push({ type, count: list.length, columns: columnsOfLane });
  }

  if (placed.size === 0) {
    return { nodes: [], edges: [...edges], bounds: EMPTY_BOUNDS, lanes, columns: 0 };
  }

  // 按输入顺序回填（`placed` 只承担"位置查表"职责，不改顺序）。
  // `seen` 与 `placed` 是两件事：重复 id 会在输入里出现两次、在 placed 里只有一个
  // 位置，若不在这里去重，同一个位置会被 push 两遍 ⇒ 位置唯一性被破坏。
  const ordered: PositionedNode[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const p = placed.get(n.id);
    if (p === undefined || seen.has(p.id)) continue;
    seen.add(p.id);
    ordered.push(p);
  }

  // 包围盒按**卡片外接矩形**算（不是按锚点）：锚点只是中心，卡片上下的半高
  // 若不算进来，最上一行会有一半被 viewBox 裁掉。
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
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;
  return {
    nodes: ordered,
    edges: [...edges],
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    lanes,
    columns: Math.max(...ordered.map((p) => p.column)) + 1,
  };
}

/** 旧布局的包围盒（`snapshotCore` 的 5 列 × 46 行 + 渲染层 30px padding）。 */
export function legacyBounds(nodes: readonly WorkflowNode[]): GraphBounds {
  if (nodes.length === 0) return EMPTY_BOUNDS;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  // 与改造前 renderGraph 完全同款 padding，才谈得上"高度降到百分之多少"。
  const pad = 30;
  minX -= pad; minY -= pad; maxX += pad + 120; maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
