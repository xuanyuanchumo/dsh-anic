/**
 * 交互式工作流图（cycle-82 建立 · cycle-83 预览/小地图/面包屑 · cycle-84 追溯/跳转）
 * ——**唯一**持有交互状态的组件。
 *
 * 职责边界：`graphGestures`（视口怎么变）、`graphToolbar`（控件怎么画）、
 * `renderGraph`+`graphNodeCard`/`graphEdgeRender`（画成什么）、`graphStage`（屏幕
 * 交互层怎么摆）、`graphViewportFrame`（视口外框）、`graphInteractiveParts`（props
 * 装配的纯函数）、`graphTraceBar`（追溯状态条）、`useGraphTooltip`（预览揭示）、
 * `useGraphView`（cycle-90 新增交互）、`useLayoutCache`（布局缓存 + 模式）。
 * 本文件只剩「状态 + 一次装配」。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供七个 API；`useMemo`/`useReducer` 会在
 * smoke 里直接 TypeError —— 而 smoke 是唯一在"无宿主"条件下验证组件树能展开的层。
 * **所有 useState 初值必须自足可渲染**（stub 只取初值、不跑 setState/effect），
 * 故初值 = 未缩放、未筛选、全部可见、无预览、无追溯。
 *
 * ## 五份状态为什么是五份（不合并）
 *
 * - `filter`：用户显式选的子集（持续，直到手动清）；
 * - `focusId`：瞬时的悬停/键盘焦点（鼠标一移就走）；
 * - `traceRoot`：用户双击进入的**持续模式**（不能随焦点消失，否则追溯刚开就没了）；
 * - `adjacencyOn`：视觉策略开关（与"选了哪些"无关）；
 * - `layoutMode`（cycle-90）：排布方式（图区局部，见 `useLayoutCache` 头注）。
 * 把这些塞进一个对象，任何一个字段的更新都会让另几个的消费方误重渲，
 * 且"Esc 该清哪些"会变成隐式约定——分开是最小惊讶。
 *
 * ## 预览的两条触发通道都必需
 *
 * `pointerover` 给鼠标用户，`focus` 给键盘用户。只做前者会让"键盘可达"变成空话，
 * 而**任何截图验收都看不出**——键盘用户按 Tab，屏幕上什么都没发生。
 *
 * ## 不删节点（刻意取舍，不是没做）
 *
 * 筛选只改 visibility（→ opacity + pointer-events），节点 DOM 全部保留：
 * ① smoke 与契约钉死「circle 数 == 节点数」；② AT 没有"淡出"概念，从 DOM 移除
 * 等于让屏幕阅读器用户再也遍历不到。详见 `graphFilter.ts` 头注。
 */import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { EMPTY_FILTER, buildFilterView, type FilterState } from './graphFilter.ts';
import { useViewportGestures } from './graphGestures.ts';
import { renderGraph } from './renderGraph.ts';
import { renderGraphToolbar } from './graphToolbar.ts';
import { renderBreadcrumb } from './graphBreadcrumb.ts';
import { renderStage } from './graphStage.ts';
import { renderTraceBar } from './graphTraceBar.ts';
import { frameGesturesOf, renderViewportFrame } from './graphViewportFrame.ts';
import { worldToViewport } from './graphMiniMap.ts';
import { useGraphTooltip } from './useGraphTooltip.ts';
import { useGraphSearch } from './useGraphSearch.ts';
import { EMPTY_TRACE, buildTrace } from './graphTrace.ts';
import { useGraphView } from './useGraphView.ts';
import { useLayoutCache } from './useLayoutCache.ts';
import { assemblyGraphOptionsOf, assemblyNodeClickOf, assemblyToolbarBaseOf, assemblyToolbarOf } from './graphAssembly.ts';

import {
  FALLBACK_SIZE, KEYHINT_ID, VIEWPORT_HEIGHT, keyHintText,
  adjacencyOf, stagePropsOf, toggleIn, traceAdjacencyOf,
} from './graphInteractiveParts.ts';

export interface GraphInteractiveProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  verdicts?: Map<string, string>;
  onNodeClick?: (node: WorkflowNode) => void;
}

export function GraphInteractive(props: GraphInteractiveProps): ReactElement {
  const { nodes, edges, verdicts, onNodeClick } = props;

  // ── 数据态（初值必须自足，见文件头）────────────────────────
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [adjacencyOn, setAdjacencyOn] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 追溯起点（cycle-84，null = 未启用）。双击节点进入，Esc / 「退出追溯」退出。 */
  const [traceRoot, setTraceRoot] = useState<string | null>(null);

  const wrapRef = useRef<{
    getBoundingClientRect?: () => { width: number; height: number };
  } | null>(null);

  // 布局缓存 + 模式（cycle-90）：模式是缓存键的一部分（理由见 useLayoutCache 头注）。
  const { layout, mode: layoutMode, setMode: setLayoutMode } = useLayoutCache(nodes, edges);

  /** 容器像素尺寸（真实 DOM 才有；stub / 未挂载回落到 FALLBACK_SIZE）。 */
  const sizeOf = useCallback((): { width: number; height: number } => {
    const r = wrapRef.current?.getBoundingClientRect?.();
    if (r !== undefined && r.width > 0 && r.height > 0) return { width: r.width, height: r.height };
    return FALLBACK_SIZE;
  }, []);
  const clearFilter = useCallback((): void => {
    setFilter(EMPTY_FILTER);
    setFocusId(null);    // Escape 的语义是"退出所有观察模式"：只清筛选而把追溯留着，用户按了 Esc
    // 却发现图还是花的——那是"键位没反应"的观感。
    setTraceRoot(null);
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

  /** 邻居数表（预览要显示"几条关系"；引用做键）。 */
  const adjRef = useRef<{ key: readonly WorkflowNode[]; map: Map<string, Set<string>> } | null>(null);
  const adjacency = adjacencyOf(nodes, edges, adjRef);

  /** 预览卡状态（cycle-84 抽成 hook，见 useGraphTooltip 头注）。 */
  const { tooltip } = useGraphTooltip({ nodes, verdicts, adjacency, focusId });

  // ── 追溯（cycle-84）：双向邻接表按 edges 引用缓存 + 纯函数 BFS ──────
  const traceAdjRef = useRef<{ key: readonly WorkflowEdge[]; adj: ReturnType<typeof traceAdjacencyOf> } | null>(null);
  const trace = traceRoot === null
    ? EMPTY_TRACE
    : buildTrace(traceAdjacencyOf(edges, traceAdjRef), traceRoot);

  /** 双击节点：进入该节点的追溯；再次双击同一节点则退出（切换语义）。 */
  const onNodeTrace = useCallback((node: WorkflowNode): void => {
    setTraceRoot((cur) => (cur === node.id ? null : node.id));
  }, []);

  // 搜索与跳转（命中/游标/居中）——拆到 useGraphSearch，本文件只接线。
  const { matches: searchMatches, total: searchTotal, activeMatch, moveMatch, jumpTo, jumpActive } = useGraphSearch({
    nodes, layoutNodes: layout.nodes, query: filter.query,
    sizeOf, viewport: gestures.viewport,
    setViewport: gestures.setViewport, setFocusId,
  });

  // ── 筛选动作（chips 多选是 toggle 语义：再点一次取消）───────────
  const toggleType = useCallback((type: string): void => {
    setFilter((f) => ({ ...f, types: toggleIn(f.types, type) }));
  }, []);
  const toggleVerdict = useCallback((verdict: string): void => {
    setFilter((f) => ({ ...f, verdicts: toggleIn(f.verdicts, verdict) }));
  }, []);
  const setQuery = useCallback((query: string): void => { setFilter((f) => ({ ...f, query })); }, []);
  const toggleAdjacency = useCallback((): void => { setAdjacencyOn((v) => !v); }, []);
  const onNodeFocus = useCallback((id: string | null): void => { setFocusId(id); }, []);

  // 邻接高亮关闭时传 null 焦点 ⇒ 高亮集为空 ⇒ 子集内节点全亮（关掉"非邻居降透明"）。
  const filterView = buildFilterView(nodes, edges, filter, adjacencyOn ? focusId : null, verdicts);

  // ── 新增交互（cycle-90）：布局模式 / 仅看异常 / 缩放到选中 / 导出 / 全屏 ──
  // 状态与动作全在 useGraphView（图区局部，不进面板 store —— 理由见其头注）。
  const containerRef = useRef<HTMLElement | null>(null);
  const view = useGraphView({
    edges, layout, adjacency, filter, filterView,
    viewport: gestures.viewport, size: sizeOf(),
    focusId,
    containerRef,
    layoutMode,
    onLayoutMode: setLayoutMode,
    onFilterChange: (next) => { setFilter(next); },
    onViewportChange: (next) => { gestures.setViewport(next); },
  });

  /** 小地图点击 → 局部坐标 → 纯函数换算 → 过钳制的视口。 */
  const onMinimapClick = useCallback((local: { x: number; y: number }): void => {
    gestures.setViewport(worldToViewport(local, layout.bounds, gestures.viewport, sizeOf()));
  }, [gestures, layout.bounds, sizeOf]);

  const size = sizeOf();
  const assembly = {
    nodes, edges, verdicts, layout, filter, filterView, focusId,
    viewport: gestures.viewport, size, trace, adjacencyOn,
    toolbarBase: assemblyToolbarBaseOf({
      nodes, verdicts, filter, adjacencyOn,
      viewport: gestures.viewport,
      onQuery: setQuery, onToggleType: toggleType, onToggleVerdict: toggleVerdict,
      onAdjacencyToggle: toggleAdjacency,
      onZoomIn: gestures.doZoomIn, onZoomOut: gestures.doZoomOut,
      onFit: gestures.doFit, onClear: clearFilter,
      searchMatches, searchTotal, onJump: jumpTo,
      activeMatchIndex: activeMatch, onMoveMatch: moveMatch, onJumpActive: jumpActive,
    }),
    view: {
      layoutMode: view.layoutMode,
      onLayoutMode: view.setLayoutMode,
      anomalyOnly: view.anomalyOnly,
      onAnomalyToggle: view.toggleAnomaly,
      hasSelection: view.hasSelection,
      onFitSelection: view.fitSelection,
      onExportSvg: view.exportSvg,
      onFullscreen: view.toggleFullscreen,
      fullscreen: view.fullscreen,
      note: view.note,
    },
    onNodeClick,
    hasMoved: gestures.hasMoved,
    keyHandler: gestures.onKeyDown, describedBy: KEYHINT_ID, onNodeTrace,
  };
  const toolbar = renderGraphToolbar(assemblyToolbarOf(assembly));

  const graph = renderGraph(
    { nodes, edges },
    verdicts,
    assemblyNodeClickOf(assembly),
    assemblyGraphOptionsOf(assembly),
  );

  return createElement(
    'div',
    {
      'data-anic-graph-interactive': 'true',
      style: { display: 'flex', flexDirection: 'column', gap: 4 },
    },
    toolbar,
    // 追溯状态条：进入追溯后必须能看到"追的是谁 / 上下游各几个 / 是否被截断"。
    // 未启用追溯时整条不渲染（零占位，不改变既有布局）。
    traceRoot === null ? null : renderTraceBar({ trace, onExit: () => { setTraceRoot(null); } }),
    // 面包屑：定位感（小地图回答"在图哪一块"，面包屑回答"在生命周期哪一段"）。
    renderBreadcrumb({ nodes }),
    // 视口外框（容器 + 键盘说明）与舞台（悬停代理 + 图 + 预览 + 小地图）分开成两个文件：
    // 外框负责"手势挂在哪、为什么不可聚焦"，舞台负责"屏幕交互层怎么叠"，本文件只装配。
    renderViewportFrame({
      gestures: frameGesturesOf(gestures),
      wrapRef,
      // 全屏目标 = 视口容器（"这一块独占屏幕"，不是整个面板）。
      fullscreenRef: containerRef,
      keyHintId: KEYHINT_ID, keyHintText: keyHintText(), height: VIEWPORT_HEIGHT,
      stage: renderStage(stagePropsOf({
        graph, tooltip, layout, viewport: gestures.viewport, size, focusId,
        onFocusNode: onNodeFocus,
        onMinimapClick,
        dragging: gestures.dragging,
        onKeyDown: gestures.onKeyDown,
        // 双击空白 → 适配视图（与节点双击追溯互斥，见 graphStage 注释）。
        onBackgroundDoubleClick: gestures.doFit,
      })),
    }),
  );
}
/** 视口原语转出（面板/测试可复用，避免各处自己重算 clamp）。 */
export { clampPan, fitToView, zoomAt } from './graphViewport.ts';
