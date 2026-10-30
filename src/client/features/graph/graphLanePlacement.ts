/**
 * 泳道表头的**落位算法**（cycle-90 · 从 `graphLayout.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么表头位置由布局算，而不是渲染层自己猜
 *
 * 渲染层能看见的只有「节点在哪」，看不见「这一列属于哪条 lane、这条 lane 从
 * 第几行开始」。若让渲染层按 `LaneSummary.columns` 反推表头位置，就得自己
 * 重算一遍「列内段序」—— 而段序是布局过程的**中间产物**（同一列里 lane A 结束后
 * 才轮到 lane B）。两处各算一遍必然漂移：改折列算法时表头会错位，而**没有任何
 * 断言会发现**（表头只是画歪了，不会报错）。
 *
 * 所以本模块是**纯函数**：输入列内段序列 + lane 计数，输出
 * ① 表头落位列表 ② 每个节点需要下移的像素偏移。渲染层只负责画。
 *
 * ## 几何约定（为什么偏移是 i*H 而不是别的）
 *
 * 列内第 i 段的表头占 `[startPx + i*H - H, startPx + i*H]`，该列内容整体
 * 下移 `i*H`（i = 该段在列内的序号，从 0 起）。于是：
 *   - 第 0 段的表头顶端 = startPx - H（**悬在**列内容上方，不占内容高度）；
 *   - 第 1 段的表头顶端 = startPx + H - H = startPx（正好接在第 0 段内容之下）。
 *
 * 表头带**不计入 columnBudgetPx**（见 graphLayoutSpec.ts 头注）：它是标注不是
 * 内容，计入会让折列位置随「这一列恰好切在第几个 lane」而漂移。它只计入
 * **包围盒高度**（它确实占地方），否则表头会被 viewBox 裁掉一半。
 *
 * ## 边界
 *
 * 纯函数：零 DOM、零 clock、零 random、零 IO；不修改入参。
 */
import { LANE_HEADER_H } from './graphLayoutSpec.ts';
import type { LaneHeaderPlacement, LaneSummary } from './graphLayoutTypes.ts';

/** 列内的一段（同一条 lane 在同一列里的连续块）。表头按段插入。 */
export interface ColumnSegment {
  /** lane 类型（= 节点 type）。 */
  type: string;
  /** 所在列号。 */
  column: number;
  /** 段起始像素（列内，**不含**表头带）。 */
  startPx: number;
  /** 段内节点 id。 */
  ids: readonly string[];
}

/** 落位结果：表头列表 + 每节点的下移偏移。 */
export interface LaneHeaderPlacementResult {
  /** 表头落位（顺序 = 列内自上而下）。 */
  headers: LaneHeaderPlacement[];
  /** 节点 id → 该节点需要下移的像素数（表头让位）。 */
  nodeShift: Map<string, number>;
}

/**
 * 由列内段序列算出表头落位与节点下移偏移。
 *
 * @param segments 每列的段序列（列内自上而下）。
 * @param lanes 各 lane 的总数（表头显示「这一类一共多少个」）。
 * @param columnPitch 列距（表头 x = column * columnPitch）。
 */
export function placeLaneHeaders(
  segments: ReadonlyMap<number, readonly ColumnSegment[]>,
  lanes: readonly LaneSummary[],
  columnPitch: number,
): LaneHeaderPlacementResult {
  const nodeShift = new Map<string, number>();
  const headers: LaneHeaderPlacement[] = [];
  for (const segs of segments.values()) {
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i] as ColumnSegment;
      const shift = i * LANE_HEADER_H;
      for (const id of seg.ids) nodeShift.set(id, shift);
      const lane = lanes.find((l) => l.type === seg.type);
      headers.push({
        type: seg.type,
        count: lane?.count ?? seg.ids.length,
        columnCount: seg.ids.length,
        column: seg.column,
        x: seg.column * columnPitch,
        y: seg.startPx + shift - LANE_HEADER_H,
        h: LANE_HEADER_H,
        ids: [...seg.ids],
      });
    }
  }
  return { headers, nodeShift };
}
