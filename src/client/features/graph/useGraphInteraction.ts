/**
 * 图区**交互组合层**（cycle-95 · WS-C）——把「视图态持久化 + 路径模式 + 影响半径」
 * 三件事拼成一次调用，让 `GraphInteractive` 只剩"状态 + 一次装配"。
 *
 * ## 为什么必须组合（不是风格选择）
 *
 * `GraphInteractive.ts` 在 cycle-94 结束时就 248 行，而 250 行是
 * `objectiveConformanceContract ⑪` 的机械硬限。cycle-95 要接线三件新能力
 * （分键视图态 / 路径模式 / 影响半径读数），内联必然破限 —— 而"删注释腾行数"
 * 是本仓明确反对的退化（注释承载判据）。所以三件事各自成文件，本文件只负责
 * **把它们的输入输出连起来**，组件再调一次本文件。
 *
 * 拆分的界线仍是职责：本文件回答「谁依赖谁」（视图态要读视口/筛选/模式、
 * 路径模式要读邻接表、影响半径要读焦点节点），组件回答「状态从哪来」。
 *
 * ## 一个必须写下来的接线裁决：路径模式**改写节点点击语义**
 *
 * 路径模式里点一下节点的意思是"设端点"，不是"打开详情抽屉"。若不改写，
 * 用户每选一个端点就会同时弹一次抽屉 —— 两个动作互相打断（与
 * `graphTrace` 双击互斥那条注释同族）。改写点在本文件（`nodeClick`），
 * 而不是在 `graphNodeCard`：后者属 WS-B 写域，且"点一下会发生什么"本就是
 * **交互**的决定，不该烧进渲染层。
 *
 * ## 为什么 `filterView` 也在本文件算
 *
 * 路径高亮要并进 `highlight` 通道（**复用**既有渲染语义，零新增渲染代码）。
 * 而 `filterView` 的另外两个生产者在组件里（`filter` / `focusId`），
 * 把"并高亮"放在两者之间 —— 本文件是唯一同时看得到它们与路径模型的地方。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供七个 API。本文件不直接调 hook
 * （但被 `GraphInteractive` 在 stub 下执行到，故间接调用的三个 hook 各自都只用
 * 允许集内的 API）。
 */
import { useRef, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import type { GraphLayout } from './graphLayout.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import type { Viewport } from './graphViewport.ts';
import { buildFilterView, type FilterState, type FilterView } from './graphFilter.ts';
import { adjacencyOf, traceAdjacencyOf } from './graphCaches.ts';
import { useGraphView, type GraphViewState } from './useGraphView.ts';
import { useGraphPathMode, type GraphPathMode } from './useGraphPathMode.ts';
import { useGraphViewState } from './useGraphViewState.ts';
import { withPathHighlight } from './graphPathMode.ts';
import { buildNodeRoles, roleStatsOf, type RoleStats } from './graphNodeRole.ts';
import { renderGraphExtras, focusBlastOf } from './graphExtras.ts';

/** 组合层的入参（组件提供全部状态；本层不持有它们）。 */
export interface GraphInteractionInput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  verdicts: Map<string, string> | undefined;
  layout: GraphLayout;
  filter: FilterState;
  focusId: string | null;
  viewport: Viewport;
  size: { width: number; height: number };
  containerRef: { current: HTMLElement | null };
  layoutMode: LayoutMode;
  onLayoutMode: (mode: LayoutMode) => void;
  onFilterChange: (next: FilterState) => void;
  onViewportChange: (next: Viewport) => void;
  /** 面板原生的节点点击（路径模式下会被改写，见文件头）。 */
  onNodeClick: ((node: WorkflowNode) => void) | undefined;
  /** 拖拽越界时不触发点击（手势层提供）。 */
  hasMoved: () => boolean;
  /** 邻接高亮开关（决定 focusId 是否参与 highlight）。 */
  adjacencyOn: boolean;
  /** 当前工作区（分键视图态用；undefined = 未学到 ⇒ 不记忆）。 */
  workspace: string | undefined;
}

/** 组合层的产出（组件只做装配）。 */
export interface GraphInteraction {
  /** 视图组（cycle-90 的五件事）。 */
  view: GraphViewState;
  /** 路径模式（状态 + 读数 + 动作）。 */
  path: GraphPathMode;
  /** 已并入路径高亮的筛选视图。 */
  filterView: FilterView;
  /** 改写后的节点点击（路径模式 → 设端点；否则 → 原回调）。 */
  nodeClick: ((node: WorkflowNode) => void) | undefined;
  /** 两条读数条（未启用时 null ⇒ 零占位）。 */
  extras: ReactElement[] | null;
  /** 节点角色计数（工具栏角色图例的读数）。 */
  roleStats: RoleStats;
}

export function useGraphInteraction(input: GraphInteractionInput): GraphInteraction {
  const { nodes, edges } = input;

  // ── 路径模式：邻接表按 edges 引用缓存（与追溯共用同一份实现，不建第二份）──
  const traceAdjRef = useRef<{ key: readonly WorkflowEdge[]; adj: ReturnType<typeof traceAdjacencyOf> } | null>(null);
  const traceAdjacency = traceAdjacencyOf(edges, traceAdjRef);
  const path = useGraphPathMode({ adjacency: traceAdjacency });

  // ── 分键视图态（O-94-03）：挂载/切工作区恢复，变化时节流写盘 ──
  useGraphViewState({
    workspace: input.workspace,
    viewport: input.viewport,
    filter: input.filter,
    layoutMode: input.layoutMode,
    onRestoreViewport: input.onViewportChange,
    onRestoreFilter: input.onFilterChange,
    onRestoreLayout: input.onLayoutMode,
  });

  // ── 视图组（cycle-90）───────────────────────────────────────
  // 邻居表按 nodes 引用缓存（缩放到选中要它）；与组件里预览用的那份同源实现。
  const adjRef = useRef<{ key: readonly WorkflowNode[]; map: Map<string, Set<string>> } | null>(null);
  const adjacency = adjacencyOf(nodes, edges, adjRef);
  const baseView = buildFilterView(nodes, edges, input.filter, input.adjacencyOn ? input.focusId : null, input.verdicts);
  const filterView = withPathHighlight(baseView, path.model.highlight);
  const view = useGraphView({
    edges, layout: input.layout, adjacency,
    filter: input.filter, filterView,
    viewport: input.viewport, size: input.size, focusId: input.focusId,
    containerRef: input.containerRef,
    layoutMode: input.layoutMode, onLayoutMode: input.onLayoutMode,
    onFilterChange: input.onFilterChange,
    onViewportChange: input.onViewportChange,
  });

  // ── 节点角色计数（工具栏图例读数）：nodes/edges 引用做键，O(E) 一次 ──
  const rolesRef = useRef<{ nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[]; stats: RoleStats } | null>(null);
  const hit = rolesRef.current;
  if (hit === null || hit.nodes !== nodes || hit.edges !== edges) {
    const roles = buildNodeRoles(edges, nodes.map((n) => n.id));
    rolesRef.current = { nodes, edges, stats: roleStatsOf(roles) };
  }
  const roleStats = (rolesRef.current as { stats: RoleStats }).stats;

  // ── 点击改写（路径模式优先，见文件头裁决）────────────────────
  const nodeClick = input.onNodeClick === undefined && !path.model.active
    ? undefined
    : (node: WorkflowNode): void => {
        if (input.hasMoved()) return; // 拖拽越界不算点击（与装配层同一判据）
        if (path.model.active) { path.pick(node.id); return; }
        input.onNodeClick?.(node);
      };

  // ── 两条读数条 ──────────────────────────────────────────────
  const blast = focusBlastOf(traceAdjacency, input.focusId);
  const extras = renderGraphExtras({
    path: path.model, focusId: input.focusId, blast, onPathExit: path.exit,
  });

  return { view, path, filterView, nodeClick: nodeClick ?? undefined, extras, roleStats };
}
