/**
 * 交互式工作流图（cycle-82 · G 战线）——**唯一**持有交互状态的组件。
 *
 * 职责边界：`graphGestures`（视口怎么变）、`graphToolbar`（控件怎么画）、
 * `renderGraph`+`graphNodeRender`（画成什么）；本文件把它们串起来，只剩
 * 「筛选状态 + 焦点状态 + 一次装配」。
 *
 * ## 只用 useState / useRef / useCallback / useEffect
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供 `useState / useRef / useCallback /
 * useEffect / memo / useSyncExternalStore / useDeferredValue`。用 `useMemo` 或
 * `useReducer` 会在 smoke 里直接 TypeError——而 smoke 是唯一在"无宿主"条件下
 * 验证整棵组件树能展开的层。这不是风格偏好，是**能跑起来**的前提。
 *
 * 且**所有 useState 初值必须自足可渲染**（stub 只取初值、不跑 setState/effect），
 * 故初值 = 「未缩放、未筛选、全部可见」。
 *
 * ## 布局用 useRef 缓存
 *
 * 188 节点布局约 0.1ms，本身不贵；但**引用不稳定**会让下游 `renderGraph` 的元素树
 * 每次全部重建，在 2s/4s 轮询的数据 tick 下就是持续抖动。
 *
 * ## 不删节点（刻意取舍，不是没做）
 *
 * 筛选只改 visibility（→ opacity + pointer-events），节点 DOM 全部保留：
 * ① smoke 与契约测试钉死「circle 数 == 节点数」；② AT 没有"淡出"概念，从 DOM
 * 移除等于让屏幕阅读器用户再也遍历不到。详见 `graphFilter.ts` 头注。
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { LANE_ORDER, layoutGraph, type GraphLayout } from './graphLayout.ts';
import {
  EMPTY_FILTER, buildFilterView, countTypes, countVerdicts, type FilterState,
} from './graphFilter.ts';
import { useViewportGestures } from './graphGestures.ts';
import { renderGraph } from './renderGraph.ts';
import { renderGraphToolbar } from './graphToolbar.ts';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

export interface GraphInteractiveProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  verdicts?: Map<string, string>;
  onNodeClick?: (node: WorkflowNode) => void;
}

/** 视口兜底尺寸：容器尚未测量时用它算中心/适配（stub 环境也是这一档）。 */
const FALLBACK_SIZE = { width: 900, height: 560 };

/** 视口高度（px）。420 是「一屏内同时看到工具栏 + 图 + 下一分区标题」的位置。 */
const VIEWPORT_HEIGHT = 420;

/** 键盘操作说明元素的 id（svg 的 aria-describedby 指向它）。 */
const KEYHINT_ID = 'anic-graph-keys';

export function GraphInteractive(props: GraphInteractiveProps): ReactElement {
  const { nodes, edges, verdicts, onNodeClick } = props;

  // ── 数据态（初值必须自足，见文件头）────────────────────────
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [adjacencyOn, setAdjacencyOn] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);

  const wrapRef = useRef<{
    getBoundingClientRect?: () => { width: number; height: number };
  } | null>(null);

  // 布局缓存：以「节点数组引用 + 边数组引用」为键。数据 tick 未变时复用同一对象，
  // 让 renderGraph 的元素树可被 React 复用（见文件头）。
  const layoutRef = useRef<{
    nodes: readonly WorkflowNode[];
    edges: readonly WorkflowEdge[];
    layout: GraphLayout;
  } | null>(null);
  if (
    layoutRef.current === null
    || layoutRef.current.nodes !== nodes
    || layoutRef.current.edges !== edges
  ) {
    layoutRef.current = { nodes, edges, layout: layoutGraph(nodes, edges) };
  }
  const layout = layoutRef.current.layout;

  /** 容器像素尺寸（真实 DOM 才有；stub / 未挂载回落到 FALLBACK_SIZE）。 */
  const sizeOf = useCallback((): { width: number; height: number } => {
    const r = wrapRef.current?.getBoundingClientRect?.();
    if (r !== undefined && r.width > 0 && r.height > 0) return { width: r.width, height: r.height };
    return FALLBACK_SIZE;
  }, []);

  const clearFilter = useCallback((): void => {
    setFilter(EMPTY_FILTER);
    setFocusId(null);
  }, []);

  const gestures = useViewportGestures(layout, { sizeOf, onEscape: clearFilter });

  /**
   * 首屏适配一次。
   *
   * 为什么需要 effect 而不是把 useState 初值直接设成 fit：`fitToView` 需要**容器的
   * 真实像素尺寸**，首渲时 DOM 还没测量。stub 环境不跑 effect ⇒ 保持恒等视口，
   * 那正好是"未缩放"的合理默认（见文件头"初值必须自足"）。
   *
   * 用 ref 守卫「只跑一次」：数据 tick 换 nodes 引用时不该把用户调好的缩放/平移
   * 重置回适配态——那会让 2s 轮询下的用户没法稳定看图。
   */
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    gestures.doFit();
  }, [gestures]);

  // ── 筛选动作（chips / 裁决 / 搜索 / 邻接开关）───────────────
  const toggleType = useCallback((type: string): void => {
    setFilter((f) => ({
      ...f,
      types: f.types.includes(type) ? f.types.filter((x) => x !== type) : [...f.types, type],
    }));
  }, []);

  const toggleVerdict = useCallback((verdict: string): void => {
    setFilter((f) => ({
      ...f,
      verdicts: f.verdicts.includes(verdict) ? f.verdicts.filter((x) => x !== verdict) : [...f.verdicts, verdict],
    }));
  }, []);

  const setQuery = useCallback((query: string): void => { setFilter((f) => ({ ...f, query })); }, []);
  const toggleAdjacency = useCallback((): void => { setAdjacencyOn((v) => !v); }, []);
  const onNodeFocus = useCallback((id: string | null): void => { setFocusId(id); }, []);

  // 邻接高亮关闭时传 null 焦点 ⇒ 高亮集为空 ⇒ 子集内节点全亮（关掉"非邻居降透明"）。
  const filterView = buildFilterView(nodes, edges, filter, adjacencyOn ? focusId : null, verdicts);

  const toolbar = renderGraphToolbar({
    filter,
    typeCounts: countTypes(nodes, LANE_ORDER),
    verdictCounts: countVerdicts(nodes, verdicts),
    viewport: gestures.viewport,
    adjacencyOn,
    onQuery: setQuery,
    onToggleType: toggleType,
    onToggleVerdict: toggleVerdict,
    onAdjacencyToggle: toggleAdjacency,
    onZoomIn: gestures.doZoomIn,
    onZoomOut: gestures.doZoomOut,
    onFit: gestures.doFit,
    onClear: clearFilter,
  });

  const graph = renderGraph(
    { nodes, edges },
    verdicts,
    onNodeClick === undefined
      ? undefined
      // 拖拽越界时不触发点击：否则用户"拖了一下图"就跳进了节点详情抽屉。
      : (n) => { if (!gestures.hasMoved()) onNodeClick(n); },
    {
      viewport: gestures.viewport,
      filterView,
      focusId,
      layout,
      // size 传可视区：交互态画布必须等于视口，否则放大后的内容会被 svg 自身
      // 宽高裁掉（见 GraphRenderOptions.size 的注释）。
      size: sizeOf(),
      // 缩放键合并进 svg 的 onKeyDown —— svg 仍是**唯一** Tab 停靠点
      // （既有 graphA11y/graphRoving 契约），见 renderGraph 里 keyHandler 的注释。
      keyHandler: gestures.onKeyDown,
      describedBy: KEYHINT_ID,
    },
  );

  return createElement(
    'div',
    {
      'data-anic-graph-interactive': 'true',
      style: { display: 'flex', flexDirection: 'column', gap: 4 },
    },
    toolbar,
    createElement(
      'div',
      {
        // 视口容器：固定可视高度 + overflow hidden，图在内部靠 transform 缩放平移。
        // 不能给 height:100%（父级高度 auto，百分比无参照）；px 让它有确定可视区。
        //
        // **本容器不可聚焦**：图区唯一的 Tab 停靠点是内部 svg（既有 graphA11y /
        // graphRoving 契约）。给它 tabIndex 会让图区变成两个停靠点，键盘用户要按
        // 两次 Tab 才能穿过——正是 P1-2 花力气消灭的反模式。滚轮/拖拽/双击是鼠标
        // 手势，挂在容器上无所谓（不产生焦点）；键盘 +/−/0 走 svg 的 keyHandler。
        'data-anic-graph-viewport': 'true',
        'data-anic-graph-dragging': gestures.dragging ? 'true' : 'false',
        ref: wrapRef,
        onWheel: gestures.onWheel,
        onPointerDown: gestures.onPointerDown,
        onPointerMove: gestures.onPointerMove,
        onPointerUp: gestures.onPointerUp,
        onPointerLeave: gestures.onPointerUp,
        onDoubleClick: gestures.doFit,
        // 拖拽时不能选中文字（否则拖一次图整片高亮，看起来像 bug）。
        onDragStart: (ev: { preventDefault: () => void }) => { ev.preventDefault(); },
        style: {
          position: 'relative',
          height: VIEWPORT_HEIGHT,
          overflow: 'hidden',
          // 描边走令牌（不许出现颜色字面量，clientRenderContract 会扫）。
          border: `1px solid ${token('anic-border')}`,
          cursor: gestures.dragging ? 'grabbing' : 'grab',
          // touchAction none：触摸拖拽必须交给本组件，否则浏览器先解释成页面滚动。
          touchAction: 'none',
        },
      },
      // 键盘操作说明（视觉隐藏，AT 可读；svg 用 aria-describedby 关联它）。
      createElement('p', {
        id: KEYHINT_ID,
        key: 'keys',
        className: 'anic-sr-only',
        'data-anic-graph-keyhint': 'true',
      }, t('graph.keyHint')),
      // 悬停/聚焦焦点：用**一个**外层代理而非给 188 个节点各挂一对处理器
      // （188×2 个闭包每次重渲都要重建，而外层只有一对；事件冒泡天然覆盖全部节点）。
      createElement(
        'div',
        {
          key: 'hover-proxy',
          'data-anic-graph-hover-proxy': 'true',
          onPointerOver: (ev: { target?: { getAttribute?: (n: string) => string | null } }) => {
            const id = ev.target?.getAttribute?.('data-anic-node') ?? null;
            onNodeFocus(id === null || id === '' ? null : id);
          },
          onPointerOut: () => { onNodeFocus(null); },
          onFocusCapture: (ev: { target?: { getAttribute?: (n: string) => string | null } }) => {
            const id = ev.target?.getAttribute?.('data-anic-node') ?? null;
            onNodeFocus(id === null || id === '' ? null : id);
          },
          onBlurCapture: () => { onNodeFocus(null); },
          style: { width: '100%', height: '100%' },
        },
        graph,
      ),
    ),
  );
}

/** 视口原语转出（面板/测试可复用，避免各处自己重算 clamp）。 */
export { clampPan, fitToView, zoomAt } from './graphViewport.ts';
