/**
 * 视口外框（cycle-83 · V 战线）——视口容器 + 键盘说明的纯展示装配。
 *
 * ## 为什么这层要单独成文件
 *
 * `GraphInteractive` 在 cycle-83 后要同时装：工具栏接线、面包屑、视口容器、
 * 键盘说明、舞台（悬停代理 + 预览卡 + 小地图）。拆分的界线是**状态 vs 外框**：
 * 本文件只回答"视口容器长什么样、挂了哪些手势处理器"（纯展示，无 hooks），
 * `GraphInteractive` 继续持有全部交互状态。
 *
 * ## 三条不能忘的约束（都在这里落地，因为它们都属于"外框"）
 *
 * 1. **外框不可聚焦**：图区唯一的 Tab 停靠点是内部 svg（既有 graphA11y /
 *    graphRoving 契约）。给外框 tabIndex 会让图区变成两个停靠点，键盘用户要按
 *    两次 Tab 才能穿过 —— 正是 P1-2 花力气消灭的反模式。
 * 2. **`overflow: hidden` 是"视口"的定义**：放大后超出部分必须在这里被裁掉，
 *    而不是被 svg 自身宽高意外裁掉（后者会让"放大"看起来像"只能看中间一块"）。
 * 3. **`touch-action: none`**：触摸拖拽必须交给图区，否则浏览器先把它解释成
 *    页面滚动——移动端用户会以为"图根本拖不动"。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import type { ViewportGestures } from './graphGestures.ts';

/**
 * 手势处理器集合（由 `useViewportGestures` 提供，本层只接线）。
 *
 * 事件参数放宽成 `unknown`/最小结构：React 的合成事件类型与 hook 里的
 * `WheelLike`/`PointerLike` 形状不同，而外层容器只需要"把事件转给 hook"。
 */
export interface FrameGestures {
  dragging: boolean;
  onWheel: (ev: unknown) => void;
  onPointerDown: (ev: unknown) => void;
  onPointerMove: (ev: unknown) => void;
  onPointerUp: () => void;
  doFit: () => void;
}

/**
 * 手势 → 外框处理器。
 *
 * 为什么要一层转换而不是直接传 `ViewportGestures`：hook 的事件参数是
 * `WheelLike`/`PointerLike`（最小结构，便于纯对象单测），而 React 传进来的是
 * 合成事件。这里做一次显式判空转换，让"不匹配"在**类型层**暴露，而不是在
 * 运行时某个字段恰好同名才不炸。
 */
export function frameGesturesOf(g: ViewportGestures): FrameGestures {
  return {
    dragging: g.dragging,
    onWheel: (ev) => { g.onWheel(ev as Parameters<ViewportGestures['onWheel']>[0]); },
    onPointerDown: (ev) => { g.onPointerDown(ev as Parameters<ViewportGestures['onPointerDown']>[0]); },
    onPointerMove: (ev) => { g.onPointerMove(ev as Parameters<ViewportGestures['onPointerMove']>[0]); },
    onPointerUp: g.onPointerUp,
    doFit: g.doFit,
  };
}

export interface FrameInput {
  gestures: FrameGestures;
  /** 容器 ref（像素尺寸查询挂在这）。 */
  wrapRef: { current: unknown };
  /** 键盘操作说明（`<p>` 的 id 与文案）。 */
  keyHintId: string;
  keyHintText: string;
  /** 视口高度（px）。 */
  height: number;
  /** 舞台内容（悬停代理 + 图 + 预览卡 + 小地图）。 */
  stage: ReactElement;
}

export function renderViewportFrame(input: FrameInput): ReactElement {
  const { gestures, wrapRef, keyHintId, keyHintText, height, stage } = input;
  return createElement(
    'div',
    {
      // 视口容器：固定可视高度 + overflow hidden，图在内部靠 transform 缩放平移。
      // 不能给 height:100%（父级高度 auto，百分比无参照）；px 让它有确定可视区。
      'data-anic-graph-viewport': 'true',
      'data-anic-graph-dragging': gestures.dragging ? 'true' : 'false',
      ref: wrapRef as unknown as (el: unknown) => void,
      onWheel: gestures.onWheel as (ev: unknown) => void,
      onPointerDown: gestures.onPointerDown as (ev: unknown) => void,
      onPointerMove: gestures.onPointerMove as (ev: unknown) => void,
      onPointerUp: gestures.onPointerUp,
      onPointerLeave: gestures.onPointerUp,
      onDoubleClick: gestures.doFit,
      // 拖拽时不能选中文字（否则拖一次图整片高亮，看起来像 bug）。
      onDragStart: (ev: { preventDefault: () => void }) => { ev.preventDefault(); },
      style: {
        position: 'relative',
        height,
        overflow: 'hidden',
        // 描边走令牌（不许出现颜色字面量，clientRenderContract 会扫）。
        border: `1px solid ${token('anic-border')}`,
        borderRadius: 6,
        cursor: gestures.dragging ? 'grabbing' : 'grab',
        // touchAction none：触摸拖拽必须交给本组件，否则浏览器先解释成页面滚动。
        touchAction: 'none',
      },
    },
    // 键盘操作说明（视觉隐藏，AT 可读；svg 用 aria-describedby 关联它）。
    createElement('p', {
      id: keyHintId,
      key: 'keys',
      className: 'anic-sr-only',
      'data-anic-graph-keyhint': 'true',
    }, keyHintText),
    stage,
  );
}
