/**
 * 视口原语（cycle-82 · G 战线）——缩放 / 平移 / 适配视图，全部纯函数。
 *
 * ## 为什么这些必须抽成纯函数，而不是写在组件的 useState 里
 *
 * 图区交互的三个真实缺陷形态，**在组件里一个都测不出来**：
 *
 * 1. **锚点算错**：滚轮缩放若不按「指针下的图坐标保持不动」算，而是简单乘比例，
 *    用户滚一下，视线里的那个节点就飞出屏幕了 —— 用户只会说"缩放很难用"，
 *    而组件测试能看到的只有 `scale` 变大了（正确）。
 * 2. **边界不钳制**：用户可以一直滚到 `scale=0.0001`，整张图塌成一个点，
 *    再也点不中"放大"按钮（它自己也缩在视口外）；或 `scale=99` 只剩一个圆。
 *    钳制逻辑写成纯函数才能对**每一档边界**断言。
 * 3. **平移无界**：拖拽能把整张图拖出视口，之后**没有任何手势能把它拖回来**
 *    （用户已经不知道该往哪拖）——这是移动端地图类控件最常见的死锁。
 *
 * ## 与 DOM 解耦的约定
 *
 * 本文件只认数字：`Viewport = { scale, tx, ty }` 表示「世界坐标 → 屏幕坐标」的
 * 变换 `screen = world * scale + t`。它不知道 SVG、不知道指针、也不知道滚轮，
 * 因此能在 node 环境的 vitest 里逐条断言（真实宿主没有布局引擎，DOM 断言全是 0）。
 */

/** 缩放上下限。0.25 时 188 点仍能看出 lane 结构；4 时单个点直径 56px 足够点中。 */
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 4;

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 世界坐标下的矩形（`graphLayout` 的 bounds 同形）。 */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** 屏幕坐标点（指针位置）。 */
export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: Viewport = { scale: 1, tx: 0, ty: 0 };

/** 非有限值（NaN / ±Infinity）回落到 1 —— 一个 NaN scale 会让整张 SVG 消失。 */
function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, finite(scale, 1)));
}

/**
 * 以 **屏幕坐标 anchor** 为不动点缩放：缩放前后，anchor 处对应的世界坐标不变。
 *
 * 推导：世界点 w 在屏幕上是 `w * s + t`。要求 `w * s0 + t0 === w * s1 + t1`，
 * 且 `w = (anchor - t0) / s0`，解得 `t1 = anchor - (anchor - t0) * s1 / s0`。
 * 这就是所有地图/看图工具的标准公式——按 `t1 = t0` 或按中心缩放都会让视线漂移。
 */
export function zoomAt(viewport: Viewport, anchor: Point, nextScale: number): Viewport {
  const s0 = clampScale(viewport.scale);
  const s1 = clampScale(nextScale);
  const ax = finite(anchor.x, 0);
  const ay = finite(anchor.y, 0);
  const ratio = s1 / s0;
  return {
    scale: s1,
    tx: ax - (ax - viewport.tx) * ratio,
    ty: ay - (ay - viewport.ty) * ratio,
  };
}

/** 按倍数缩放（滚轮一步 = `ZOOM_STEP`），锚点同上。 */
export const ZOOM_STEP = 1.15;

export function zoomBy(viewport: Viewport, anchor: Point, factor: number): Viewport {
  const s0 = clampScale(viewport.scale);
  return zoomAt(viewport, anchor, s0 * finite(factor, 1));
}

/** 视口中心（按钮缩放以视图中心为锚 —— 用户的注意力在画面中央，不在某个角）。 */
export function centerOf(size: Size): Point {
  return { x: finite(size.width, 0) / 2, y: finite(size.height, 0) / 2 };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return {
    scale: clampScale(viewport.scale),
    tx: viewport.tx + finite(dx, 0),
    ty: viewport.ty + finite(dy, 0),
  };
}

/**
 * 平移边界钳制：世界矩形被缩放后若**比视口小**，就居中（不能拖出空白）；
 * 若比视口大，则允许拖动但保证**至少留 `margin` 像素的图可见**——
 * 完全拖出屏幕后没有任何手势能把图找回来，那是死锁而不只是"不美观"。
 *
 * @param size 视口像素尺寸
 * @param bounds 世界矩形
 * @param margin 边缘保留像素（默认 48：够看到一排点，提示"图在那边"）
 */
export function clampPan(viewport: Viewport, size: Size, bounds: Rect, margin = 48): Viewport {
  const scale = clampScale(viewport.scale);
  const clampAxis = (t: number, viewportPx: number, worldPx: number, min: number): number => {
    // 内容比视口小 → 居中（拖出空白没有意义，且另一侧的空白也拖不回来）。
    if (worldPx <= viewportPx) return (viewportPx - worldPx) / 2 - min * scale;
    // 内容更大 → 限制偏移，使「内容可见区」至少保留 margin 像素：
    //   左缘 = min*scale + t ≤ viewportPx - margin  （不能整块拖到右边外）
    //   右缘 = min*scale + t + worldPx ≥ margin     （不能整块拖到左边外）
    // 两条解出 t 的闭区间 [lo, hi] —— 这就是 clampPan 的全部语义，没有第二套规则。
    const hi = viewportPx - margin - min * scale;
    const lo = margin - min * scale - worldPx;
    return Math.min(hi, Math.max(lo, finite(t, hi)));
  };

  const wPx = Math.max(0, finite(bounds.width, 0)) * scale;
  const hPx = Math.max(0, finite(bounds.height, 0)) * scale;
  return {
    scale,
    tx: clampAxis(viewport.tx, finite(size.width, 0), wPx, finite(bounds.minX, 0)),
    ty: clampAxis(viewport.ty, finite(size.height, 0), hPx, finite(bounds.minY, 0)),
  };
}

/**
 * 适配视图：整张图缩放到刚好放进视口（留 `padding` 像素）。
 *
 * 两个上限都要取：`min` 是因为宽和高谁先顶满谁决定比例；再夹到 SCALE_MAX，
 * 防止「只有 3 个节点时图被放大到 4 倍糊掉」——适配的语义是"看得全"，
 * 不是"填满"，放大到糊反而更差。
 */
export function fitToView(bounds: Rect, size: Size, padding = 16): Viewport {
  const vw = Math.max(1, finite(size.width, 0) - padding * 2);
  const vh = Math.max(1, finite(size.height, 0) - padding * 2);
  const bw = Math.max(1, finite(bounds.width, 1));
  const bh = Math.max(1, finite(bounds.height, 1));
  const scale = Math.min(SCALE_MAX, clampScale(Math.min(vw / bw, vh / bh)));
  // 适配后居中：内容像素尺寸已知，偏移取中点差。
  const tx = (finite(size.width, 0) - bw * scale) / 2 - finite(bounds.minX, 0) * scale;
  const ty = (finite(size.height, 0) - bh * scale) / 2 - finite(bounds.minY, 0) * scale;
  return { scale, tx: finite(tx, 0), ty: finite(ty, 0) };
}

/**
 * 变换串（给 SVG `<g transform>` 用）。
 *
 * 顺序是 `translate` 再 `scale`：SVG 的 transform 从右往左作用，写成
 * `translate(tx,ty) scale(s)` 恰好等价于 `screen = world * s + t`，与本文件
 * 的 Viewport 定义一致。写成 `scale() translate()` 会让平移量也被缩放，
 * 表现为"拖拽速度随缩放比例变化"——手感立刻不对，且很难归因。
 * 保留 4 位小数：SVG 字符串里塞 17 位浮点会让每次重渲的 attribute 都不同，
 * 元素 diff 永远命中不了。
 */
export function transformOf(viewport: Viewport): string {
  const s = clampScale(viewport.scale);
  const n = (v: number): string => String(Math.round(finite(v, 0) * 10000) / 10000);
  return `translate(${n(viewport.tx)},${n(viewport.ty)}) scale(${n(s)})`;
}

/** 世界 → 屏幕（命中测试/调试用；也是上面公式的可执行规格）。 */
export function toScreen(viewport: Viewport, world: Point): Point {
  const s = clampScale(viewport.scale);
  return { x: world.x * s + viewport.tx, y: world.y * s + viewport.ty };
}

/** 屏幕 → 世界（拖拽起点的反解；与 toScreen 互为逆，单测钉往返一致）。 */
export function toWorld(viewport: Viewport, screen: Point): Point {
  const s = clampScale(viewport.scale);
  return { x: (screen.x - viewport.tx) / s, y: (screen.y - viewport.ty) / s };
}

/** 比例读数（`<output>` 文案：`100%`）。四舍五入到整数百分比，避免 99.9999% 这种噪声。 */
export function scalePercent(viewport: Viewport): number {
  return Math.round(clampScale(viewport.scale) * 100);
}

/**
 * 把某个**世界坐标点**移到视口正中的视口（cycle-84 搜索跳转 / 追溯定位用）。
 *
 * 为什么单独一个纯函数而不是让调用方拼 `tx/ty`：跳转有两个易错点，
 * ① 目标点必须在**当前 scale 下**换算（用 1.0 换算会让放大状态下跳到别处）；
 * ② 跳到画布边缘的节点时，居中后的 tx/ty 可能超出可拖范围 —— 调用方必须再过
 * `clampPan`。本函数只负责"数学上居中"，钳制交给既有 `clampPan`（单一职责，
 * 且 `clampPan` 已有逐档边界单测）。
 *
 * 可选 `scale` 用于"跳转时顺手放大"：传 undefined 保持当前比例（默认行为，
 * 用户已调好的比例不该被跳转重置）。
 */
export function centerOnWorld(world: Point, size: Size, viewport: Viewport, scale?: number): Viewport {
  const s = clampScale(scale ?? viewport.scale);
  const cx = finite(size.width, 0) / 2;
  const cy = finite(size.height, 0) / 2;
  return {
    scale: s,
    tx: cx - finite(world.x, 0) * s,
    ty: cy - finite(world.y, 0) * s,
  };
}
