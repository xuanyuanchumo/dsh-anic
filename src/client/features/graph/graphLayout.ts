/**
 * 确定性分层布局（cycle-82 · G 战线）——把「竖长条」换成「可按类型阅读的层带」。
 *
 * ## 被替换的缺陷（实测，不是推断）
 *
 * 旧坐标在 `src/shared/snapshotCore.ts:140` 生成：`x = 列号 * 380`、`y = 行号 * 46`，
 * 五个固定列各自单调递增 y。对真实 `artifacts/workflow-snapshot.json`（188 节点 /
 * 292 边）实测得到 **1520 × 5626** 的画布 —— 比例 0.27:1 的竖条。一屏只能看到十个点，
 * 且同一列里 cycle 的 43 个点排成一条直线，门禁事件的上百个点排成另一条直线，
 * 「谁连谁」这个图唯一的价值被 5000px 的空白抹掉了。
 *
 * ## 为什么是「分类型 lane + 定行数折列」，而不是图布局算法
 *
 * 1. 零运行时依赖是硬纪律（`dependencies` 至今为空），dagre / elkjs / d3-force 进不来；
 * 2. 本图的数据形态**不是**任意有向图：节点天然分类型（阶段 / 微步骤 / 门禁 / 人审门 /
 *    cycle / 门禁事件 / 事故 / 自主级），每个类型内部有既定语义顺序（cycle 按序号、
 *    事件按时间），类型之间才是边的关系。分 lane 把这层语义显式化了；
 * 3. 力导向布局**不确定** —— 同输入不同输出，写不出「同输入同输出」的断言，
 *    也就写不出契约测试。**不可测的布局等于不可维护**（这是本轮拒绝 dagre 的
 *    主要理由，不是"省依赖"）。
 *
 * ## 为什么每列行数是「均衡切分」而不是「填满再换列」
 *
 * 若按「先填满 24 行再开新列」硬切，cycle 的 43 个点会切成 24 + 19，最后那列空 5 行；
 * gate-event 的 122 个点会切成 5 列 × 25（**超出** rowsPerColumn，破坏"单列高度上限"
 * 这条唯一可断言的性质）。均衡切成 22+21、以及 21+21+20×4，则所有列几乎同高，
 * 包围盒最紧，且「任何一列的高度都 ≤ rowsPerColumn * rowPitch」成为可断言的不变量。
 *
 * ## 不变量（`tests/unit/graphLayout.test.ts` 逐条钉死）
 *
 * - 节点一个不少、位置两两不同（同一坐标摞两个点，视觉上等于丢了一个）；
 * - 边原样保留（布局不改拓扑；悬空边留给渲染层跳过，因为那是渲染契约的事）；
 * - 纯函数：不读 clock / random / DOM，两次调用深相等；
 * - **输出顺序 = 输入顺序**（不是 lane 顺序）。渲染层按 `data.nodes` 顺序生成 DOM，
 *   既有 `graphA11y` 契约靠「circle 顺序 == 节点顺序」把裁决字形对齐到节点，
 *   顺序一换就假红。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';

/**
 * lane 优先级 = 读图时的语义顺序（宏观 → 门禁 → 循环 → 事件 → 兜底）。
 * 写成常量而不是从数据里推导：类型集合是闭合的，顺序是**设计决定**，
 * 让它随数据首现顺序漂移会让同一份数据在不同 cycle 下画出不同图。
 */
export const LANE_ORDER: readonly string[] = [
  'phase', 'micro-step', 'gate', 'human-gate', 'cycle', 'gate-event', 'incident', 'autonomy',
];

/**
 * 布局尺度。三个数字都有明确依据，改动必须同时改测试里的量化断言：
 * - `rowPitch: 26`：原 46。节点直径最大 14px、标签 7px，26 行距留下 12px 呼吸，
 *   是"再压就粘连"的位置（18 以下标签会压到下一点的圆）；
 * - `columnPitch: 120`：标签最长 12 字 × 7px 等宽 ≈ 50px，加圆点与 9px 偏移后
 *   右缘约 60px；120 留一半空隙，缩到 0.5 倍时列间文字仍不打架；
 * - `rowsPerColumn: 24`：决定折列位置。24 行 × 26 = 624px 单列高度，配合 188 个
 *   节点算出 9 列 ≈ 1080 宽 —— 宽高比 1.7，逼近 16:9。
 */
export const LAYOUT = { rowsPerColumn: 24, columnPitch: 120, rowPitch: 26 } as const;

/** 包围盒左/上留白（圆点半径 + 焦点环 offset 不被裁）。 */
const EDGE_PAD = 12;
/** 最右列的标签余量：标签画在圆点右侧，不算进余量就会被 viewBox 裁掉。 */
const LABEL_ALLOWANCE = 76;

export interface PositionedNode extends WorkflowNode {
  /** 所属 lane（= node.type；未知类型也自成一 lane，不丢弃）。 */
  lane: string;
  column: number;
  row: number;
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
  const { rowsPerColumn, columnPitch, rowPitch } = LAYOUT;

  // 先按类型分桶，桶内**保持输入顺序**（cycle 序号、事件时间序都在输入顺序里）。
  const buckets = new Map<string, WorkflowNode[]>();
  for (const n of nodes) {
    const list = buckets.get(n.type);
    if (list === undefined) buckets.set(n.type, [n]);
    else list.push(n);
  }

  const placed = new Map<string, PositionedNode>();
  const lanes: LaneSummary[] = [];
  let column = 0;
  let row = 0;

  for (const type of laneOrderOf([...buckets.keys()])) {
    const list = buckets.get(type) ?? [];
    if (list.length === 0) continue;
    const cols = Math.max(1, Math.ceil(list.length / rowsPerColumn));
    const sizes = balancedChunks(list.length, cols);
    const columnsOfLane: number[] = [];
    let cursor = 0;

    for (const size of sizes) {
      // 整块必须装进当前列的剩余行；装不下就换列。**不切半块**：
      // 同一 lane 的相邻节点被列边界任意切开后，读者找不到"下一个去哪"。
      if (row + size > rowsPerColumn) { column += 1; row = 0; }
      columnsOfLane.push(column);
      for (let i = 0; i < size; i += 1) {
        const node = list[cursor + i];
        if (node === undefined) continue;
        // 重复 id：**首个胜出**并跳过后续。位置唯一性是本模块的硬不变量，
        // 若让两个同 id 项各占一格，它们会在 `placed` 里互相覆盖而 DOM 里各留一份
        // ——两个点叠在同一坐标，其中一个永久不可见，而任何计数断言都看不出问题。
        // 真实数据 188 个 id 全唯一；这条只定义"数据变脏时行为可预测"，不是常态路径。
        if (placed.has(node.id)) continue;
        placed.set(node.id, {
          ...node,
          lane: type,
          column,
          row,
          x: column * columnPitch,
          y: row * rowPitch,
        });
        row += 1;
      }
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
  let maxRow = 0;
  let maxCol = 0;
  for (const n of nodes) {
    const p = placed.get(n.id);
    if (p === undefined || seen.has(p.id)) continue;
    seen.add(p.id);
    ordered.push(p);
    if (p.row > maxRow) maxRow = p.row;
    if (p.column > maxCol) maxCol = p.column;
  }

  const base = {
    minX: -EDGE_PAD,
    minY: -EDGE_PAD,
    maxX: maxCol * columnPitch + LABEL_ALLOWANCE,
    maxY: maxRow * rowPitch + EDGE_PAD,
  };
  return {
    nodes: ordered,
    edges: [...edges],
    bounds: { ...base, width: base.maxX - base.minX, height: base.maxY - base.minY },
    lanes,
    columns: maxCol + 1,
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
