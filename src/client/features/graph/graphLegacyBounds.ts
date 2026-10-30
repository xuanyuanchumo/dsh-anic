/**
 * 旧布局的**包围盒基线**（cycle-90 · 从 `graphLayout.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么它单独成文件
 *
 * `legacyBounds` 回答的是「**改造前的布局**有多高」——它不是布局算法，而是
 * **验收基线**：契约测试拿它当分母（「新布局高度 ≤ 旧布局的 60%」）。
 * 让它与新布局算法同文件有两个害处：
 *   1. 新布局每加一行，基线函数就跟着被挤 —— 而基线**永远不该变**；
 *   2. 读者看到 `legacyBounds` 与 `layoutGraph` 同文件时，会以为它是布局的
 *      一部分（其实它是布局的**对照组**）。
 *
 * 拆开后语义自明：本文件 = 「旧世界」，`graphLayout.ts` = 「新世界」，
 * 契约测试把两者放在一起比。
 *
 * ## 为什么 padding 与改造前 renderGraph 完全同款
 *
 * 基线的意义在于「同口径比较」：padding 差一点，高度的百分比就没法对齐，
 * 「高度降到 60%」这条验收线会随 padding 漂移。故这里刻意复刻改造前的
 * 30px padding 与 +120 宽度补偿，不做任何「优化」。
 *
 * ## 边界
 *
 * 纯函数：零 DOM、零 clock、零 random；不修改入参。
 */
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { GraphBounds } from './graphLayoutTypes.ts';

/** 空图包围盒：给一个最小可见面，避免 viewBox 出现 0 宽高（SVG 会整块不渲染）。 */
export const EMPTY_BOUNDS: GraphBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };

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
