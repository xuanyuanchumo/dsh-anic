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
import { useRef, useCallback, type ReactElement } from 'react';
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
import { buildNodeRoles, roleStatsOf, type NodeRole, type RoleStats } from './graphNodeRole.ts';
import { renderGraphExtras, focusBlastOf } from './graphExtras.ts';
// cycle-99：时间轴回放（hook 状态壳 + 纯函数可见集）。
import { buildTimeline, composeWithTimeline, visibleSetAtStep } from './graphTimeline.ts';
import { useGraphTimeline } from './useGraphTimeline.ts';
// cycle-109（U1/U3）：选中集动作与对比矩阵（纯函数，本层只接线）。
import { compareMatrixOf } from './graphCompare.ts';
import type { ModKeyState } from './graphSelection.ts';
import type { GraphSelection } from './useGraphSelection.ts';

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
  /**
   * 选区（cycle-109 · U1/U3）：钉住 + 选中集 + 点击动作，整块透传。
   *
   * 为什么是**一个对象**而不是三个字段：三处消费面（点击改写 / 对比矩阵 / 读数条）
   * 用的都是同一份选区，拆成三个字段就要在组件里逐个转发（而组件贴着 250 行硬限）。
   * 为什么放本层裁决"点击要不要顺便选中"：路径模式下点击 = 设端点，不该顺带改
   * 选区——这个判断只有本层同时看得到模式与选区。
   */
  selection: GraphSelection;
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
  /** 已并入路径高亮与时间轴回放的筛选视图。 */
  filterView: FilterView;
  /** 时间轴回放（cycle-99；steps 空 = 无链，控件不渲染）。 */
  timeline: ReturnType<typeof useGraphTimeline>;
  /** 改写后的节点点击（路径模式 → 设端点；否则 → 选中 + 原回调）。恒存在。 */
  nodeClick: (node: WorkflowNode, mods?: ModKeyState) => void;
  /** 两条读数条（未启用时 null ⇒ 零占位）。 */
  extras: ReactElement[] | null;
  /** 节点角色计数（工具栏角色图例的读数）。 */
  roleStats: RoleStats;
  /** 已选中的角色筛选（透传 filter.roles；undefined = 未启用该维）。 */
  activeRoles: readonly string[] | undefined;
  /** 角色筛选切换（toggle 语义；undefined = 角色图例保持纯展示）。 */
  onToggleRole: ((role: 'entry' | 'hub' | 'leaf' | 'orphan') => void) | undefined;
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
  // ── 节点角色表 + 计数（cycle-100 上移：角色筛选维要在 buildFilterView 之前就位）──
  // nodes/edges 引用做键，O(E) 一次；工具栏图例读数与角色筛选共用同一份角色表。
  const rolesRef = useRef<{ nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[]; roles: Map<string, NodeRole>; stats: RoleStats } | null>(null);
  const rolesHit = rolesRef.current;
  if (rolesHit === null || rolesHit.nodes !== nodes || rolesHit.edges !== edges) {
    const roles = buildNodeRoles(edges, nodes.map((n) => n.id));
    rolesRef.current = { nodes, edges, roles, stats: roleStatsOf(roles) };
  }
  const roleHit = rolesRef.current as { nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[]; roles: Map<string, NodeRole>; stats: RoleStats };
  const roleStats = roleHit.stats;
  // 角色查找函数（角色筛选维用；Map.get 封装，未判定 → null）。
  const roleOfNodeId = useCallback((id: string): NodeRole | null => roleHit.roles.get(id) ?? null, [roleHit]);
  const baseView = buildFilterView(nodes, edges, input.filter, input.adjacencyOn ? input.focusId : null, input.verdicts, roleOfNodeId);
  const withPath = withPathHighlight(baseView, path.model.highlight);
  // cycle-99：时间轴回放——steps 按 nodes 引用缓存（2s 轮询同数据零重算）；
  // index=-1（未启用）时 composeWithTimeline 不参与（原视图原样透传）。
  const timelineRef = useRef<{ key: readonly WorkflowNode[]; steps: ReturnType<typeof buildTimeline> } | null>(null);
  const tlHit = timelineRef.current;
  const timelineSteps = tlHit !== null && tlHit.key === nodes ? tlHit.steps : (() => {
    const steps = buildTimeline(nodes);
    timelineRef.current = { key: nodes, steps };
    return steps;
  })();
  const timeline = useGraphTimeline(timelineSteps);
  const filterView = timeline.index >= 0
    ? composeWithTimeline(withPath, visibleSetAtStep(nodes, edges, timelineSteps, timeline.index))
    : withPath;
  const view = useGraphView({
    edges, layout: input.layout, adjacency,
    filter: input.filter, filterView,
    viewport: input.viewport, size: input.size, focusId: input.focusId,
    containerRef: input.containerRef,
    layoutMode: input.layoutMode, onLayoutMode: input.onLayoutMode,
    onFilterChange: input.onFilterChange,
    onViewportChange: input.onViewportChange,
  });

  // ── 点击改写（路径模式优先，见文件头裁决）────────────────────
  /*
   * 恒存在：点击的第一件事是"选中"（pin），它不依赖面板是否传了 onNodeClick。
   * 改造前这里在没有回调时返回 undefined ⇒ 节点连 role=button 都没有，
   * "点一下钉住"对"面板没接详情抽屉"的挂载形态直接不存在。
   */
  const nodeClick = (node: WorkflowNode, mods?: ModKeyState): void => {
    if (input.hasMoved()) return; // 拖拽越界不算点击（与装配层同一判据）
    // 路径模式里点击是"设端点"：此时**不**动选区（否则每选一个端点都会顺便
    // 钉住它，钉住描边会盖住路径高亮，用户看到的颜色说不清是谁给的）。
    if (path.model.active) { path.pick(node.id); return; }
    input.selection.onNodeSelect(node.id, mods);
    input.onNodeClick?.(node);
  };

  // ── 读数条 ──────────────────────────────────────────────────
  const blast = focusBlastOf(traceAdjacency, input.focusId);
  // cycle-109（U3）：选中集 ≥2 才算矩阵（单列对比只是噪声——零占位）。
  const compare = input.selection.ids.length < 2
    ? null
    : compareMatrixOf({
        ids: input.selection.ids, nodes, verdicts: input.verdicts,
        adjacency: traceAdjacency, roles: roleHit.roles,
      });
  const extras = renderGraphExtras({
    path: path.model, focusId: input.focusId, blast, onPathExit: path.exit,
    timeline: {
      steps: timelineSteps, index: timeline.index, playing: timeline.playing,
      onSeek: timeline.seek, onTogglePlay: timeline.togglePlay, onExit: timeline.exit,
    },
    compare,
  });

  return {
    view, path, filterView, nodeClick, extras, roleStats, timeline,
    // cycle-100：角色筛选维——roles 键在 filter 上时启用（旧字面量无该键 ⇒ undefined
    // ⇒ 图例保持纯展示，零行为变化）。
    activeRoles: input.filter.roles,
    onToggleRole: input.filter.roles === undefined ? undefined : (role: 'entry' | 'hub' | 'leaf' | 'orphan'): void => {
      const cur = input.filter.roles ?? [];
      const next = cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role];
      input.onFilterChange({ ...input.filter, roles: next });
    },
  };
}
