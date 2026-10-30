/**
 * 折列计划（cycle-90）——「谁在哪一列、每段起点多少像素」这一步的纯实现。
 *
 * ## 为什么把这一步单独拆出来
 *
 * `graphLayout.ts` 由三步组成：① 分桶并折列（本文件）；② 插入泳道表头带
 * （`graphLanePlacement.ts`）；③ 回填输入顺序并算包围盒。
 *
 * 拆分的理由是**职责**，不是行数：折列决策（行数上限 + 像素高上限 + 不切半块）
 * 这一段推理值得单独读 —— 而 cycle-89 的宽高比爆炸恰恰发生在**改折列参数**的
 * 那一刻，那一刻最需要看清的正是折列本身，不该被表头偏移与包围盒淹没。
 *
 * ## 纯函数
 *
 * 零 DOM、零 clock、零 random；输入相同 ⇒ 输出相同。**不修改输入**。
 */
import type { WorkflowNode } from '../../workflowGraphData.ts';
import { nodeBoxOf, type NodeBox } from './graphNodeBox.ts';
import { LANE_ORDER, type LayoutSpec } from './graphLayoutSpec.ts';

/** 列内的一段（同一条 lane 在同一列里的连续块）。表头按段插入。 */
export interface LayoutSegment {
  /** lane 类型。 */
  type: string;
  /** 所在列号。 */
  column: number;
  /** 段起始像素（列内，**不含**表头带）。 */
  startPx: number;
  /** 段内节点数。 */
  size: number;
  /** lane pitch（卡片高 + 净空，不小于最小行距）。 */
  pitch: number;
  /** 该 lane 的卡片尺寸。 */
  box: NodeBox;
  /** 段内节点 id（重复 id 会被跳过 —— 首个胜出，见文件头「重复 id」注释）。 */
  ids: string[];
  /**
   * 本段起始的**内容行号**（列内，跨段连续）。
   *
   * 为什么单独存：`row` 是"列内第几个节点"，它跨段连续（同一列里 lane A 的
   * 节点与 lane B 的节点在同一行号序列里），而段序是另一回事。
   */
  startRow: number;
}

/** 一条 lane 的折列结果。 */
export interface LaneLayout {
  type: string;
  count: number;
  /** 该 lane 占用的列号（折列后可能多列，按填充顺序）。 */
  columns: number[];
}

/** 折列产物（②③ 两步的输入）。 */
export interface ColumnPlan {
  /** 每列的段序列（按列内自上而下）。 */
  segments: Map<number, LayoutSegment[]>;
  /** 每条 lane 的汇总。 */
  lanes: LaneLayout[];
  /** 总列数（0 = 空图）。 */
  columns: number;
}

/** lane 排序：已知类型按 LANE_ORDER，未知类型按字母序追加在尾部（确定性）。 */
export function laneOrderOf(types: readonly string[]): string[] {
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

/**
 * 折列计划（纯函数）。
 *
 * @param nodes 输入节点（**只读**；本函数不修改它）
 * @param spec 尺度参数（来自 `graphLayoutSpec.specOf(mode)`）
 */
export function planColumns(
  nodes: readonly WorkflowNode[],
  spec: LayoutSpec,
): ColumnPlan {
  const { rowsPerColumn, columnPitch, rowPitch, columnBudgetPx, gap } = spec;

  // 先按类型分桶，桶内**保持输入顺序**（cycle 序号、事件时间序都在输入顺序里）。
  const buckets = new Map<string, WorkflowNode[]>();
  for (const n of nodes) {
    const list = buckets.get(n.type);
    if (list === undefined) buckets.set(n.type, [n]);
    else list.push(n);
  }

  /** 每列已用像素高 / 已放节点数（两个上限各自记账，不能互相替代）。 */
  const colPx = new Map<number, number>();
  const colRows = new Map<number, number>();
  const segments = new Map<number, LayoutSegment[]>();
  const lanes: LaneLayout[] = [];
  /** 全局已占用的 id（重复 id 首个胜出 —— 见文件头「重复 id」注释）。 */
  const taken = new Set<string>();
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
      const segs = segments.get(column) ?? [];
      const seg: LayoutSegment = {
        type, column, startPx: usedPx, size, pitch, box, ids: [], startRow: usedRows,
      };
      segs.push(seg);
      segments.set(column, segs);

      for (let i = 0; i < size; i += 1) {
        const node = list[cursor + i];
        if (node === undefined) continue;
        // 重复 id：**首个胜出**并跳过后续。位置唯一性是本模块的硬不变量，
        // 若让两个同 id 项各占一格，它们会在位置表里互相覆盖而 DOM 里各留一份
        // ——两个点叠在同一坐标，其中一个永久不可见，而任何计数断言都看不出问题。
        if (taken.has(node.id)) continue;
        taken.add(node.id);
        seg.ids.push(node.id);
      }
      colPx.set(column, usedPx + size * pitch);
      colRows.set(column, usedRows + seg.ids.length);
      cursor += size;
    }
    lanes.push({ type, count: list.length, columns: columnsOfLane });
  }

  return { segments, lanes, columns: lanes.length === 0 ? 0 : column + 1 };
}
