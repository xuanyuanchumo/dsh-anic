/**
 * 缩放到选中节点（cycle-90 · P1-4）——「fit to selection」。
 *
 * ## 为什么这是真实缺口
 *
 * 249 节点的图在 900px 视口里适配后比例约 0.5 ⇒ 10.5px 的主标签只剩 5px，
 * 肉眼根本读不出"这是哪个节点"。用户想看清某一个节点，只能**手拖**去找它，
 * 拖到位了还不一定准（拖过一点就看不清了）。"缩放到选中"把这一步变成一次点击。
 *
 * ## 范围：选中节点 **+ 其 1 跳邻域**
 *
 * 只放大选中节点本身的话，用户会看到一张只有一张卡片的空白画布——他真正想看的
 * 是"这个节点和它的上下文"。所以范围是「节点 + 邻域」，缩放比例按**这批节点
 * 的包围盒**算。
 *
 * ## 复用既有视口原语，不自己算矩阵
 *
 * 本模块**不**自造 transform 计算：缩放走 `graphViewport.zoomBy`（以屏幕锚点为
 * 不动点），居中走 `centerOnWorld`，钳制走 `clampPan`。三者在既有单测里逐档钉死，
 * 自己重算一套等于复制三份几何代码。
 *
 * ## 纯函数
 *
 * `fitToSelection` 是纯函数：吃"节点表 + 邻接表 + 选中 id + 视口尺寸"，吐出新视口。
 * 零 DOM、零 clock、零 random —— 这样"缩放比例对不对"可以逐档断言。
 */
import type { PositionedNode } from './graphLayout.ts';
import {
  clampPan, clampScale, centerOnWorld, zoomBy, type Rect, type Size, type Viewport,
} from './graphViewport.ts';

/** 邻域范围（1 跳）。为什么不是 2 跳：2 跳在这张图上会覆盖上百个节点，等于没放大。 */
export const FIT_SELECTION_HOPS = 1;

/** 目标集合：选中节点 + 其 N 跳邻域（**含自己**——用户要看的就是它）。 */
export function selectionScopeOf(
  selectedId: string | null,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  hops: number = FIT_SELECTION_HOPS,
): Set<string> {
  const out = new Set<string>();
  if (selectedId === null) return out;
  out.add(selectedId);
  let frontier = [selectedId];
  for (let h = 0; h < hops; h += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adjacency.get(id) ?? []) {
        if (out.has(nb)) continue;
        out.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return out;
}

/** 一批节点的世界包围盒（含卡片半高/半宽）。 */
export function scopeBoundsOf(nodes: readonly PositionedNode[], ids: ReadonlySet<string>): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const n of nodes) {
    if (!ids.has(n.id)) continue;
    found = true;
    if (n.x < minX) minX = n.x;
    if (n.y - n.h / 2 < minY) minY = n.y - n.h / 2;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h / 2 > maxY) maxY = n.y + n.h / 2;
  }
  if (!found) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 缩放到选中（含邻域）后的视口（纯函数）。
 *
 * @param scope 目标 id 集合（`selectionScopeOf` 的产物）
 * @param padding 视口留白（px）
 * @returns null = 范围内没有节点（不该发生，但空图必须**如实**返回 null 而不是造一个假视口）
 */
export function fitToSelection(
  nodes: readonly PositionedNode[],
  scope: ReadonlySet<string>,
  size: Size,
  viewport: Viewport,
  padding = 24,
): Viewport | null {
  const rect = scopeBoundsOf(nodes, scope);
  if (rect === null) return null;
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const vw = Math.max(1, size.width - padding * 2);
  const vh = Math.max(1, size.height - padding * 2);
  // 比例：宽高谁先顶满谁决定（与 `fitToView` 同一口径）。再夹到 [SCALE_MIN, SCALE_MAX]。
  const raw = Math.min(vw / w, vh / h);
  const next = clampScale(raw);
  // 先把范围中心移到视口中心（`centerOnWorld`），再按比例缩放（`zoomBy` 以视口中心
  // 为锚 —— 用户的注意力在画面中央，不在某个角）。
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  const centered = centerOnWorld({ x: cx, y: cy }, size, viewport, next);
  return clampPan(zoomBy(centered, { x: size.width / 2, y: size.height / 2 }, next / centered.scale), size, rect);
}
