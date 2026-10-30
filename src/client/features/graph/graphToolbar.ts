/**
 * 图区工具栏（cycle-82 建立 · cycle-83 视觉分组，渲染体拆到 graphToolbarRender.ts）。
 *
 * 本文件只剩**类型曲面**：props 契约 + 导出转口。渲染实现见 `graphToolbarRender.ts`，
 * 分组外壳见 `graphToolbarGroups.ts`。拆分的界线是职责，不是行数：cycle-82 的
 * 244 行里，"控件语义为什么这样选"的长注释与"十个控件的装配"各占一半，混在一个
 * 文件里加任何一点东西都要先删注释（250 行纪律是 `truthAuditChecks` 的机械项）。
 *
 * ## 为什么这些控件不是 `<button>`（设计裁决，随实现一起保留）
 *
 * 全部是**取值**语义，不是**动作**语义，所以用原生控件承载：
 * - 搜索框 `<input type="search">`：有值、可清空（`type=search` 自带清除与 Esc 语义）；
 * - 类型 chips `<label><input type="checkbox">`：多选，复选框是唯一正确语义
 *   （`<button aria-pressed>` 表达多选会让 AT 播报成一排开关）；
 * - 裁决筛选 `<select multiple>`：5 个规范裁决 + 无裁决，且彼此互斥感强
 *   （用户想的是"只看 fail"，不是"fail 且 pass"），下拉比 chips 省一半横向空间；
 * - 邻接高亮 `<input type="checkbox">`：单个布尔开关。
 *
 * **缩放三键是真 `<button>`**：放大/缩小/适配是**动作**——用户心智是"按一下放大"，
 * `<input type=range>` 会让 AT 播报 "slider 100"，语义倒退。比例本身用 `<output>`
 * 播报（它是结果，不是控件）。
 *
 * ## 为什么 chip 上要带计数
 *
 * 「gate-event 122」与「incident 0」对用户是两种截然不同的信号：前者值得筛，
 * 后者筛了就是白屏。没有计数时用户只能靠反复试错发现这件事——而每次试错都是
 * 一次"图突然空了一半"的惊吓。
 */
import type { ReactElement } from 'react';
import type { FilterState, TypeCount } from './graphFilter.ts';
import type { Viewport } from './graphViewport.ts';

export interface GraphToolbarProps {
  filter: FilterState;
  typeCounts: TypeCount[];
  verdictCounts: TypeCount[];
  viewport: Viewport;
  /** 邻接高亮开关（悬停/聚焦时是否让非邻居降透明）。 */
  adjacencyOn: boolean;
  onQuery: (q: string) => void;
  onToggleType: (type: string) => void;
  onToggleVerdict: (verdict: string) => void;
  onAdjacencyToggle: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onClear: () => void;
  /** 搜索命中的前 N 条（cycle-84 跳转选择器；缺省 = 无命中列表）。 */
  searchMatches?: { id: string; label: string }[];
  /** 命中总数（可能大于 searchMatches.length）。 */
  searchTotal?: number;
  /** 跳转并把视口居中（cycle-84）。 */
  onJump?: (id: string) => void;
  /** 命中列表当前游标（cycle-85；缺省 0）。 */
  activeMatchIndex?: number;
  /** 移动游标（缺省空操作）。 */
  onMoveMatch?: (delta: number) => void;
  /** 跳到游标所指命中（缺省等价于跳第一个）。 */
  onJumpActive?: () => void;
}

/**
 * 渲染入口（转出口）。
 *
 * 保留从 `graphToolbar.ts` 直接 import 的形状：`GraphInteractive` 与
 * `graphInteractiveContract` ② 都从这里取 `renderGraphToolbar`，拆文件不该
 * 让调用面改 import（本仓 `tokens.ts` 转出 `shellTheme` 用的是同一形状）。
 */
export { renderGraphToolbar } from './graphToolbarRender.ts';
export type { RenderToolbarContext } from './graphToolbarRender.ts';

/** 类型 chip / 图例的文案取用点（动态键族；闭包扫描器认得拼接前缀）。 */
export function laneLabelOf(lane: (type: string) => string, type: string): string {
  return lane(type);
}

/** 供渲染层用的返回值形状别名（避免下游重复写 ReactElement 泛型）。 */
export type ToolbarElement = ReactElement;
