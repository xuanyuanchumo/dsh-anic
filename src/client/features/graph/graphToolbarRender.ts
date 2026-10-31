/**
 * 工具栏渲染体（cycle-83 · V 战线，从 graphToolbar.ts 拆出以满足 250 行纪律）。
 *
 * 设计与语义裁决写在 `graphToolbar.ts` 头注（本文件只负责把它们装配出来）。
 * 视觉分组外壳在 `graphToolbarGroups.ts`。
 *
 * ## cycle-83 的三处视觉升级
 *
 * 1. **分组**：搜索 / 类型 / 裁决 / 缩放 / 辅助 五组，组间独立分隔元素 + 组标签
 *    （视觉隐藏给 AT）。理由见 graphToolbarGroups 头注。
 * 2. **chips 药丸化**：圆角 9px + 选中态填充 + 计数徽章（数字单独一个胶囊）。
 *    选中态用 `anic-surface-active`（已校准的交互面）而不是新造一个"选中色"——
 *    造新色等于绕开整张对比度表。
 * 3. **计数徽章**：数字从标签文本里拆出来单独成元素（`data-anic-graph-chip-count`
 *    已存在，值是纯数字；现在它同时是**可见**徽章，不再只是一个 DOM 属性）。
 */
import { createElement, type ReactElement } from 'react';
import type { FilterState, TypeCount } from './graphFilter.ts';
import type { Viewport } from './graphViewport.ts';
import { typeColorOf } from './graphNodeRender.ts';
import { GROUP_LABEL, renderGroupSeparator, renderToolbarGroup } from './graphToolbarGroups.ts';
import { renderLegend } from './graphToolbarLegend.ts';
import { renderEdgeLegend } from './graphEdgeLegend.ts';
import { renderSearchChildren } from './graphToolbarSearch.ts';
import { renderAuxGroup, renderZoomGroup } from './graphToolbarActions.ts';
import { renderViewGroup, type ViewGroupInput } from './graphToolbarView.ts';
import { t } from '../../i18n.ts';

interface RenderProps {
  filter: FilterState;
  typeCounts: TypeCount[];
  verdictCounts: TypeCount[];
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
  /**
   * 搜索命中前 N 条 / 总数 / 跳转（cycle-84）。
   * **可选且缺省安全**：既有契约测试直接调本函数时只传旧字段，
   * 缺省 [] / 0 / 空操作 —— 与"零参调用仍可用"的既有纪律一致。
   */
  searchMatches?: { id: string; label: string }[];
  searchTotal?: number;
  onJump?: (id: string) => void;
  activeMatchIndex?: number;
  onMoveMatch?: (delta: number) => void;
  onJumpActive?: () => void;
  /**
   * 视图组（cycle-90）：布局模式 / 仅看异常 / 缩放到选中 / 导出 / 全屏。
   *
   * **整组可选**：既有契约测试（`graphInteractiveContract` ②）直接调本函数时
   * 只传旧字段，缺省时**不渲染这一组** —— 零参调用仍是"改造前的工具栏"。
   * 这样老断言（"每组控件齐全"）不会因为新控件而误判，测试也能按需断言新控件。
   */
  view?: ViewGroupInput;
}

/** chip 的可见文案（类型名，动态键族 `graph.lane.<type>`）。 */
function laneLabel(type: string): string {
  return t('graph.lane.' + type);
}

/** 裁决 option 的可见文案（动态键族 `graph.verdict.<verdict>`）。 */
function verdictLabel(verdict: string): string {
  return t('graph.verdict.' + verdict);
}

/** 计数徽章：数字单独成胶囊（视觉上把"类型名"与"多少个"分开读）。 */
function countBadge(count: number, key: string): ReactElement {
  return createElement('span', {
    key,
    'data-anic-graph-chip-badge': String(count),
    style: {
      fontSize: 9, padding: '0 4px', borderRadius: 7,
      background: 'currentColor', color: 'inherit', opacity: 0.14,
      fontVariantNumeric: 'tabular-nums',
    },
  }, String(count));
}

export function renderGraphToolbar(props: RenderProps): ReactElement {
  const { filter, typeCounts, verdictCounts, viewport, adjacencyOn } = props;
  const filterActive = filter.types.length > 0 || filter.verdicts.length > 0 || filter.query.trim() !== '';

  // 搜索组的子元素（输入 + 计数 + 命中胶囊）由 graphToolbarSearch 负责，
  // 本文件只把组壳套上——拆分的界线是职责（见该文件头注）。
  const searchChildren = renderSearchChildren({
    query: filter.query,
    searchMatches: props.searchMatches ?? [],
    searchTotal: props.searchTotal ?? 0,
    onQuery: props.onQuery,
    onJump: (id) => { props.onJump?.(id); },
    activeIndex: props.activeMatchIndex ?? 0,
    onMoveActive: (delta) => { props.onMoveMatch?.(delta); },
    onJumpActive: () => {
      if (props.onJumpActive !== undefined) props.onJumpActive();
      else {
        const first = (props.searchMatches ?? [])[0];
        if (first !== undefined) props.onJump?.(first.id);
      }
    },
  });

  return createElement(
    'div',
    {
      'data-anic-graph-toolbar': 'true',
      role: 'toolbar',
      'aria-label': t('graph.toolbarLabel'),
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
        padding: '6px 8px', fontSize: 11,
      },
    },

    // ── 组 1：搜索 + 命中跳转（cycle-84）────────────────────
    // 输入框回车 = 跳到第一条命中（最常用的"我知道它大致叫什么"场景），
    // 命中胶囊 = 中途结果可精确选择。两者都要：只给回车则重名时反复试错，
    // 只给胶囊则键入后还得抬手点鼠标。
    renderToolbarGroup({
      id: 'search',
      label: GROUP_LABEL.search,
      children: searchChildren,
    }),
    renderGroupSeparator('after-search'),

    // ── 组 2：类型 chips（药丸 + 计数徽章）──────────────────
    renderToolbarGroup({
      id: 'type',
      label: GROUP_LABEL.type,
      children: typeCounts.map((tc) => {
        const checked = filter.types.includes(tc.type);
        return createElement(
          'label',
          {
            key: `chip-${tc.type}`,
            'data-anic-graph-chip': tc.type,
            'data-anic-graph-chip-checked': checked ? 'true' : 'false',
            // 计数写进 DOM：既是给用户看的徽章，也是"筛选面板与图对得上"的可断言形式。
            'data-anic-graph-chip-count': String(tc.count),
            // 药丸形态：圆角 9px + 选中态填充（用已校准的交互面令牌，不造新色）。
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer',
              padding: '1px 6px 1px 4px', borderRadius: 9, fontSize: 10.5,
              border: '1px solid transparent',
              background: checked ? 'currentColor' : undefined,
              opacity: checked ? 1 : 0.86,
            },
          },
          createElement('input', {
            type: 'checkbox',
            checked,
            'data-anic-graph-chip-input': tc.type,
            onChange: () => { props.onToggleType(tc.type); },
            style: { margin: 0, width: 11, height: 11 },
          }),
          // 真色点：chips 上同时带类型色，让"这个 chip 对应图上哪种卡片"无需回看图例。
          createElement('span', {
            key: 'chip-dot',
            'data-anic-graph-chip-dot': tc.type,
            style: {
              width: 6, height: 6, borderRadius: '50%',
              display: 'inline-block', background: typeColorOf(tc.type),
            },
          }),
          createElement('span', { key: 'chip-label' }, laneLabel(tc.type)),
          countBadge(tc.count, 'chip-count'),
        );
      }),
    }),
    renderGroupSeparator('after-type'),

    // ── 组 3：裁决筛选 ──────────────────────────────────────
    renderToolbarGroup({
      id: 'verdict',
      label: GROUP_LABEL.verdict,
      children: [createElement(
        'select',
        {
          key: 'verdict',
          multiple: true,
          'data-anic-graph-verdict': 'true',
          'aria-label': t('graph.verdictLabel'),
          value: [...filter.verdicts],
          onChange: (ev: { target: { selectedOptions: ArrayLike<{ value: string }> } }) => {
            // <select multiple> 的 onChange 只给"当前选中集"，因此必须算出**差异**
            // 再逐项 toggle —— 直接把选中集塞进 filter 会让 chip 的受控语义分叉成两套。
            const next = Array.from(ev.target.selectedOptions, (o) => o.value);
            const prev = new Set(filter.verdicts);
            for (const v of next) if (!prev.has(v)) props.onToggleVerdict(v);
            for (const v of prev) if (!next.includes(v)) props.onToggleVerdict(v);
          },
          style: { fontSize: 11, minWidth: 92, maxHeight: 52, borderRadius: 6 },
        },
        ...verdictCounts.map((vc) => createElement('option', {
          key: `verdict-${vc.type}`,
          value: vc.type,
          'data-anic-graph-verdict-option': vc.type,
          'data-anic-graph-verdict-count': String(vc.count),
        }, `${verdictLabel(vc.type)} ${String(vc.count)}`)),
      )],
    }),
    renderGroupSeparator('after-verdict'),

    // ── 组 4/5：缩放与辅助（动作语义，拆到 graphToolbarActions）──
    renderZoomGroup(viewport, {
      onZoomIn: props.onZoomIn, onZoomOut: props.onZoomOut, onFit: props.onFit,
    }),
    renderGroupSeparator('after-zoom'),
    renderAuxGroup({
      adjacencyOn, filterActive, onAdjacencyToggle: props.onAdjacencyToggle, onClear: props.onClear,
    }),

    // ── 组 6：视图（布局模式 / 仅看异常 / 缩放到选中 / 导出 / 全屏）──
    // 缺省**不渲染**（见 RenderProps.view 的注释：零参调用 = 改造前工具栏）。
    props.view === undefined ? null : renderGroupSeparator('before-view'),
    props.view === undefined ? null : renderViewGroup(props.view),

    renderLegend(typeCounts),
    /*
     * cycle-94（WS-C 缺口三）：**边语义图例**。
     *
     * 此前 `renderEdgeLegend` 只有 import、零调用点 —— 组件写好了却没挂上，
     * 于是「6 种边线型不同，但图例只有节点类型」这个研究结论修了一半就停了。
     * 挂在节点图例之后（同一视觉行尾）：读者先认卡片类型，再认线型语义。
     */
    renderEdgeLegend(),
  );
}

/** 渲染上下文（供测试构造最小 props 时复用类型）。 */
export type RenderToolbarContext = RenderProps;
