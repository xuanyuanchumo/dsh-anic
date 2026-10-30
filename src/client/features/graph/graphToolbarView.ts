/**
 * 工具栏「视图」组（cycle-90）——布局模式 / 仅看异常 / 缩放到选中 / 导出 / 全屏。
 *
 * ## 为什么这五件事要**单独成组**
 *
 * 既有五组是「收窄视图」（search/type/verdict）与「改变观察方式」（zoom）与
 * 「辅助动作」（a11y）。本组是第四类：**改变图本身**。
 *
 * 分类依据是**用户的心智模型**，不是控件类型：
 * - 布局模式 = 换一种排布看同一份数据；
 * - 仅看异常 = 换一批数据（筛选的一种，但走的是独立入口）；
 * - 缩放到选中 = 换观察位置（与 zoom 组同源，但目标是"某个节点"而非"整图"）；
 * - 导出 / 全屏 = 把图**带走**（离开面板）。
 *
 * 「导出」与「全屏」放在一组还有一个实际理由：它们是图区里仅有的两个
 * "**离开当前视图**"的动作，与"在图里看"的动作（筛/缩放）分开后，
 * 用户不会误以为导出是某种筛选。
 *
 * ## 全部是动作语义 ⇒ 真 `<button>`
 *
 * 与「取值」语义（搜索框 / chips / select）不同，这五个都是**动作**：
 * 按一下就发生一件事。所以用 `<button>` 而不是 checkbox/radio。
 * 唯一例外是「仅看异常」——它是**布尔状态**（开/关），但用户心智是"按一下只看异常"
 * （动作）而不是"这个复选框勾上了"（状态）。为了一致性，它也是 `<button>`
 * 并带 `aria-pressed`（AT 会播报"已按下"）。
 */
import { createElement, type ReactElement } from 'react';
import { GROUP_LABEL, renderToolbarGroup } from './graphToolbarGroups.ts';
import { gt } from './graphText.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';

/** 视图组入参（全部可选 —— 缺省时对应控件渲染为 disabled）。 */
export interface ViewGroupInput {
  /** 布局模式 + 切换回调。 */
  layoutMode: LayoutMode;
  onLayoutMode: (mode: LayoutMode) => void;
  /** 「仅看异常」是否开。 */
  anomalyOnly: boolean;
  onAnomalyToggle: () => void;
  /** 是否有选中节点（无选中时"缩放到选中"禁用 —— 按钮存在但不可用，优于消失）。 */
  hasSelection: boolean;
  onFitSelection: () => void;
  onExportSvg: () => void;
  onFullscreen: () => void;
  /** 全屏是否已开启（按钮文案随之切换）。 */
  fullscreen: boolean;
  /**
   * 降级提示（通常是空串）。
   *
   * 为什么放在工具栏里而不是别处：全屏失败是**用户刚刚按下按钮**造成的反馈，
   * 提示必须出现在他视线所及的地方（工具栏就在按钮旁边）。
   * 用 `role="status"` ⇒ AT 会自动播报（不依赖用户去发现）。
   */
  note: string;
}

/** 模式切换按钮（两个互斥按钮 + `aria-pressed` 表达当前态）。 */
function renderModeButtons(input: ViewGroupInput): ReactElement[] {
  const modes: Array<{ mode: LayoutMode; label: () => string }> = [
    { mode: 'lane', label: () => gt('layoutModeLane') },
    { mode: 'compact', label: () => gt('layoutModeCompact') },
  ];
  return modes.map((m) => {
    const active = input.layoutMode === m.mode;
    return createElement('button', {
      key: `layout-mode-${m.mode}`,
      type: 'button',
      // 锚点：模式值进 DOM，测试可断言"当前是哪个模式"。
      'data-anic-graph-layout-mode': 'true',
      'data-anic-graph-layout-mode-value': m.mode,
      'aria-pressed': active ? 'true' : 'false',
      'aria-label': gt('layoutModeLabel'),
      title: gt('layoutModeLabel'),
      onClick: () => { input.onLayoutMode(m.mode); },
      className: 'anic-btn',
      style: {
        padding: '0 6px', fontSize: 10.5,
        // 选中态用边框加粗表达（不靠背景色单独承载信息 —— WCAG 1.4.1）。
        borderWidth: active ? 2 : 1,
        fontWeight: active ? 'bold' : undefined,
      },
    }, m.label());
  });
}

/** 视图组（工具栏的第 6 组）。 */
export function renderViewGroup(input: ViewGroupInput): ReactElement {
  return renderToolbarGroup({
    id: 'view',
    label: GROUP_LABEL.view,
    children: [
      ...renderModeButtons(input),
      // 分隔：模式切换与后面的开关不是一回事。
      createElement('span', {
        key: 'sep-views',
        'aria-hidden': 'true',
        style: { width: 1, height: 14, margin: '0 2px', background: 'currentColor', opacity: 0.22 },
      }),
      createElement('button', {
        key: 'anomaly',
        type: 'button',
        // 锚点：P0-2 的可断言入口。
        'data-anic-graph-filter-anomaly': 'true',
        'aria-pressed': input.anomalyOnly ? 'true' : 'false',
        'aria-label': gt('filterAnomaly'),
        title: gt('filterAnomalyHint'),
        onClick: input.onAnomalyToggle,
        className: 'anic-btn',
        style: {
          padding: '0 6px', fontSize: 10.5,
          borderWidth: input.anomalyOnly ? 2 : 1,
          fontWeight: input.anomalyOnly ? 'bold' : undefined,
        },
      }, gt('filterAnomaly')),
      createElement('button', {
        key: 'fit-selection',
        type: 'button',
        // 锚点：P1-4。
        'data-anic-graph-fit-selection': 'true',
        'aria-label': gt('fitSelection'),
        title: gt('fitSelectionHint'),
        onClick: input.onFitSelection,
        disabled: !input.hasSelection,
        className: 'anic-btn',
        style: { padding: '0 6px', fontSize: 10.5 },
      }, gt('fitSelection')),
      createElement('button', {
        key: 'export-svg',
        type: 'button',
        // 锚点：P1-5。
        'data-anic-graph-export-svg': 'true',
        'aria-label': gt('exportSvg'),
        title: gt('exportSvgHint'),
        onClick: input.onExportSvg,
        className: 'anic-btn',
        style: { padding: '0 6px', fontSize: 10.5 },
      }, gt('exportSvg')),
      createElement('button', {
        key: 'fullscreen',
        type: 'button',
        // 锚点：P2-6。
        'data-anic-graph-fullscreen': 'true',
        'aria-label': input.fullscreen ? gt('fullscreenExit') : gt('fullscreen'),
        title: input.fullscreen ? gt('fullscreenExit') : gt('fullscreen'),
        onClick: input.onFullscreen,
        className: 'anic-btn',
        style: { padding: '0 6px', fontSize: 10.5 },
      }, input.fullscreen ? gt('fullscreenExit') : gt('fullscreen')),
      // 降级提示位：全屏失败时把**原因**显示出来（不静默）。
      createElement('span', {
        key: 'fullscreen-note',
        'data-anic-graph-fullscreen-note': 'true',
        className: 'anic-sr-only',
        role: 'status',
      }, input.note),
    ],
  });
}
