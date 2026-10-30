/**
 * 布局的**形状声明**（cycle-90 · 从 `graphLayout.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `graphLayout.ts` 回答的是「节点摆在哪」（**算法**），本文件回答的是
 * 「摆完长什么样」（**形状契约**）。两者混在一起时，渲染层要 import
 * `GraphLayout` 这个**类型**就必须把整个算法文件拖进依赖图 —— 于是
 * 「只想拿个类型」的消费者被迫依赖算法实现。
 *
 * 更实际的原因：算法文件里算法本身就要占大半篇幅（分桶 → 折列 → 落表头
 * → 算包围盒），再叠 70 行类型声明就必然破 250 行。类型声明是**静态**的，
 * 算法是**行为**的，两者的变更节奏不同 —— 拆开各自能独立演进。
 *
 * ## 为什么消费者 import 路径不变
 *
 * `graphLayout.ts` 侧**再导出**本文件全部类型（见该文件的 re-export 段），
 * 于是 `import type { GraphLayout } from './graphLayout.ts'` 这类既有写法
 * 全部保持有效 —— 拆文件不该让 12 个消费者改 import。
 *
 * ## 边界
 *
 * 纯类型声明：零运行时值、零逻辑、零 IO。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';

export interface PositionedNode extends WorkflowNode {
  /** 所属 lane（= node.type；未知类型也自成一 lane，不丢弃）。 */
  lane: string;
  column: number;
  /**
   * 列内**内容**行号（不含表头带）。
   *
   * 为什么不是"视觉行号"：表头带是标注，插入它会让同一 lane 在不同列的行号
   * 不可比。内容行号才是"这条 lane 的第几个节点"，跨列可比。
   */
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

/** 泳道表头的落位（由布局算出，渲染层只画）。 */
export interface LaneHeaderPlacement {
  /** lane 类型（= 节点 type）。 */
  type: string;
  /** 该 lane 的节点总数（= `LaneSummary.count`）。 */
  count: number;
  /** 该 lane 在**这一列**里的节点数（"这一列有多少"比总数更贴近视线）。 */
  columnCount: number;
  /** 所在列号。 */
  column: number;
  /** 表头带左缘 x（= column * columnPitch）。 */
  x: number;
  /** 表头带**上沿** y（世界坐标）。 */
  y: number;
  /** 表头带高度（= `LANE_HEADER_H`）。 */
  h: number;
  /**
   * 本段（该列内该 lane 的这一块）的节点 id。
   *
   * 为什么带 id：表头要显示"命中/总数"两段计数，命中数只能靠节点表反查。
   * 布局是唯一知道"这一段包含哪些节点"的地方（渲染层拿不到段结构），
   * 所以 id 列表在这里产出。
   */
  ids: string[];
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
  /** 与输入 `nodes` **同序**（见 graphLayout.ts 文件头「输出顺序 = 输入顺序」）。 */
  nodes: PositionedNode[];
  edges: WorkflowEdge[];
  bounds: GraphBounds;
  lanes: LaneSummary[];
  /** 泳道表头落位（每列一段一个表头；顺序 = 列内自上而下）。 */
  laneHeaders: LaneHeaderPlacement[];
  /** 本次布局用的模式（默认 `lane`）。 */
  mode: LayoutMode;
  columns: number;
}
