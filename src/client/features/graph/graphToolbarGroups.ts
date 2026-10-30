/**
 * 工具栏的视觉分组外壳（cycle-83 · V 战线，从 graphToolbar.ts 拆出）。
 *
 * ## 为什么分组（不是装饰）
 *
 * 改造前工具栏是一条 `flex-wrap` 的平铺控件带：搜索框、类型 chips、裁决下拉、
 * 三个缩放键、邻接开关、清空按钮、图例全挤在一行。控制项从 6 个涨到 10+ 个之后，
 * 用户需要**扫一遍才找到目标**——而图区工具栏的使用频率很高（筛类型、缩放、
 * 开关邻接），扫描成本是真实的操作成本。
 *
 * 分组把「找什么」变成「去哪一组」：搜索 / 类型 / 裁决 是**收窄视图**，
 * 缩放 是**改变观察方式**，邻接 + 清空是**辅助动作**。组间用一条竖线分隔 +
 * 组标签（视觉隐藏给 AT），这样既省横向空间，又不靠纯颜色分隔（WCAG 1.4.1：
 * 分隔本身不承载信息，不能只有视觉通道）。
 *
 * ## 为什么组标签是 `anic-sr-only`
 *
 * 可见的组标签会把工具栏撑成两行（10+ 控件已经吃满一行）。而 AT 用户恰恰
 * **更**需要分组信息（屏幕阅读器按线性顺序读，没有"扫一眼"的能力，分组是靠
 * `role=group` + `aria-label` 提供）。所以标签只给 AT，视觉上用分隔线表达。
 */
import { createElement, type ReactElement } from 'react';
import { gt } from './graphText.ts';

/** 一组的可见/可访问信息。 */
export interface ToolbarGroupSpec {
  id: 'search' | 'type' | 'verdict' | 'zoom' | 'a11y';
  label: () => string;
  /** 组内元素（key 已由调用方给出）。 */
  children: ReactElement[];
}

/**
 * 渲染一个工具栏分组。
 *
 * `data-anic-graph-group` 是"分组确实存在"的可断言锚点——否则"工具栏分成三组"
 * 只能靠截图肉眼验证，而任何 DOM 计数断言都会对"一组也没分"同样返回绿。
 */
export function renderToolbarGroup(spec: ToolbarGroupSpec): ReactElement {
  return createElement(
    'div',
    {
      key: `group-${spec.id}`,
      'data-anic-graph-group': spec.id,
      role: 'group',
      'aria-label': spec.label(),
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    },
    ...spec.children,
  );
}

/**
 * 组间分隔线（纯装饰，`aria-hidden`）。
 *
 * 为什么不是 `border-left` 而是独立元素：`flex-wrap` 下边框会跟着控件换行，
 * 变成某个控件左边挂一条线（看起来像"这个控件被禁用"）。独立分隔元素在换行时
 * 自己折走，语义更干净。
 */
export function renderGroupSeparator(id: string): ReactElement {
  return createElement('span', {
    key: `sep-${id}`,
    'data-anic-graph-group-sep': id,
    'aria-hidden': 'true',
    style: {
      width: 1, height: 16, margin: '0 2px',
      background: 'currentColor', opacity: 0.22,
    },
  });
}

/** 五个组的标签取用点（集中在此，避免工具栏里散落 5 处 gt 调用）。 */
export const GROUP_LABEL = {
  search: (): string => gt('groupSearch'),
  type: (): string => gt('groupType'),
  verdict: (): string => gt('groupVerdict'),
  zoom: (): string => gt('groupZoom'),
  a11y: (): string => gt('groupA11y'),
} as const;
