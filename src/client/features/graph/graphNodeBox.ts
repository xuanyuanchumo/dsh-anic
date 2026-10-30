/**
 * 卡片尺寸表（cycle-83 · V 战线，从 graphLayout.ts 拆出）。
 *
 * 为什么尺寸表要单独成文件：布局算法要问"这个 lane 的卡片多高"（决定 pitch），
 * 渲染层要问"卡片多宽"（决定标签截断预算）。两处消费同一张表，但它与**布局算法**
 * （折列/包围盒）不是同一件事。拆开后 `graphLayout.ts` 只剩算法，改尺寸不会碰算法，
 * 改算法也不会误动尺寸。
 */

/** 卡片尺寸（世界坐标 px）。宽高都进布局：宽度决定列距余量，高度决定 lane pitch。 */
export interface NodeBox { readonly w: number; readonly h: number }

/**
 * 按类型分级的卡片尺寸。
 *
 * 分级不是装饰：phase（宏观阶段）与 gate（收敛门）是图里的**决策单元**，
 * 读者最先找它们，所以更大；gate-event 有 122 个，必须最紧凑；cycle 次之。
 * 所有宽度 ≤ 112 —— 因为 `columnPitch` 是 120（`graphInteractiveContract` ⑤
 * 断言节点 x 坐标是 120 的整数倍），留 8px 列间净空。
 */
export const NODE_BOX: Record<string, NodeBox> = {
  phase: { w: 108, h: 46 },
  'micro-step': { w: 84, h: 34 },
  gate: { w: 112, h: 44 },
  'human-gate': { w: 112, h: 44 },
  cycle: { w: 84, h: 34 },
  'gate-event': { w: 92, h: 34 },
  incident: { w: 100, h: 42 },
  autonomy: { w: 100, h: 40 },
};

/** 未知类型兜底：既不能丢，也不能比事件更占地方（否则未来脏数据会把图撑爆）。 */
export const UNKNOWN_BOX: NodeBox = { w: 88, h: 34 };

/** 类型 → 卡片尺寸（未知类型走兜底；纯函数，渲染与布局共用同一查询）。 */
export function nodeBoxOf(type: string): NodeBox {
  return NODE_BOX[type] ?? UNKNOWN_BOX;
}
