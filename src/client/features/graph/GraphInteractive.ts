/**
 * 交互式工作流图（cycle-82 建立 · cycle-83 预览/小地图/面包屑 · cycle-84 追溯/跳转
 * · cycle-90 视图组 · cycle-95 分键视图态 + 路径模式 + 影响半径）
 * ——**唯一**持有交互状态的组件。
 *
 * ## 文件头注的其余部分已迁出（cycle-95，守 250 行）
 *
 * 本文件此前 248 行、已贴 T3 硬限（`objectiveConformanceContract ⑪`）。cycle-95
 * 要接线三件新能力，若靠删注释腾空间，等于把判据扔掉 —— 所以把长段设计裁决
 * **迁到它们真正回答的地方**：
 *
 * - 「五份状态为什么不合并」→ `useGraphView` 头注（状态归属）；
 * - 「stub 只认七个 hook / 初值必须自足」→ `graphGestures` 与 `useLayoutCache` 头注；
 * - 「预览的鼠标 + 键盘双通道」→ `graphStage` 头注；
 * - 「筛选不删节点」→ `graphFilter` 头注；
 * - 「工作区标识从哪来」→ `GraphSection`（可选 prop 通道的说明在 `useGraphViewState`）。
 *
 * 本文件只剩「状态 + 一次装配」，所有判据各归其位，没有一条被删。
 */import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { EMPTY_FILTER, type FilterState } from './graphFilter.ts';
import { useViewportGestures } from './graphGestures.ts';
import { renderGraph } from './renderGraph.ts';
import { renderGraphToolbar } from './graphToolbar.ts';
import { renderBreadcrumb } from './graphBreadcrumb.ts';
import { renderStage } from './graphStage.ts';
import { renderTraceBar } from './graphTraceBar.ts';
import { frameGesturesOf, renderViewportFrame } from './graphViewportFrame.ts';
import { useFitLifecycle } from './useContainerRefit.ts';
import { worldToViewport } from './graphMiniMap.ts';
import { useGraphTooltip } from './useGraphTooltip.ts';
import { useGraphSearch } from './useGraphSearch.ts';
import { EMPTY_TRACE, buildTrace } from './graphTrace.ts';
import { useLayoutCache } from './useLayoutCache.ts';
import { useGraphInteraction } from './useGraphInteraction.ts';
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
  /** 当前工作区（cycle-95）：分键视图态的分键依据；缺省 ⇒ 视图态不记忆。 */
  workspace?: string;
}

export function GraphInteractive(props: GraphInteractiveProps): ReactElement {
  const { nodes, edges, verdicts, onNodeClick, workspace } = props;

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
  // cycle-99/100：时间轴回放同属观察模式——Esc 一并退出（含角色筛选归零）。
  const interactionRef = useRef<ReturnType<typeof useGraphInteraction> | null>(null);
  const clearFilter = useCallback((): void => {
    // Escape 语义是"退出所有观察模式"：清筛选但保留 roles 键的存在性（undefined 形态不变）。
    setFilter((f) => ({ types: [], verdicts: [], query: '', roles: f.roles === undefined ? undefined : [] }));
    setFocusId(null);
    setTraceRoot(null);
    interactionRef.current?.timeline.exit();
    // cycle-108：Esc 必须能退出**路径模式**（此前只退时间轴与筛选，路径模式
    // 只能点条上的 ✕ 退出——键盘用户没有等价通道，且 Esc 语义是"退出所有观察模式"）。
    interactionRef.current?.path.exit();
  }, []);

  const gestures = useViewportGestures(layout, { sizeOf, onEscape: clearFilter });

  // 适配生命周期（cycle-104 迁至 useFitLifecycle）：首屏适配一次 + 容器尺寸变化
  // 重适配。两条纪律的正确性理由见 useContainerRefit.ts 头注（本文件已贴 T3 250 行限）。
  useFitLifecycle({ target: wrapRef, doFit: gestures.doFit });

  /** 邻居数表（预览要显示"几条关系"；引用做键）。 */
  const adjRef = useRef<{ key: readonly WorkflowNode[]; map: Map<string, Set<string>> } | null>(null);
  const adjacency = adjacencyOf(nodes, edges, adjRef);

  /** 预览卡状态（cycle-84 抽成 hook，见 useGraphTooltip 头注）。 */
  const { tooltip } = useGraphTooltip({ nodes, verdicts, adjacency, focusId });

  // ── 追溯（cycle-84）：双向邻接表按 edges 引用缓存 + 纯函数 BFS ──────
  const traceAdjRef = useRef<{ key: readonly WorkflowEdge[]; adj: ReturnType<typeof traceAdjacencyOf> } | null>(null);
  const traceAdjacency = traceAdjacencyOf(edges, traceAdjRef);
  const trace = traceRoot === null ? EMPTY_TRACE : buildTrace(traceAdjacency, traceRoot);

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
  const containerRef = useRef<HTMLElement | null>(null);
  /**
   * cycle-95 交互组合层：分键视图态（O-94-03）/ 路径模式 / 影响半径 / 角色计数。
   * 四件事各自的"为什么"写在 `useGraphInteraction` 与三个被它调用的文件头注里。
   * 本文件只提供状态与回调 —— 这是它能留在 250 行以内的唯一原因。
   */
  const interaction = useGraphInteraction({
    nodes, edges, verdicts, layout, filter, focusId,
    viewport: gestures.viewport, size: sizeOf(),
    containerRef,
    layoutMode, onLayoutMode: setLayoutMode,
    onFilterChange: setFilter,
    onViewportChange: gestures.setViewport,
    onNodeClick,
    hasMoved: gestures.hasMoved,
    adjacencyOn,
    workspace,
  });
  const view = interaction.view;
  // 回调时序桥：clearFilter（上方闭包）经此读到最新 interaction（见其注释）。
  interactionRef.current = interaction;

  /** 小地图点击 → 局部坐标 → 纯函数换算 → 过钳制的视口。 */
  const onMinimapClick = useCallback((local: { x: number; y: number }): void => {
    gestures.setViewport(worldToViewport(local, layout.bounds, gestures.viewport, sizeOf()));
  }, [gestures, layout.bounds, sizeOf]);

  const size = sizeOf();
  const assembly = {
    nodes, edges, verdicts, layout, filter, filterView: interaction.filterView, focusId,
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
    // cycle-95：路径模式开关 + 角色图例读数（两者都走「缺省不渲染」的同一形状）。
    // cycle-100：角色图例升级为可点选筛选（activeRoles/onToggleRole 缺省 = 纯展示）。
    path: { active: interaction.path.model.active, onToggle: interaction.path.toggle },
    roles: interaction.roleStats,
    activeRoles: interaction.activeRoles,
    onToggleRole: interaction.onToggleRole,
    onNodeClick: interaction.nodeClick,
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
    // cycle-95：路径状态条 + 影响半径读数（未启用时 null ⇒ 零占位）。
    interaction.extras,
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
