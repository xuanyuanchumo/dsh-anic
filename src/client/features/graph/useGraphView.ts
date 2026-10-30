/**
 * 图区新增交互的**状态与动作**（cycle-90）——布局模式 / 仅看异常 / 缩放到选中 /
 * 导出 SVG / 全屏。
 *
 * ## 为什么这些状态住在组件内部（不新增 store 切片）
 *
 * 接线限制：`WorkflowGraphPanel.ts` 与 `panelState.ts` 是 Lead 独占文件，本轮
 * **不能**改它们。而这些能力全部是**图区局部**的：
 * - 布局模式：只影响本图区的排布，不影响任何其它分区；
 * - 仅看异常：只是 `FilterState` 的一个快捷入口，本质是筛选；
 * - 缩放到选中：视口状态，本来就在图区内部；
 * - 导出 / 全屏：纯动作，产出物在图区之外。
 *
 * 给它们开 store 切片会让「面板其它分区」承担一份它们用不到的状态，且每个
 * 数据 tick 都要多比对一次 slice —— 收益为零。所以状态住在图区组件内。
 *
 * ## 导出必须「所见即所得」（筛选态 + 视口）
 *
 * 导出的是**当前**布局 + **当前**筛选视图 + **当前**视口包围盒，而不是原始
 * 数据：用户按「导出」的心智是「把这张图存下来」，他眼前是什么就存什么。
 *
 * ## 全屏失败必须**如实降级**
 *
 * `requestFullscreen` 可能不存在、可能被拒。失败时把原因显示在工具栏
 * （`role="status"`，AT 自动播报），**不静默**。
 */
import { useCallback, useState } from 'react';
import type { WorkflowEdge } from '../../workflowGraphData.ts';
import type { GraphLayout, PositionedNode } from './graphLayout.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import type { FilterState, FilterView } from './graphFilter.ts';
import { isAnomalyOnly, withAnomalyOnly } from './graphAnomalyFilter.ts';
import { fitToSelection, selectionScopeOf } from './graphFitSelection.ts';
import { exportFileName, serializeGraphSvg } from './graphExportSvg.ts';
import { enterFullscreen, exitFullscreen, isFullscreenOf } from './graphFullscreen.ts';
import { gt } from './graphText.ts';
import type { Viewport } from './graphViewport.ts';

/** 新增交互的入参（图区组件提供）。 */
export interface GraphViewInput {
  edges: readonly WorkflowEdge[];
  layout: GraphLayout;
  /** 邻接表（缩放到选中用；由 `buildAdjacency` 产出）。 */
  adjacency: ReadonlyMap<string, Set<string>>;
  /** 当前筛选状态（仅看异常会改它）。 */
  filter: FilterState;
  /** 当前筛选视图（导出用 —— 决定每个节点的 opacity）。 */
  filterView: FilterView;
  /** 当前视口（导出与缩放用）。 */
  viewport: Viewport;
  /** 视口像素尺寸。 */
  size: { width: number; height: number };
  /** 当前焦点节点（"缩放到选中"的目标）。 */
  focusId: string | null;
  /** 图区容器元素（全屏目标）。 */
  containerRef: { current: HTMLElement | null };
  /**
   * 当前布局模式 + 切换回调。
   *
   * 为什么由**调用方**持有而不是本 hook 自己存：布局模式的**唯一消费者**是
   * 布局计算（`useLayoutCache`），而本 hook 只是把它转发给工具栏。
   * 若本 hook 另存一份，工具栏显示的模式与图实际排布的模式就会**分叉**
   * —— 用户点了"紧凑"，按钮变了但图没变（这正是我们实测到的现象）。
   * 单一事实来源：模式住在 `useLayoutCache`，两处都从那里读。
   */
  layoutMode: LayoutMode;
  onLayoutMode: (mode: LayoutMode) => void;
  /** 改筛选状态（仅看异常写回用）。 */
  onFilterChange: (next: FilterState) => void;
  /** 改视口（缩放到选中写回用）。 */
  onViewportChange: (next: Viewport) => void;
}

/** 新增交互的状态与动作（组件只做装配）。 */
export interface GraphViewState {
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
  anomalyOnly: boolean;
  toggleAnomaly: () => void;
  fitSelection: () => void;
  exportSvg: () => void;
  toggleFullscreen: () => void;
  fullscreen: boolean;
  /** 降级提示（通常为空串）。 */
  note: string;
  /** 是否可缩放到选中（有焦点节点）。 */
  hasSelection: boolean;
}

/**
 * 导出文件名的时间戳。
 *
 * 为什么由这里生成而不是序列化器内部：序列化器是**纯函数**（不读 clock），
 * 读 clock 就破坏「两次调用产出同样文本」的可测性。时间戳只在**点击那一刻**
 * 需要，由本文件（副作用层）生成后传进去。
 */
function stampNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 图区新增交互的 hook。
 *
 * 只用 stub 支持的 hooks（`useState` / `useCallback` —— 见 GraphInteractive 头注
 * 「只用 stub 支持的 hooks」），smoke 环境能展开。
 */
export function useGraphView(input: GraphViewInput): GraphViewState {
  const [fullscreen, setFullscreen] = useState(false);
  const [note, setNote] = useState('');

  const {
    adjacency, containerRef, filter, filterView, focusId, layout, size, viewport,
    layoutMode, onLayoutMode,
  } = input;

  /** 仅看异常：复用 `graphFilter` 的裁决集合（不另写筛选逻辑）。 */
  const toggleAnomaly = useCallback((): void => {
    input.onFilterChange(withAnomalyOnly(filter, !isAnomalyOnly(filter)));
  }, [filter, input]);

  /** 缩放到选中（含 1 跳邻域）。无焦点节点时**不做任何事**（不是假动作）。 */
  const fitSelection = useCallback((): void => {
    const scope = selectionScopeOf(focusId, adjacency);
    if (scope.size === 0) return;
    const next = fitToSelection(layout.nodes, scope, size, viewport);
    if (next === null) return;
    input.onViewportChange(next);
  }, [adjacency, focusId, input, layout.nodes, size, viewport]);

  /**
   * 导出 SVG（所见即所得）。
   *
   * 为什么用 `Blob` + `createObjectURL` + `<a download>`：这是**唯一**不需要
   * 任何依赖、也不需要服务端往返的浏览器原生下载路径。`URL.revokeObjectURL`
   * 必须在点击后回收 —— 否则 blob 会一直挂在内存里（用户导出十次就泄漏十份图）。
   */
  const exportSvg = useCallback((): void => {
    const svg = serializeGraphSvg({
      edges: input.edges,
      layout,
      filterView,
      viewport,
      size,
      title: 'anic-graph',
    });
    const name = exportFileName('anic-graph', stampNow());
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      // 回收：blob URL 不 revoke 会一直占内存（用户导出十次 = 泄漏十份图）。
      URL.revokeObjectURL(url);
    } catch {
      setNote(gt('exportSvgHint'));
    }
  }, [filterView, input, layout, size, viewport]);

  /** 全屏切换：进入失败时**如实**把原因显示出来（不静默）。 */
  const toggleFullscreen = useCallback((): void => {
    const el = containerRef.current;
    if (isFullscreenOf(el)) {
      void exitFullscreen().then((r) => {
        setFullscreen(isFullscreenOf(el));
        if (!r.ok && r.message !== null) setNote(r.message);
      });
      return;
    }
    if (el === null) {
      setNote(gt('fullscreenUnavailable'));
      return;
    }
    void enterFullscreen(el).then((r) => {
      setFullscreen(r.ok && isFullscreenOf(el));
      if (!r.ok && r.message !== null) setNote(r.message);
    });
  }, [containerRef]);

  return {
    layoutMode,
    setLayoutMode: onLayoutMode,
    anomalyOnly: isAnomalyOnly(filter),
    toggleAnomaly,
    fitSelection,
    exportSvg,
    toggleFullscreen,
    fullscreen,
    note,
    hasSelection: focusId !== null,
  };
}

/** 布局节点表（供其它模块取；单独转出免得 import 类型路径散落）。 */
export type { PositionedNode };
