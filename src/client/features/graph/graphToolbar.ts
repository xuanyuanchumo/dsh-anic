/**
 * 图区工具栏（cycle-82 · G 战线）—— 搜索 / 类型 chips / 裁决筛选 / 缩放 / 邻接开关 / 图例。
 *
 * ## 为什么这些控件不是 `<button>`
 *
 * 全部是**取值**语义，不是**动作**语义，所以用原生控件承载：
 * - 搜索框 `<input type="search">`：有值、可清空（`type=search` 自带清除与 Esc 语义）；
 * - 类型 chips `<label><input type="checkbox">`：多选，复选框是唯一正确语义
 *   （用 `<button aria-pressed>` 表达多选会让 AT 播报成一排开关，丢失"这是一组可多选的类型"）；
 * - 裁决筛选 `<select multiple>`：5 个规范裁决 + 无裁决，且**彼此互斥感强**
 *   （用户想的是"只看 fail"，不是"fail 且 pass"），下拉比 chips 省一半横向空间；
 * - 邻接高亮 `<input type="checkbox">`：单个布尔开关。
 *
 * **缩放三键是真 `<button>`**：放大/缩小/适配视图是**动作**而非取值——用户心智是
 * "按一下放大"，`<input type=range>` 会让 AT 播报 "slider 100"，语义倒退。
 * 比例本身用 `<output>` 播报（它是结果，不是控件）。
 *
 * ## 为什么 chip 上要带计数
 *
 * 「gate-event 122」与「incident 0」对用户是两种截然不同的信号：前者值得筛，
 * 后者筛了就是白屏。没有计数时用户只能靠反复试错来发现这件事——而每次试错
 * 都是一次"图突然空了一半"的惊吓。
 *
 * ## 键盘与可访问性
 *
 * 每个控件都有 `aria-label`（chips 的 label 文本已是可见文案，故**不**重复设
 * aria-label——那会让 AT 播报两遍）。全部控件继承 panelCss 的 `:focus-visible` 焦点环。
 * 图例不进 Tab 序列（`aria-hidden` + 纯展示），因为它是说明而不是控件。
 */
import { createElement, type ReactElement } from 'react';
import type { FilterState, TypeCount } from './graphFilter.ts';
import { scalePercent, type Viewport } from './graphViewport.ts';
import { typeColorOf } from './graphNodeRender.ts';
import { t } from '../../i18n.ts';

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
}

/**
 * 类型 chip 的可见文案。
 *
 * **不写汉字/英文常量**：本仓有 i18n 契约扫描（`i18nDeadKeyContract` 与闭环体检
 * 的 i18n 族），用户面文本一律经 `t()`。类型名走 `graph.lane.<type>` 动态键族
 * （闭包扫描器认得 `t('graph.lane.' + type)` 这种拼接前缀，见 assetClosure 的
 * `dynamicKeyPrefixes`），因此新增类型不需要改这里。
 */
function laneLabel(type: string): string {
  return t('graph.lane.' + type);
}

/** 裁决 chip/option 的可见文案（同样走动态键族）。 */
function verdictLabel(verdict: string): string {
  return t('graph.verdict.' + verdict);
}

export function renderGraphToolbar(props: GraphToolbarProps): ReactElement {
  const { filter, typeCounts, verdictCounts, viewport, adjacencyOn } = props;
  const filterActive = filter.types.length > 0 || filter.verdicts.length > 0 || filter.query.trim() !== '';

  return createElement(
    'div',
    {
      'data-anic-graph-toolbar': 'true',
      role: 'group',
      'aria-label': t('graph.toolbarLabel'),
      style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px', fontSize: 11 },
    },

    // ── 搜索 ──────────────────────────────────────────────
    createElement('input', {
      key: 'search',
      type: 'search',
      'data-anic-graph-search': 'true',
      value: filter.query,
      placeholder: t('graph.searchPlaceholder'),
      'aria-label': t('graph.searchLabel'),
      onChange: (ev: { target: { value: string } }) => { props.onQuery(ev.target.value); },
      style: { fontSize: 11, padding: '2px 6px', minWidth: 140, maxWidth: 240 },
    }),

    // ── 类型 chips（带计数）──────────────────────────────
    createElement(
      'div',
      {
        key: 'types',
        'data-anic-graph-typechips': 'true',
        role: 'group',
        'aria-label': t('graph.typeGroupLabel'),
        style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
      },
      ...typeCounts.map((tc) => {
        const checked = filter.types.includes(tc.type);
        return createElement(
          'label',
          {
            key: `chip-${tc.type}`,
            'data-anic-graph-chip': tc.type,
            'data-anic-graph-chip-checked': checked ? 'true' : 'false',
            // 计数写进 DOM：chip 上的数字既是给用户看的，也是"筛选面板与图对得上"的
            // 可断言形式（测试直接读 chip 计数与节点实际计数对账）。
            'data-anic-graph-chip-count': String(tc.count),
            style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', padding: '1px 4px', border: '1px solid transparent', borderRadius: 3 },
          },
          createElement('input', {
            type: 'checkbox',
            checked,
            'data-anic-graph-chip-input': tc.type,
            onChange: () => { props.onToggleType(tc.type); },
            style: { margin: 0 },
          }),
          createElement('span', null, `${laneLabel(tc.type)} ${String(tc.count)}`),
        );
      }),
    ),

    // ── 裁决筛选 ──────────────────────────────────────────
    createElement(
      'select',
      {
        key: 'verdict',
        multiple: true,
        'data-anic-graph-verdict': 'true',
        'aria-label': t('graph.verdictLabel'),
        value: [...filter.verdicts],
        onChange: (ev: { target: { selectedOptions: ArrayLike<{ value: string }> } }) => {
          // <select multiple> 的 onChange 只给"当前选中集"，因此这里必须算出**差异**
          // 再逐项 toggle —— 直接把选中集塞进 filter 会让 chip 的受控语义分叉成两套。
          const next = Array.from(ev.target.selectedOptions, (o) => o.value);
          const prev = new Set(filter.verdicts);
          for (const v of next) if (!prev.has(v)) props.onToggleVerdict(v);
          for (const v of prev) if (!next.includes(v)) props.onToggleVerdict(v);
        },
        style: { fontSize: 11, minWidth: 96, maxHeight: 52 },
      },
      ...verdictCounts.map((vc) => createElement('option', {
        key: `verdict-${vc.type}`,
        value: vc.type,
        'data-anic-graph-verdict-option': vc.type,
        'data-anic-graph-verdict-count': String(vc.count),
      }, `${verdictLabel(vc.type)} ${String(vc.count)}`)),
    ),

    // ── 缩放：三键（动作）+ 比例读数（结果）────────────────
    createElement('button', {
      key: 'zoom-out',
      type: 'button',
      'data-anic-graph-zoom': 'out',
      'aria-label': t('graph.zoomOut'),
      title: t('graph.zoomOut'),
      onClick: props.onZoomOut,
      className: 'anic-btn',
      style: { padding: '0 6px', fontSize: 12 },
    }, '−'),
    // <output> 而非 <span>：它是"控件作用的结果"，AT 会作为 live 值播报，
    // 且天然带 for 关联语义。比例读数不进 Tab 序列（它是结果不是控件）。
    createElement('output', {
      key: 'zoom-readout',
      'data-anic-graph-zoom-readout': 'true',
      'aria-label': t('graph.zoomReadout'),
      style: { minWidth: 38, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
    }, `${String(scalePercent(viewport))}%`),
    createElement('button', {
      key: 'zoom-in',
      type: 'button',
      'data-anic-graph-zoom': 'in',
      'aria-label': t('graph.zoomIn'),
      title: t('graph.zoomIn'),
      onClick: props.onZoomIn,
      className: 'anic-btn',
      style: { padding: '0 6px', fontSize: 12 },
    }, '+'),
    createElement('button', {
      key: 'zoom-fit',
      type: 'button',
      'data-anic-graph-zoom': 'fit',
      'aria-label': t('graph.zoomFit'),
      title: t('graph.zoomFitHint'),
      onClick: props.onFit,
      className: 'anic-btn',
    }, t('graph.zoomFit')),

    // 邻接高亮开关
    createElement('label', {
      key: 'adjacency',
      'data-anic-graph-adjacency-toggle': 'true',
      style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' },
    },
    createElement('input', {
      key: 'adjacency-input',
      type: 'checkbox',
      checked: adjacencyOn,
      onChange: props.onAdjacencyToggle,
      'aria-label': t('graph.adjacencyLabel'),
    }),
    createElement('span', { key: 'adjacency-text' }, t('graph.adjacency')),),

    // ── 清空筛选（有筛选时才可用）─────────────────────────
    createElement('button', {
      key: 'clear',
      type: 'button',
      'data-anic-graph-clear': 'true',
      'aria-label': t('graph.clearFilter'),
      onClick: props.onClear,
      disabled: !filterActive,
      className: 'anic-btn',
    }, t('graph.clearFilter')),

    // ── 图例（纯展示，不进 Tab 序列）───────────────────────
    createElement(
      'span',
      {
        key: 'legend',
        'data-anic-graph-legend': 'true',
        'aria-hidden': 'true',
        style: { marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 10, opacity: 0.85 },
      },
      ...typeCounts.map((tc) => createElement(
        'span',
        { key: `legend-${tc.type}`, 'data-anic-graph-legend-item': tc.type, style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
        createElement('span', {
          'data-anic-graph-legend-dot': tc.type,
          // 真色点：用户看图例是为了把颜色映射回类型，只写类型名等于没写。
          // 颜色经 typeColorOf（与图上圆点同源），不允许图例自己维护一张表。
          style: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', background: typeColorOf(tc.type) },
        }),
        laneLabel(tc.type),
      )),
    ),
  );
}
