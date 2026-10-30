/**
 * 图区工具栏的**接线**（cycle-90）——把新增交互（视图组）接到既有工具栏上。
 *
 * ## 为什么单独成文件
 *
 * `GraphInteractive.ts` 在 cycle-90 之前已经 237 行（250 行是机械硬限）。
 * 新增五个控件的接线若全部内联，必然破限。拆分的界线是**职责**：
 * 本文件回答「工具栏怎么拿到这些状态与回调」，组件继续回答「这些状态从哪来」。
 *
 * ## 为什么视图组**可选**
 *
 * `renderGraphToolbar` 的 `view` 字段是可选的：既有契约测试（`graphInteractiveContract` ②）
 * 直接调它时只传旧字段，缺省时**不渲染这一组** —— 零参调用仍是「改造前的工具栏」。
 * 这样老断言（"每组控件齐全"）不会因为新控件而误判，测试也能按需断言新控件。
 */
import type { FilterState } from './graphFilter.ts';
import type { Viewport } from './graphViewport.ts';
import type { ToolbarWiring } from './graphInteractiveParts.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import type { ViewGroupInput } from './graphToolbarView.ts';

/** 视图组的接线输入（组件的状态 → 工具栏的 props）。 */
export interface ViewWiringInput {
  layoutMode: LayoutMode;
  onLayoutMode: (mode: LayoutMode) => void;
  anomalyOnly: boolean;
  onAnomalyToggle: () => void;
  hasSelection: boolean;
  onFitSelection: () => void;
  onExportSvg: () => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  note: string;
}

/** 视图组 props（缺省 undefined = 不渲染该组，见文件头）。 */
export function viewGroupOf(input: ViewWiringInput): ViewGroupInput {
  return {
    layoutMode: input.layoutMode,
    onLayoutMode: input.onLayoutMode,
    anomalyOnly: input.anomalyOnly,
    onAnomalyToggle: input.onAnomalyToggle,
    hasSelection: input.hasSelection,
    onFitSelection: input.onFitSelection,
    onExportSvg: input.onExportSvg,
    onFullscreen: input.onFullscreen,
    fullscreen: input.fullscreen,
    note: input.note,
  };
}

/**
 * 工具栏 props（既有字段 + 新增的视图组）。
 *
 * 既有字段**逐字不变** —— 契约测试 ② 直接构造这些 props，字段名/类型变了
 * 那条测试就红。
 */
export function toolbarPropsWithView(
  base: ToolbarWiring,
  view: ViewWiringInput,
): ToolbarWiring & { view: ViewGroupInput } {
  return { ...base, view: viewGroupOf(view) };
}

/** 筛选状态的类型别名（供其它模块引用，避免重复 import 路径）。 */
export type { FilterState, Viewport };
