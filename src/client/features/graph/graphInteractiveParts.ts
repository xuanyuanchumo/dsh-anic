/**
 * `GraphInteractive` 的装配零件（cycle-83 · V 战线）——**纯函数**，无 hook、无状态。
 *
 * ## 为什么把这些抽出来
 *
 * cycle-83 的组件同时要出三份 props：工具栏（13 个字段）、舞台（9 个字段）、
 * 渲染选项（9 个字段）。它们全是"把已有状态摆成对象"，没有一行是交互逻辑，
 * 却占掉组件 60+ 行 —— 而 250 行纪律（`truthAuditChecks` 机械扫描）没有商量余地。
 * 抽成纯函数后：① 组件只剩"状态 + 一次装配"；② 这些映射**可以直接单测**
 * （组件本身要 jsdom 真挂载，成本高一个量级）。
 *
 * ## 为什么不能把这些做成自定义 hook
 *
 * `graphInteractiveContract ⑦` 的 stub-hooks 守卫把"跨文件收集的 `use[A-Z]*` 定义"
 * 当白名单。本文件若导出 `useToolbarProps(`，它会因为不在 `GRAPH_FILES` 清单里而
 * 被判成"未列入允许集的 hook"；smoke 的 React 桩也只认七个内置 hook。所以这里
 * 一律是**普通函数**（`xxxOf` / `xxxFor` 命名，不叫 `useXxx`）。
 */
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { FilterState } from './graphFilter.ts';
import type { Viewport } from './graphViewport.ts';
import type { TooltipModel } from './graphTooltip.ts';
import { tooltipPosition } from './graphTooltip.ts';
import { minimapOrigin } from './graphMiniMap.ts';
import { LANE_ORDER, type GraphLayout } from './graphLayout.ts';
import { countTypes, countVerdicts } from './graphFilter.ts';
import { t } from '../../i18n.ts';

/** 视口兜底尺寸：容器尚未测量时用它算中心/适配（stub 环境也是这一档）。 */
export const FALLBACK_SIZE = { width: 900, height: 560 };

/** 视口高度（px）。420 是「一屏内同时看到工具栏 + 图 + 下一分区标题」的位置。 */
export const VIEWPORT_HEIGHT = 420;

/** 键盘操作说明元素的 id（svg 的 aria-describedby 指向它）。 */
export const KEYHINT_ID = 'anic-graph-keys';

/** 键盘说明文案（唯一取用点，`renderViewportFrame` 只收文案不收 i18n 依赖）。 */
export function keyHintText(): string {
  return t('graph.keyHint');
}

/**
 * `prefers-reduced-motion` 探测。
 *
 * 为什么 try/catch：stub 与部分 SSR 环境下 `matchMedia` 不存在或抛错，
 * 而"探测偏好失败"绝不能变成"组件崩溃"——降级到 false（= 保留动效）是安全的，
 * 因为真正的动效开关还在 CSS 的 `@media (prefers-reduced-motion)` 里。
 */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** 工具栏 props 的输入（= 组件里的那一组状态与回调）。 */
export interface ToolbarWiring {
  filter: FilterState;
  typeCounts: { type: string; count: number }[];
  verdictCounts: { type: string; count: number }[];
  viewport: Viewport;
  adjacencyOn: boolean;
  onQuery: (q: string) => void;
  onToggleType: (type: string) => void;
  onToggleVerdict: (verdict: string) => void;
  onAdjacencyToggle: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onClear: () => void;
  /** 搜索命中的前 N 条（cycle-84 跳转选择器；空查询 = 空数组）。 */
  searchMatches: { id: string; label: string }[];
  /** 命中总数（可能 > searchMatches.length，工具条据此显示"共 M 条"）。 */
  searchTotal: number;
  /** 跳转到节点并把视口居中（cycle-84）。 */
  onJump: (id: string) => void;
  /** 命中列表当前游标（cycle-85 ↑/↓ 选择；无命中时为 0）。 */
  activeMatchIndex: number;
  /** 移动游标（+1 下移 / -1 上移，按长度取模循环）。 */
  onMoveMatch: (delta: number) => void;
  /** 跳到当前游标所指的命中。 */
  onJumpActive: () => void;
}

/** 工具栏 props（直接喂 `renderGraphToolbar`，字段名与它完全一致）。 */
export function toolbarPropsOf(w: ToolbarWiring): ToolbarWiring {
  return w;
}

/**
 * 工具栏 props 装配（计数在这里现算）。
 *
 * 为什么计数值不预先存进 state：`typeCounts` 是 `nodes` 的**纯派生**，存进 state
 * 就多了一个"节点变了但计数没跟上"的失效面。放在装配层每次现算，成本 O(n)，
 * 换来的是计数与图永远一致（节点计数正是 chip 徽章的全部意义）。
 */
export function toolbarWiring(input: {
  nodes: WorkflowNode[];
  verdicts?: Map<string, string>;
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
}): ToolbarWiring {
  return {
    filter: input.filter,
    typeCounts: countTypes(input.nodes, LANE_ORDER),
    verdictCounts: countVerdicts(input.nodes, input.verdicts),
    viewport: input.viewport,
    adjacencyOn: input.adjacencyOn,
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
  };
}

/** 舞台装配的输入。 */
export interface StageWiring {
  graph: ReturnType<typeof import('./renderGraph.ts').renderGraph>;
  tooltip: TooltipModel | null;
  layout: GraphLayout;
  viewport: Viewport;
  size: { width: number; height: number };
  focusId: string | null;
  onFocusNode: (id: string | null) => void;
  onMinimapClick: (local: { x: number; y: number }) => void;
  dragging: boolean;
  onKeyDown: (ev: { key: string; preventDefault: () => void }) => void;
  /**
   * 双击**空白处**适配视图（cycle-85）。键盘说明里一直写着这条语义
   * （locale `graph.keyHint`），但此前没有任何实现——文案承诺了不存在的交互，
   * 属"静默失约"；本轮补上实现并加 DOM 契约。
   */
  onBackgroundDoubleClick: () => void;
}

/**
 * 舞台 props：预览卡定位与**小地图原点**在这里算完。
 *
 * 两处都用纯函数（`tooltipPosition` / `minimapOrigin`），所以：
 * ① jsdom 里 `getBoundingClientRect()` 恒 0 也不影响正确性；
 * ② "卡片翻折不越界""点击换算偏差不超过 1px"都能在 node 环境逐档断言。
 */
export function stagePropsOf(w: StageWiring): {
  graph: StageWiring['graph'];
  tooltip: { model: TooltipModel; at: { x: number; y: number } } | null;
  focusId: string | null;
  onFocusNode: StageWiring['onFocusNode'];
  onMinimapClick: StageWiring['onMinimapClick'];
  minimapOrigin: { x: number; y: number };
  dragging: boolean;
  onKeyDown: StageWiring['onKeyDown'];
  onBackgroundDoubleClick: StageWiring['onBackgroundDoubleClick'];
} {
  const anchorNode = w.tooltip === null
    ? undefined
    : w.layout.nodes.find((n) => n.id === w.tooltip?.id);
  return {
    graph: w.graph,
    tooltip: w.tooltip === null
      ? null
      : {
          model: w.tooltip,
          // 找不到对应节点（数据 tick 换了一批）时给一个安全锚点：卡片仍显示内容，
          // 只是位置落在左上。**不能**因此让预览消失——用户还悬停在那个 id 上。
          at: tooltipPosition(anchorNode ?? { x: 0, y: 0, w: 90 }, w.viewport, w.size),
        },
    focusId: w.focusId,
    onFocusNode: w.onFocusNode,
    onMinimapClick: w.onMinimapClick,
    minimapOrigin: minimapOrigin(w.size),
    dragging: w.dragging,
    onKeyDown: w.onKeyDown,
    onBackgroundDoubleClick: w.onBackgroundDoubleClick,
  };
}

/** 面包屑的节点输入（`renderBreadcrumb` 只关心类型与 label）。 */
export function breadcrumbInputOf(nodes: WorkflowNode[]): { nodes: WorkflowNode[] } {
  return { nodes };
}

/**
 * 多选集合的 toggle（"再点一次取消"）。
 *
 * 为什么是纯函数而不是两个内联三元：类型 chips 与裁决选项是**同一套多选语义**，
 * 各写一份内联实现时，改一处忘了另一处就会出现"chip 能取消、下拉不能取消"
 * 这种只有用户点得出来的差异。
 */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * 引用键缓存转出口（cycle-84 移到 graphCaches.ts；调用面零变更）。
 *
 * 保留转出是因为 `GraphInteractive` 与 `graphInteractiveContract` 都从这里取
 * `adjacencyOf` / `layoutOf`——拆文件不该让调用方改 import（本仓 tokens.ts 同形）。
 */
export { adjacencyOf, layoutOf, sameLayoutKey, traceAdjacencyOf } from './graphCaches.ts';
