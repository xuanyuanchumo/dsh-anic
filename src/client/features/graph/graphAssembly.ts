/**
 * 图区的**渲染装配**（cycle-90）——工具栏 props + `renderGraph` 选项。
 *
 * ## 为什么单独成文件
 *
 * `GraphInteractive.ts` 承载**状态**（filter / focus / trace / 布局模式）与
 * 副作用（手势 / 缓存），而"把这些状态摆成 props"是**纯映射**。两者混在一起
 * 时，组件文件被 props 装配撑破 250 行硬限，而那些 props 装配**一行交互逻辑
 * 都没有**——它们只是"把已有状态摆成对象"。
 *
 * 拆开后：组件只剩「状态 + 一次装配」，而装配本身**可以直接单测**（纯函数，
 * 不必真挂载组件）。
 *
 * ## 为什么 renderGraph 的选项也归这里
 *
 * 同一组选项（viewport / filterView / focusId / layout / size / trace /
 * laneHeaders）既喂给工具栏也喂给图渲染。放在一处 ⇒ 两处消费的是**同一批值**，
 * 不会出现"工具栏显示 100% 而图上是 80%"那种漂移。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import type { FilterState, FilterView } from './graphFilter.ts';
import type { GraphLayout } from './graphLayout.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import type { Viewport } from './graphViewport.ts';
import type { TraceResult } from './graphTrace.ts';
import type { GraphRenderOptions } from './renderGraph.ts';
import type { ToolbarWiring } from './graphInteractiveParts.ts';
import { toolbarWiring } from './graphInteractiveParts.ts';
import { toolbarPropsWithView, type ViewWiringInput } from './graphToolbarWire.ts';
import type { PathGroupInput } from './graphToolbarPath.ts';
import type { RoleLegendStats } from './graphToolbarLegendRow.ts';

/** 渲染装配的输入（全部由组件提供）。 */
export interface RenderAssemblyInput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  verdicts: Map<string, string> | undefined;
  layout: GraphLayout;
  filter: FilterState;
  filterView: FilterView;
  focusId: string | null;
  viewport: Viewport;
  size: { width: number; height: number };
  trace: TraceResult;
  adjacencyOn: boolean;
  /** 既有工具栏字段（回调由组件提供）。 */
  toolbarBase: ToolbarWiring;
  /** 新增视图组字段（cycle-90）。 */
  view: ViewWiringInput;
  /** 路径模式开关（cycle-95；缺省 = 不渲染该组，见 graphToolbarPath）。 */
  path: PathGroupInput;
  /** 角色图例读数（cycle-95；缺省 = 不渲染角色图例）。 */
  roles: RoleLegendStats;
  /** 节点点击回调（缺省 = 不可交互）。 */
  onNodeClick: ((node: WorkflowNode) => void) | undefined;
  /** 拖拽过界时不该触发点击（组件提供）。 */
  hasMoved: () => boolean;
  /** 缩放键处理器（合并进 svg 的 onKeyDown）。 */
  keyHandler: (ev: { key: string; preventDefault: () => void }) => void;
  /** 键盘说明元素 id。 */
  describedBy: string;
  /** 双击节点进入追溯。 */
  onNodeTrace: (node: WorkflowNode) => void;
}

/** 既有工具栏字段的输入（回调由组件提供）。 */
export interface ToolbarBaseInput {
  nodes: WorkflowNode[];
  verdicts: Map<string, string> | undefined;
  filter: FilterState;
  adjacencyOn: boolean;
  viewport: Viewport;
  onQuery: (q: string) => void;
  onToggleType: (type: string) => void;
  onToggleVerdict: (verdict: string) => void;
  onAdjacencyToggle: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onClear: () => void;
  searchMatches: { id: string; label: string }[];
  searchTotal: number;
  onJump: (id: string) => void;
  activeMatchIndex: number;
  onMoveMatch: (delta: number) => void;
  onJumpActive: () => void;
}

/** 既有工具栏 props（计数在 `toolbarWiring` 里现算 —— 见其头注）。 */
export function assemblyToolbarBaseOf(input: ToolbarBaseInput): ToolbarWiring {
  return toolbarWiring({
    nodes: input.nodes,
    verdicts: input.verdicts,
    filter: input.filter,
    adjacencyOn: input.adjacencyOn,
    viewport: input.viewport,
    onQuery: input.onQuery,
    onToggleType: input.onToggleType,
    onToggleVerdict: input.onToggleVerdict,
    onAdjacencyToggle: input.onAdjacencyToggle,
    onZoomIn: input.onZoomIn,
    onZoomOut: input.onZoomOut,
    onFit: input.onFit,
    onClear: input.onClear,
    searchMatches: input.searchMatches,
    searchTotal: input.searchTotal,
    onJump: input.onJump,
    activeMatchIndex: input.activeMatchIndex,
    onMoveMatch: input.onMoveMatch,
    onJumpActive: input.onJumpActive,
  });
}

/** 工具栏 props（既有字段 + 视图组 + 路径组/角色图例，cycle-95）。 */
export function assemblyToolbarOf(
  input: RenderAssemblyInput,
): ToolbarWiring & { view: ViewWiringInput; path: PathGroupInput; roles: RoleLegendStats; layoutQuality: { crossings: number; droppedDuplicates: number } } {
  return {
    ...toolbarPropsWithView(input.toolbarBase, input.view),
    path: input.path,
    roles: input.roles,
    // cycle-101：布局质量读数直接取自 layout（单一事实源——不在组件层重算）。
    // crossings 是 cycle-94 就有的读数（同一把尺量三种模式），此前无 UI 出口；
    // droppedDuplicates 是本轮新增的「静默丢弃白盒化」。两者都不改布局算法。
    layoutQuality: {
      crossings: input.layout.crossings ?? 0,
      droppedDuplicates: input.layout.droppedDuplicates ?? 0,
    },
  };
}

/** `renderGraph` 的选项（与工具栏吃的是同一批值，见文件头）。 */
export function assemblyGraphOptionsOf(input: RenderAssemblyInput): GraphRenderOptions {
  return {
    viewport: input.viewport,
    filterView: input.filterView,
    focusId: input.focusId,
    layout: input.layout,
    // size 传可视区：交互态画布必须等于视口，否则放大后的内容会被 svg 自身
    // 宽高裁掉（见 GraphRenderOptions.size 的注释）。小地图也只在这条路径出现。
    size: input.size,
    // 缩放键合并进 svg 的 onKeyDown —— svg 仍是**唯一** Tab 停靠点
    // （既有 graphA11y/graphRoving 契约），见 graphCanvas 里 keyHandler 的注释。
    keyHandler: input.keyHandler,
    describedBy: input.describedBy,
    // 追溯视图（cycle-84）：root 为 null 时 trace === EMPTY_TRACE，渲染与改造前一致。
    trace: input.trace,
    onNodeTrace: input.onNodeTrace,
    // 泳道表头（cycle-90）：坐标全部由布局算出，渲染层只画。
    laneHeaders: true,
    // 边命中层（cycle-98）：交互态打开——292 条边悬停可感知（透明 overlay +
    // 原生 title），零新 React 状态，2s 轮询重建成本不变。
    edgeHits: true,
  };
}

/** 节点点击回调（拖拽越界时不触发：否则"拖了一下图"就跳进节点详情抽屉）。 */
export function assemblyNodeClickOf(
  input: RenderAssemblyInput,
): ((node: WorkflowNode) => void) | undefined {
  if (input.onNodeClick === undefined) return undefined;
  return (n) => { if (!input.hasMoved()) input.onNodeClick?.(n); };
}

/** 布局模式（供组件读 state，单独转出免得 import 类型路径散落）。 */
export type { LayoutMode };
