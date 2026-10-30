/**
 * 小地图（cycle-83 · V 战线）——"当前视口在整张图的哪个位置"的定位感。
 *
 * ## 为什么**不用**一个独立的 `<svg>`
 *
 * `scripts/offline-smoke.mjs` 断言 `countType(tree,'svg').n === 1`，"单 svg"
 * 是图区的真不变量（缩放/平移只改**一个** `<g transform>`，那是
 * `graphInteractiveContract` ⑤ 钉死的形式）。给小地图套一个嵌套 `<svg>`
 * 会立刻把它变成 2 个。所以小地图用**同一张 svg 里的** `<g>` + `<rect>` 实现：
 * 世界包围盒缩略成一组缩略点，视口矩形用一个高亮 `<rect>` 表达。
 *
 * ## 为什么缩略点用 `<rect>` 而不是 `<circle>`
 *
 * 188 个缩略点若都用 `<circle>`，circle 总数会变成 376 —— 而 smoke 与
 * `graphInteractiveContract` 都钉死「circle 数 == 节点数」。用 rect 既守住这条
 * 不变量，也更像"缩略图里的卡片"。
 *
 * ## 为什么点击跳转拆成纯函数 `worldToViewport`
 *
 * 「点小地图某处 → 视口中心移过去」有两个容易错的地方：① 缩略比例与 SVG 世界
 * 坐标不是一回事（点击点要先反算回世界坐标）；② 边界钳制必须在换算**之后**做，
 * 否则点边缘会得到"图被拖丢"的结果。纯函数化后两个分支都能在 node 环境逐档断言，
 * 组件只负责把事件坐标递进来。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { gt } from './graphText.ts';
import type { PositionedNode } from './graphLayout.ts';
import { clampPan, type Rect, type Size, type Viewport } from './graphViewport.ts';

/** 小地图尺寸（屏幕像素）。120×80 是"看得清形状但不抢图区"的最小面。 */
export const MINIMAP_W = 120;
export const MINIMAP_H = 80;
/** 右下角内边距。 */
export const MINIMAP_INSET = 8;

/**
 * 小地图 `<g>` 的左上角（屏幕坐标，右下角对齐）。
 *
 * 为什么单独成函数：渲染层（`renderMiniMap` 的 translate）与**事件层**
 * （`graphStage` 把指针坐标减掉它才是局部坐标）必须用同一式；两处各算一遍，
 * 一旦一边改了内边距，点击就会偏一层——而偏移在 jsdom 里恒 0，测试看不出来。
 */
export function minimapOrigin(size: Size): { x: number; y: number } {
  return {
    x: Math.max(0, size.width - MINIMAP_W - MINIMAP_INSET),
    y: Math.max(0, size.height - MINIMAP_H - MINIMAP_INSET),
  };
}

export interface MiniMapTransform { k: number; dx: number; dy: number }

/** 小地图内部的世界 → 缩略坐标的缩放比与居中偏移（等比，非等比会把图拉歪）。 */
export function minimapTransform(
  bounds: Rect,
  size: Size = { width: MINIMAP_W, height: MINIMAP_H },
): MiniMapTransform {
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const k = Math.min(size.width / bw, size.height / bh);
  return {
    k,
    // 居中：整张图在小地图里居中，边缘留白对称，点击换算才是线性的。
    dx: (size.width - bw * k) / 2 - bounds.minX * k,
    dy: (size.height - bh * k) / 2 - bounds.minY * k,
  };
}

/** 世界坐标 → 小地图**局部**坐标（相对 `<g data-anic-graph-minimap>` 原点）。 */
export function worldToMinimap(
  point: { x: number; y: number },
  bounds: Rect,
): { x: number; y: number } {
  const tr = minimapTransform(bounds);
  return { x: point.x * tr.k + tr.dx, y: point.y * tr.k + tr.dy };
}

/** 视口矩形在小地图上的几何。 */
export interface ViewportBox { x: number; y: number; w: number; h: number }

/**
 * 当前视口在小地图上的矩形（纯函数）。
 *
 * 先在世界坐标里求可视区（`-t / scale` 起，长 `size / scale`），再映射到小地图。
 * 不做"按比例直接乘"的近似——那会在缩放后与视口偏移不一致，画出来的框和实际
 * 能看到的区域对不上（这正是"小地图骗人"最常见的原因）。
 */
export function viewportBoxInMinimap(viewport: Viewport, size: Size, bounds: Rect): ViewportBox {
  const s = viewport.scale > 0 ? viewport.scale : 1;
  const minX = -viewport.tx / s;
  const minY = -viewport.ty / s;
  const a = worldToMinimap({ x: minX, y: minY }, bounds);
  const b = worldToMinimap({ x: minX + size.width / s, y: minY + size.height / s }, bounds);
  return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
}

/**
 * 点击小地图 → 新视口（**纯函数**，可单测）。
 *
 * 换算分三步，每步都可断言：
 * 1. 局部坐标反算世界坐标（`(local - d) / k`）；
 * 2. 让该世界点落在视口**中心**（`t = 视口中心 - 世界点 * scale`）；
 * 3. `clampPan` 钳制（内容比视口小时居中、大时至少留 margin 可见）。
 */
export function worldToViewport(
  local: { x: number; y: number },
  bounds: Rect,
  viewport: Viewport,
  size: Size,
): Viewport {
  const tr = minimapTransform(bounds);
  const k = tr.k > 0 ? tr.k : 1;
  const worldX = (local.x - tr.dx) / k;
  const worldY = (local.y - tr.dy) / k;
  const next: Viewport = {
    scale: viewport.scale,
    tx: size.width / 2 - worldX * viewport.scale,
    ty: size.height / 2 - worldY * viewport.scale,
  };
  return clampPan(next, size, bounds);
}

/** 小地图渲染入参。 */
export interface MiniMapInput {
  nodes: readonly PositionedNode[];
  bounds: Rect;
  viewport: Viewport;
  size: Size;
  /** 当前焦点节点（"我在看哪个"在大图上难找，在小图上更该有）。 */
  focusId: string | null;
}

/**
 * 渲染小地图（纯展示 + 一个点击入口）。
 *
 * 为什么挂在**屏幕坐标**下（不在 `<g data-anic-graph-world>` 里）：它是"地图 UI"，
 * 必须固定在图区右下角、不随缩放平移移动 —— 那正是地图控件的定义。所以它是
 * 世界 `<g>` 的**兄弟**节点，直接挂在根 svg 上。
 */
export function renderMiniMap(input: MiniMapInput): ReactElement {
  const { nodes, bounds, viewport, size, focusId } = input;
  const origin = minimapOrigin(size);
  const { x, y } = origin;
  const box = viewportBoxInMinimap(viewport, size, bounds);
  const tr = minimapTransform(bounds);

  return createElement(
    'g',
    {
      key: 'minimap',
      // 锚点：存在性与点击行为都靠它断言。
      'data-anic-graph-minimap': 'true',
      role: 'img',
      'aria-label': gt('minimapLabel', { nodes: nodes.length }),
      transform: `translate(${String(x)},${String(y)})`,
    },
    // 底板：视觉边界 + 命中区（内部 rect 同样可点）。
    createElement('rect', {
      key: 'minimap-bg',
      'data-anic-graph-minimap-bg': 'true',
      x: 0, y: 0, width: MINIMAP_W, height: MINIMAP_H,
      rx: 4, ry: 4,
      fill: token('anic-surface'),
      stroke: token('anic-border-strong'),
      strokeWidth: 0.8, opacity: 0.92,
    }),
    // 缩略点：每节点一个 rect（**不用 circle**，见文件头）。
    ...nodes.map((n) => createElement('rect', {
      key: `mm-${n.id}`,
      'data-anic-graph-minimap-node': n.id,
      x: n.x * tr.k + tr.dx,
      y: n.y * tr.k + tr.dy,
      width: Math.max(1.2, n.w * tr.k),
      height: Math.max(1.2, n.h * tr.k),
      rx: 0.6, ry: 0.6,
      fill: n.id === focusId ? token('anic-focus-ring') : token('anic-text-faint'),
      opacity: n.id === focusId ? 1 : 0.5,
    })),
    // 视口矩形：小地图的**唯一**动态元素，"我在看哪一块"就靠它。
    createElement('rect', {
      key: 'minimap-viewport',
      'data-anic-graph-minimap-viewport': 'true',
      x: box.x, y: box.y, width: box.w, height: box.h,
      fill: 'none', stroke: token('anic-focus-ring'), strokeWidth: 1.2,
    }),
  );
}

/**
 * 小地图点击事件坐标 → 局部坐标（纯函数）。
 *
 * 用 `getBoundingClientRect` 的**相对偏移**而不是绝对坐标：宿主会把面板放在任意
 * 滚动容器里，绝对坐标点击会偏一层。stub/jsdom 下该矩形为 0，此时退回"把
 * clientX/Y 当作局部坐标"——这也让测试可以不带布局引擎地断言跳转换算。
 */
export function minimapLocalPoint(
  event: { clientX: number; clientY: number },
  rect: { left?: number; top?: number } | null | undefined,
): { x: number; y: number } {
  const left = typeof rect?.left === 'number' && Number.isFinite(rect.left) ? rect.left : 0;
  const top = typeof rect?.top === 'number' && Number.isFinite(rect.top) ? rect.top : 0;
  return { x: event.clientX - left, y: event.clientY - top };
}
