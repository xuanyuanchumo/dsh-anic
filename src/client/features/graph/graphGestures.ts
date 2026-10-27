/**
 * 视口手势 hook（cycle-82 · G 战线）——滚轮缩放 / 拖拽平移 / 键盘缩放。
 *
 * ## 为什么单独成文件而不是留在 GraphInteractive 里
 *
 * 拆分的界线是职责："交互状态怎么变化"（本文件）vs "变化后画成什么"（组件）。
 * 界线一句话能说清，拆开就不会造成"为凑行数而割裂"（250 行模块纪律是本仓
 * `truthAuditChecks` 的机械扫描项，不是建议）。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供 `useState / useRef / useCallback /
 * useEffect / memo / useSyncExternalStore / useDeferredValue`。本文件只用前四个——
 * 用 `useMemo` 或 `useLayoutEffect` 会让整棵组件树在 smoke 里 TypeError，而 smoke 是
 * 唯一在"无宿主"条件下验证组件能展开的层。这不是风格偏好，是**能跑起来**的前提。
 *
 * ## 拖拽阈值为什么是 3px
 *
 * 指针按下后必然有 1–2px 抖动。若把任何移动都算作拖拽，用户在节点上"点一下"
 * 会因为抖动被识别成拖拽，节点详情抽屉就再也打不开——而这是**鼠标用户的
 * 主要操作路径**。3px 是常见阈值（浏览器 click/drag 判定同量级）。
 */
import { useCallback, useRef, useState } from 'react';
import {
  IDENTITY, ZOOM_STEP, centerOf, clampPan, fitToView, panBy, zoomBy, type Viewport,
} from './graphViewport.ts';
import type { GraphLayout } from './graphLayout.ts';

/** 拖拽判定阈值（px）：小于此位移视为点击而非拖拽。 */
const DRAG_THRESHOLD = 3;

interface DragState {
  active: boolean;
  moved: boolean;
  x: number;
  y: number;
}

export interface ViewportGestures {
  viewport: Viewport;
  /** 拖拽中（供 cursor 切换；不参与计算）。 */
  dragging: boolean;
  onWheel: (ev: WheelLike) => void;
  onPointerDown: (ev: PointerLike) => void;
  onPointerMove: (ev: PointerLike) => void;
  onPointerUp: () => void;
  /** 拖拽是否已越过阈值（节点点击用它区分"点"与"拖"）。 */
  hasMoved: () => boolean;
  doFit: () => void;
  doZoomIn: () => void;
  doZoomOut: () => void;
  onKeyDown: (ev: { key: string; preventDefault: () => void }) => void;
}

/** 滚轮事件的最小结构（不引 React 的合成事件类型，便于纯对象单测）。 */
export interface WheelLike {
  clientX: number;
  clientY: number;
  deltaY: number;
  preventDefault: () => void;
  currentTarget?: { getBoundingClientRect?: () => { left: number; top: number } };
}

export interface PointerLike {
  clientX: number;
  clientY: number;
}

export interface GestureOptions {
  /** 视口尺寸查询（真实 DOM 才准确；stub 环境回落到兜底值）。 */
  sizeOf: () => { width: number; height: number };
  /** 清除筛选（Escape 键，由组件提供 —— 筛选状态不在本 hook 里）。 */
  onEscape: () => void;
}

/**
 * @param layout 当前布局（适配/钳制需要包围盒）
 * @param opts 尺寸查询与 Escape 回调
 */
export function useViewportGestures(layout: GraphLayout, opts: GestureOptions): ViewportGestures {
  const { sizeOf, onEscape } = opts;
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState>({ active: false, moved: false, x: 0, y: 0 });

  /** 统一的"改视口"入口：每次改动都过一遍边界钳制（漏一处就会拖丢图）。 */
  const apply = useCallback((next: Viewport): void => {
    setViewport(clampPan(next, sizeOf(), layout.bounds));
  }, [layout, sizeOf]);
  void apply; // 保留作命令式入口（下一步"缩放到某节点"会用）；当前路径走函数式更新
  const doFit = useCallback((): void => {
    setViewport(fitToView(layout.bounds, sizeOf(), 16));
  }, [layout, sizeOf]);

  const doZoomIn = useCallback((): void => {
    setViewport((v) => clampPan(zoomBy(v, centerOf(sizeOf()), ZOOM_STEP), sizeOf(), layout.bounds));
  }, [layout, sizeOf]);

  const doZoomOut = useCallback((): void => {
    setViewport((v) => clampPan(zoomBy(v, centerOf(sizeOf()), 1 / ZOOM_STEP), sizeOf(), layout.bounds));
  }, [layout, sizeOf]);

  const onWheel = useCallback((ev: WheelLike): void => {
    // 必须吃掉默认滚动：否则页面跟着滚，用户"缩放了"同时"页面跳走了"。
    ev.preventDefault();
    // 锚点必须是**容器内**坐标：clientX/Y 是视口坐标，直接当容器坐标会偏一层。
    let originX = 0;
    let originY = 0;
    const r = ev.currentTarget?.getBoundingClientRect?.();
    if (r !== undefined) { originX = r.left; originY = r.top; }
    const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setViewport((v) => clampPan(
      zoomBy(v, { x: ev.clientX - originX, y: ev.clientY - originY }, factor),
      sizeOf(),
      layout.bounds,
    ));
  }, [layout, sizeOf]);

  const onPointerDown = useCallback((ev: PointerLike): void => {
    dragRef.current = { active: true, moved: false, x: ev.clientX, y: ev.clientY };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((ev: PointerLike): void => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    // 阈值内不移动：见文件头"拖拽阈值为什么是 3px"。
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    dragRef.current = { active: true, moved: true, x: ev.clientX, y: ev.clientY };
    // 必须用函数式更新：同一次事件循环里的连续 pointermove 若都读闭包里的
    // `viewport`，第二次起就会用同一个旧基准累加，表现为"拖得越快越跟不上手"。
    setViewport((v) => clampPan(panBy(v, dx, dy), sizeOf(), layout.bounds));
  }, [layout, sizeOf]);

  const onPointerUp = useCallback((): void => {
    dragRef.current = { active: false, moved: false, x: 0, y: 0 };
    setDragging(false);
  }, []);

  const hasMoved = useCallback((): boolean => dragRef.current.moved, []);

  /**
   * 键盘：`+`/`=` 放大、`-`/`_` 缩小、`0` 适配、`Escape` 清筛选。
   *
   * `Home`/`End` **刻意不在此** —— 它们是既有 roving tabindex 的"跳首/末节点"语义，
   * `tests/unit/graphRoving.test.ts` 钉死了。把 Home 改成"适配视图"会静默剥夺
   * 键盘用户"跳到第一个节点"的能力，而那条测试会红——但那属于跨域契约变更。
   */
  const onKeyDown = useCallback((ev: { key: string; preventDefault: () => void }): void => {
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); doZoomIn(); return; }
    if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); doZoomOut(); return; }
    if (ev.key === '0') { ev.preventDefault(); doFit(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); onEscape(); }
  }, [doFit, doZoomIn, doZoomOut, onEscape]);

  return {
    viewport, dragging, onWheel, onPointerDown, onPointerMove, onPointerUp,
    hasMoved, doFit, doZoomIn, doZoomOut, onKeyDown,
  };
}
