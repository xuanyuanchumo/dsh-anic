import { nodeBoxOf, type NodeBox } from './graphNodeBox.ts';
import type { LayoutSpec } from './graphLayoutSpec.ts';

/**
 * 层带**铺排**（把「每层按 barycenter 序的 id 列表」变成坐标）—— cycle-94 · 从
 * `graphLayoutFlow.ts` 拆出。
 *
 * ## 为什么独立成文件
 *
 * 「怎么分层/排序」（`graphLayoutFlow.ts`）与「分层结果怎么摆到坐标上」（本文件）
 * 是两件事：前者是**拓扑**问题（跟边有关），后者是**几何**问题（只跟尺寸参数有关）。
 * 混在一起时，调像素常量的人会顺手改分层逻辑 —— 而分层那三条推理
 * （断环、最长路径、barycenter）恰恰是最容易被改错的部分。
 */
/** 铺排产物（节点 id → 坐标 + 层内序号，以及整体宽高）。 */
export interface FlowPlacement {
  spots: Map<string, { x: number; y: number; seq: number }>;
  width: number;
  height: number;
}

/**
 * 单档容量铺排（层 = 列，层内按 barycenter 序纵向堆叠）。
 *
 * ## 几何约定（换轴后的正确形态）
 *
 * ```
 * 层0     层1     层2           层N      宽度 = 层数 × columnPitch
 * ┌──┐    ┌──┐    ┌──┐          ┌──┐     高度 = 最高层的节点数 × 行距
 * │a │──▶ │c │──▶ │e │          │… │
 * └──┘    └──┘    └──┘          └──┘
 * ┌──┐   ← 同层内节点纵向堆叠（按 barycenter 序）
 * │b │
 * └──┘
 * ```
 *
 * ## 两次返工的教训（都记在这里，避免后人重踩）
 *
 * 1. **初版把层纵向堆**（`y += pitch`）：13 层长链 ⇒ 宽 120 / 高 790 ⇒ 宽高比
 *    **0.15**（验收下限 0.8），画出来是一根竖条。工作流的自然阅读方向是**从左到右**。
 * 2. **换轴后 `cap` 语义反了**：把 `cap` 当"每层拆几行"的除数 ⇒ 宽高比 **20.93**
 *    （上界 3.2 的 6.5 倍）。`cap` 的真义是"单条纵向行带最多几个"，只该影响**高度**。
 *
 * ⇒ 最终形态：每层占 1 个 columnPitch（超出 cap 才局部多占一列），行距取该层最高卡片。
 * 另见 `assignCoordinates` 的双轴扫档（层数多时还需压缩**列距**才能贴近目标比例）。
 */
export function placeFlowLayers(
  layers: readonly (readonly string[])[],
  boxOf: (id: string) => NodeBox,
  spec: LayoutSpec,
  cap: number,
): FlowPlacement {
  const spots = new Map<string, { x: number; y: number; seq: number }>();
  let x = 0;
  let height = 0;
  for (const layer of layers) {
    if (layer.length === 0) continue;
    // 每个子列最多 cap 个节点（纵向），超出就横向多占一列 —— 只影响该层局部宽度。
    const subs = Math.max(1, Math.ceil(layer.length / cap));
    // 行距取该层最高卡片：矮卡片不该被大卡片撑出的行距浪费。
    let pitch = spec.rowPitch;
    for (const id of layer) pitch = Math.max(pitch, boxOf(id).h + spec.gap);
    const perSub = Math.ceil(layer.length / subs);
    layer.forEach((id, i) => spots.set(id, {
      x: x + Math.floor(i / perSub) * spec.columnPitch,
      y: (i % perSub) * pitch + pitch / 2,
      seq: i,
    }));
    x += subs * spec.columnPitch;
    height = Math.max(height, perSub * pitch);
  }
  return { spots, width: Math.max(1, x), height: Math.max(1, height) };
}
