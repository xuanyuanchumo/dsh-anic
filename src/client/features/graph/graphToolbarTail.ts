/**
 * 工具栏**后半段**装配（cycle-96 · 从 `graphToolbarRender.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `graphToolbarRender.ts` 回答的是「工具栏分成哪几组」（组 1 搜索 / 组 2 类型 /
 * 组 3 裁决），那是**结构**。组 4..7 是「动作 + 条件组」（缩放 / 辅助 / 视图 / 路径）
 * 加图例行，那是**装配**。两件事混在一起的代价：加一个条件组就要动结构文件，
 * 而结构文件已经贴着 250 行硬限 —— 于是每次新增都先删注释（本仓反对的做法）。
 *
 * ## 条件组缺省不渲染的理由（保留在这里，因为这是装配决策）
 *
 * `view` / `path` 缺省 `undefined` ⇒ **不渲染**。这是「零参调用 = 改造前工具栏」这条
 * 既有纪律的落点（`RenderProps.view` 的注释也写了）。若改成"缺省渲染"，所有既有
 * 契约测试的工具栏按钮数会集体变化，而那并不是本轮要改的语义。
 *
 * ## 图例行的顺序有理由（见 `graphToolbarLegendRow.ts` 头注）
 *
 * 类型色点 → 边线型 → 角色形状，由粗到细。这里只负责**放进去**，排序理由在彼处。
 */
import { createElement, type ReactElement } from 'react';
import type { TypeCount } from './graphFilter.ts';
import type { Viewport } from './graphViewport.ts';
import { renderGroupSeparator } from './graphToolbarGroups.ts';
import { renderZoomGroup, renderAuxGroup } from './graphToolbarActions.ts';
import { renderViewGroup } from './graphToolbarView.ts';
import { renderPathGroup } from './graphToolbarPath.ts';
import { renderLegendRow, type RoleLegendStats } from './graphToolbarLegendRow.ts';
import { token } from '../../../shared/tokens.ts';

/** 后半段装配的入参（全部显式 —— 本函数纯渲染，不读全局态）。 */
export interface ToolbarTailInput {
  viewport: Viewport;
  adjacencyOn: boolean;
  filterActive: boolean;
  typeCounts: TypeCount[];
  roles?: RoleLegendStats | undefined;
  /** 已选中的角色筛选（cycle-100；缺省 = 角色图例退化为纯展示）。 */
  activeRoles?: readonly string[] | undefined;
  /** 角色筛选切换（缺省 = 角色图例退化为纯展示 + aria-hidden）。 */
  onToggleRole?: ((role: 'entry' | 'hub' | 'leaf' | 'orphan') => void) | undefined;
  view?: unknown;
  path?: unknown;
  /**
   * 布局质量读数（cycle-101）：交叉数 + 折叠的重复 id 数量。
   * 缺省 `undefined` ⇒ 不渲染（零参调用 = 改造前工具栏，与 view/path 同纪律）。
   */
  layoutQuality?: { crossings: number; droppedDuplicates: number } | undefined;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onAdjacencyToggle: () => void;
  onClear: () => void;
}

/**
 * 产出组 4..7 + 图例行的元素数组（可由调用方展开进 children）。
 *
 * 返回数组而不是单个元素：这样调用方仍能按组间插入分隔符与其它条目，
 * 而不必把整条序列的所有权交给本文件（保持组合自由度）。
 */
export function renderToolbarTail(input: ToolbarTailInput): Array<ReactElement | null> {
  return [
    // ── 组 4/5：缩放与辅助（动作语义，实现见 graphToolbarActions）──
    renderZoomGroup(input.viewport, {
      onZoomIn: input.onZoomIn, onZoomOut: input.onZoomOut, onFit: input.onFit,
    }),
    renderGroupSeparator('after-zoom'),
    renderAuxGroup({
      adjacencyOn: input.adjacencyOn,
      filterActive: input.filterActive,
      onAdjacencyToggle: input.onAdjacencyToggle,
      onClear: input.onClear,
    }),

    // ── 组 6：视图（布局模式 / 仅看异常 / 缩放到选中 / 导出 / 全屏）──
    // 缺省**不渲染**（零参调用 = 改造前工具栏，见文件头）。
    input.view === undefined ? null : renderGroupSeparator('before-view'),
    input.view === undefined ? null : renderViewGroup(input.view as never),

    // ── 组 7：路径（"这两点怎么连"的模式开关；缺省不渲染）──
    input.path === undefined ? null : renderGroupSeparator('before-path'),
    input.path === undefined ? null : renderPathGroup(input.path as never),

    // 图例行：由粗到细三通道（排序理由见 graphToolbarLegendRow.ts）。
    // 角色图例缺省不渲染：它要真实角色计数，纯渲染的零参调用没有这份数据。
    // cycle-100：带 onToggleRole 时升级为可点选的角色筛选（同一 DOM 锚点）。
    renderLegendRow(input.typeCounts, input.roles, input.activeRoles, input.onToggleRole),

    // ── 布局质量读数（cycle-101）：交叉数 + 折叠重复 id ──
    renderLayoutQuality(input.layoutQuality),
  ];
}

/**
 * 布局质量读数徽章（cycle-101 · 白盒化的"静默丢弃"与"布局好坏"）。
 *
 * ## 为什么需要它
 *
 * 1. **交叉数**：`GraphLayout.crossings` 早就算出来了（cycle-94，同一把尺量三种
 *    模式），但**没有任何 UI 显示它** —— 读者无法判断"切到 flow 模式后到底好没好",
 *    只能凭肉眼。没有数字，"flow 更好读"就是一句无法验证的话。
 * 2. **折叠的重复 id**：旧实现重复 id「首个胜出并静默 continue」（位置唯一性是
 *    硬不变量，不能改），数据管道出问题时用户只看到"节点少了几个"。现在显式读出来。
 *
 * ## 渲染纪律
 *
 * - 缺省 `undefined` ⇒ **不渲染**（零参调用 = 改造前工具栏）；
 * - `crossings === 0 && droppedDuplicates === 0` ⇒ 也**不渲染**（健康态不占位，
 *   不制造"总有东西要看"的噪声 —— 与读数条 dropped>0 才显示同一条纪律）；
 * - 折叠数用告警色（它是异常），交叉数用弱色（它是常态读数）。
 */
function renderLayoutQuality(
  q: { crossings: number; droppedDuplicates: number } | undefined,
): ReactElement | null {
  if (!q) return null;
  const zeroCross = q.crossings <= 0;
  const zeroDrop = q.droppedDuplicates <= 0;
  if (zeroCross && zeroDrop) return null;
  const parts: ReactElement[] = [];
  if (!zeroCross) {
    parts.push(createElement('span', {
      key: 'cross',
      'data-anic-graph-crossings': String(q.crossings),
      title: `交叉数 ${q.crossings}（同一把尺量三种布局模式，越小越好读）`,
      style: { fontSize: 10, color: token('anic-text-faint') },
    }, `交叉 ${q.crossings}`));
  }
  if (!zeroDrop) {
    parts.push(createElement('span', {
      key: 'drop',
      'data-anic-graph-dropped-ids': String(q.droppedDuplicates),
      title: `已折叠 ${q.droppedDuplicates} 个重复 id（位置唯一性硬不变量：同 id 只画一次，其余丢弃）`,
      style: { fontSize: 10, color: token('anic-warn-text') },
    }, `折叠 ${q.droppedDuplicates}`));
  }
  return createElement('span', {
    'data-anic-graph-layout-quality': '1',
    style: { display: 'inline-flex', gap: 8, alignItems: 'center', marginLeft: 4 },
  }, ...parts);
}
