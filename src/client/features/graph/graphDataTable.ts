/**
 * 工作流图等价数据表（P1-3 文本替代，屏幕阅读器专用）。
 *
 * SVG 图对 AT 是一张"图"——没有它，169 个节点的关系结构只能逐节点听。
 * WCAG 1.1.1 要求复杂图形提供等价文本；本表是图的全量文本替代（每节点
 * 一行：id / 类型 / 裁决 / 标签），视觉上折叠为 1px（`.anic-sr-only`，
 * 见 panelCss.ts），AT 照常逐行朗读。
 *
 * 节点顺序与图渲染同源（data.nodes 原序）——两份投影永远一致，因为
 * 它们消费同一个 data 对象，不存在第二份排序逻辑。
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import { canonicalVerdict } from './gateColors.ts';
import { t } from '../../i18n.ts';

export interface GraphTableData {
  nodes: WorkflowNode[];
}

/** 等价数据表（视觉隐藏，`table`+`caption` 的原生语义足够，无需 ARIA 补丁）。 */
export function renderGraphDataTable(data: GraphTableData, verdicts?: Map<string, string>): ReactElement {
  const rows = data.nodes.map((n, i) => {
    const verdict = verdicts?.get(n.id) ?? n.result;
    const key = canonicalVerdict(verdict);
    return createElement(
      'tr',
      { key: `tr-${String(i)}`, 'data-anic-table-node': n.id },
      createElement('td', null, n.id),
      createElement('td', null, n.type),
      // 裁决归一后展示（PASS/FAIL/doubt/pending/skip）；无裁决节点显示 em 破折号。
      createElement('td', null, key ?? '—'),
      createElement('td', null, n.label),
    );
  });
  return createElement(
    'div',
    { className: 'anic-sr-only', 'data-anic-graph-table': 'true' },
    createElement(
      'table',
      null,
      createElement('caption', null, t('panel.graphTableCaption')),
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col' }, t('panel.colNode')),
          createElement('th', { scope: 'col' }, t('panel.colType')),
          createElement('th', { scope: 'col' }, t('panel.colVerdict')),
          createElement('th', { scope: 'col' }, t('panel.colLabel')),
        ),
      ),
      createElement('tbody', null, rows),
    ),
  );
}
