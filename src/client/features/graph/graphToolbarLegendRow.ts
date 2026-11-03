/**
 * 工具栏的**图例行**（cycle-95 · WS-C）—— 三个通道的图例按"由粗到细"排一行。
 *
 * ## 为什么把三张图例收进一个文件
 *
 * `graphToolbarRender.ts` 在 cycle-95 已 264 行（250 是
 * `objectiveConformanceContract ⑪` 的机械硬限）。图例行本身是**装配**
 * （三次调用 + 三条设计说明），与"工具栏有哪些控件组"无关 —— 按职责拆开：
 * 本文件回答「读者怎么解码这张图」，renders 文件回答「工具栏分成哪几组」。
 *
 * ## 三个通道的顺序有理由，不是随手排
 *
 * 读者的解码顺序由粗到细：
 *   1. **类型色点**（这是哪种节点）—— 最先被注意到的视觉通道；
 *   2. **边线型**（这条边是什么语义）—— 看完点就该看线；
 *   3. **角色形状**（这个点在拓扑里什么位置）—— 形状最细，最后读。
 *
 * 顺序若反过来（形状在前），用户会先被四个小方块拦住，而它们回答的是
 * "看完类型之后才想问"的问题。
 *
 * ## 三张图例共同的纪律（各文件头注已写，此处集中交代一次）
 *
 * - `aria-hidden`：图例是说明而非控件，不进 Tab 序列；
 * - **零新增画布**：`svg === 1` / `circle 数 == 节点数` 是 smoke 与
 *   visualUpgradeContract 钉死的不变量，三张图例都走纯 CSS；
 * - **与数据同源**：色点取 `typeColorOf`、线型取 `EDGE_STYLES`、形状取
 *   `ROLE_TRAITS` —— 图例自建第二张表必然漂移，而漂移后的图例是骗人的。
 */
import { createElement, type ReactElement } from 'react';
import type { TypeCount } from './graphFilter.ts';
import { renderLegend } from './graphToolbarLegend.ts';
import { renderEdgeLegend } from './graphEdgeLegend.ts';
import { renderRoleLegend } from './graphToolbarRoleLegend.ts';

/** 角色计数（图例上的读数；缺省不显示数字）。 */
export interface RoleLegendStats {
  entry: number;
  orphan: number;
  leaf: number;
  hub: number;
}

/**
 * 图例行（一整行，含三个通道）。
 *
 * @param typeCounts 节点类型计数（节点图例用）
 * @param roles 角色计数（缺省 = 不渲染角色图例）
 * @param activeRoles 已选中的角色筛选（cycle-100；缺省 = 图例退化为纯展示）
 * @param onToggleRole 角色筛选切换回调（缺省 = 图例退化为纯展示 + aria-hidden）
 */
export function renderLegendRow(
  typeCounts: TypeCount[],
  roles?: RoleLegendStats,
  activeRoles?: readonly string[],
  onToggleRole?: (role: 'entry' | 'hub' | 'leaf' | 'orphan') => void,
): ReactElement {
  return createElement(
    'div',
    {
      key: 'legend-row',
      'data-anic-graph-legend-row': 'true',
      style: {
        display: 'inline-flex', flexWrap: 'wrap', gap: 10,
        alignItems: 'center', marginLeft: 'auto',
      },
    },
    renderLegend(typeCounts),
    renderEdgeLegend(),
    roles === undefined ? null : renderRoleLegend(roles, activeRoles, onToggleRole),
  );
}
