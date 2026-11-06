/**
 * 属性对比面板（cycle-109 · U3）——**本文件回答**："N 个选中节点的 5 条属性摆出来长什么样"。
 *
 * ## 零占位纪律
 *
 * 选中集 < 2 时**整块不渲染**（由 `useGraphInteraction` 决定传不传矩阵）。这里不做
 * "空面板 + 提示语"：一张空矩阵比没有面板更糟——它占掉图区高度却不回答任何问题。
 *
 * ## 差异必须同时有视觉与文本两条腿（WCAG 1.4.1）
 *
 * 差异**不能**只靠颜色（面板本来也没引入新颜色）。这里用两个非颜色通道：
 *   - 行上 `data-anic-graph-compare-diff="true|false"`（可断言 + 可被样式利用）；
 *   - 视觉上的 `≠` 徽标（与 `✓/✕/⏸` 同族的**符号**通道，不需要词表条目）。
 *
 * `aria-label` 也带上同一个符号：`类型: 阶段 ≠ 阶段` 与 `类型: 阶段 / 阶段` 对 AT
 * 是可区分的——否则屏幕阅读器用户听到的是"类型 阶段 阶段"，差异信息为零。
 *
 * ## 为什么是 flex 行而不是 grid + `display: contents`
 *
 * grid + `display:contents` 能让列真正对齐，但 `display:contents` 的元素在部分
 * 浏览器/AT 组合里会从可访问性树里消失——而本面板的差异信息正是挂在行的
 * `aria-label` 上的。用普通 flex 行（标签固定宽 + 取值等宽分）牺牲几个像素的
 * 对齐，换"差异一定能被 AT 听到"，这个取舍是单向的。
 *
 * ## 为什么没有「清空对比」按钮
 *
 * 清空需要一个用户面词条（"清空对比"/"退出对比"），而词表在 601 键处零余量
 * （见 `graphCompare` 头注）。退出通道仍然完整且都不需要新词条：
 * Escape（既有 `clearFilter`，一并清选中集）、再点一次已选节点（切换掉）、
 * 不按修饰键点任意节点（单选替换 ⇒ 面板消失）。
 *
 * ## 为什么"选满"必须有读数（cycle-109 收口裁决）
 *
 * 第 9 次点击被状态机**拒绝**（不挤掉最早的，免得用户不知道自己丢了谁）。但"点了
 * 没反应"与"键位坏了"在界面上无法区分——这是真实可用性问题，不是抠细节。所以选满
 * 时面板顶部给一句上限说明（`data-anic-graph-compare-limit`），把"沉默的拒绝"
 * 变成"说明了原因的拒绝"。位置在列头**下方**单独一行：塞进列头那一行 flex 里会
 * 被当成第 N+3 列，把已有列挤扁。
 */

import { createElement, type ReactElement } from 'react';
import type { CompareMatrix, CompareRow } from './graphCompare.ts';
import { MAX_SELECTION } from './graphSelection.ts';
import { t } from '../../i18n.ts';

/** 行标签列宽（px）：与列头占位同一常量，否则两次渲染会错位一像素。 */
const LABEL_W = 74;
/** 差异徽标列宽（px）。 */
const MARK_W = 12;

/** 单行（行标签 + 差异徽标 + 各列取值）。 */
function renderCompareRow(row: CompareRow, columnIds: readonly string[]): ReactElement {
  const sep = row.diff ? ' ≠ ' : ' / ';
  return createElement(
    'div',
    {
      key: `row-${row.key}`,
      'data-anic-graph-compare-row': row.key,
      'data-anic-graph-compare-diff': row.diff ? 'true' : 'false',
      // AT 与视觉用**同一个**符号通道（见文件头「差异必须两条腿」）。
      'aria-label': `${row.label}: ${row.values.join(sep)}`,
      style: { display: 'flex', alignItems: 'baseline', gap: 8 },
    },
    createElement('span', {
      key: 'label',
      'data-anic-graph-compare-row-label': row.key,
      style: { flex: `0 0 ${String(LABEL_W)}px` },
    }, row.label),
    // 差异徽标放在标签之后：读的顺序是"哪条属性 → 差 → 差在哪"。
    createElement('span', {
      key: 'diff',
      ...(row.diff ? { 'data-anic-graph-compare-diff-mark': 'true' } : {}),
      'aria-hidden': 'true',
      style: { flex: `0 0 ${String(MARK_W)}px`, fontWeight: 'bold' },
    }, row.diff ? '≠' : ''),
    ...row.values.map((value, i) => createElement('span', {
      // 列 id 做 key：列与矩阵靠 id 对齐，序号 key 会在换选时错位 patch。
      key: `cell-${columnIds[i] ?? String(i)}`,
      'data-anic-graph-compare-cell': columnIds[i] ?? String(i),
      style: { flex: '1 1 0', minWidth: 0, fontVariantNumeric: 'tabular-nums' },
    }, value)),
  );
}

/**
 * 对比面板（纯渲染：零 hook / 零状态，可被 `renderToStaticMarkup` 直接断言）。
 *
 * 列锚点 `data-anic-graph-compare-col=<id>` 是"选中集真的进了面板"的唯一证据：
 * 选中集是异步点击的结果，没有锚点就只能靠数屏幕上几列来验收。
 */
export function renderComparePanel(matrix: CompareMatrix): ReactElement {
  const columnIds = matrix.columns.map((c) => c.id);
  return createElement(
    'div',
    {
      key: 'compare',
      'data-anic-graph-compare': 'true',
      'data-anic-graph-compare-columns': String(matrix.columns.length),
      // 组名用**数据**（列标签）而不是新词条：它恰好回答了"在对比哪几个"。
      role: 'group',
      'aria-label': matrix.columns.map((c) => c.label).join(' / '),
      style: { display: 'flex', flexDirection: 'column', gap: 1, fontSize: 10.5, padding: '2px 8px' },
    },
    // 列头：占位（对齐行标签 + 徽标）后每列一个节点名。
    createElement(
      'div',
      { key: 'head', 'data-anic-graph-compare-head': 'true', style: { display: 'flex', gap: 8 } },
      createElement('span', { key: 'corner', 'aria-hidden': 'true', style: { flex: `0 0 ${String(LABEL_W)}px` } }),
      createElement('span', { key: 'corner-diff', 'aria-hidden': 'true', style: { flex: `0 0 ${String(MARK_W)}px` } }),
      ...matrix.columns.map((c) => createElement('span', {
        key: `col-${c.id}`,
        'data-anic-graph-compare-col': c.id,
        title: `${c.label} · ${c.id}`,
        style: { flex: '1 1 0', minWidth: 0, fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, c.label)),
    ),
    /*
     * 选满读数（见文件头末段）：`columns.length >= MAX_SELECTION` 即"再点不会加入"。
     * 判据同源于状态机的上限常量（`MAX_SELECTION`）——两处各写一个 8 会漂移。
     */
    matrix.columns.length < MAX_SELECTION
      ? null
      : createElement('span', {
          key: 'limit',
          'data-anic-graph-compare-limit': String(MAX_SELECTION),
        }, t('graph.compareLimit', { max: String(MAX_SELECTION) })),
    ...matrix.rows.map((row) => renderCompareRow(row, columnIds)),
  );
}