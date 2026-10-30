/**
 * 工具栏「缩放」与「辅助」两组（cycle-85 从 graphToolbarRender 拆出）。
 *
 * 拆的是职责，不是行数：这两组是**动作**语义（缩放/开关/清空），与前三组
 * "取值"语义（搜索/类型屏蔽/裁决筛选）读法不同——放在一起时那段"为什么这些
 * 控件不是 button"的裁决注释会同时管两种语义，加任何控件都要先拆注释。
 *
 * 视觉分组外壳与语义裁决仍复用 `graphToolbarGroups`（不复制第二份实现）。
 */
import { createElement, type ReactElement } from 'react';
import { scalePercent, type Viewport } from './graphViewport.ts';
import { GROUP_LABEL, renderToolbarGroup } from './graphToolbarGroups.ts';
import { t } from '../../i18n.ts';

/** 缩放组：三个真 `<button>` + 一个 `<output>` 读数。 */
export function renderZoomGroup(viewport: Viewport, handlers: {
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
}): ReactElement {
  return renderToolbarGroup({
    id: 'zoom',
    label: GROUP_LABEL.zoom,
    children: [
      createElement('button', {
        key: 'zoom-out', type: 'button', 'data-anic-graph-zoom': 'out',
        'aria-label': t('graph.zoomOut'), title: t('graph.zoomOut'),
        onClick: handlers.onZoomOut, className: 'anic-btn',
        style: { padding: '0 6px', fontSize: 12 },
      }, '−'),
      // <output> 而非 <span>：它是"控件作用的结果"，AT 会作为 live 值播报。
      createElement('output', {
        key: 'zoom-readout', 'data-anic-graph-zoom-readout': 'true',
        'aria-label': t('graph.zoomReadout'),
        style: { minWidth: 38, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
      }, `${String(scalePercent(viewport))}%`),
      createElement('button', {
        key: 'zoom-in', type: 'button', 'data-anic-graph-zoom': 'in',
        'aria-label': t('graph.zoomIn'), title: t('graph.zoomIn'),
        onClick: handlers.onZoomIn, className: 'anic-btn',
        style: { padding: '0 6px', fontSize: 12 },
      }, '+'),
      createElement('button', {
        key: 'zoom-fit', type: 'button', 'data-anic-graph-zoom': 'fit',
        'aria-label': t('graph.zoomFit'), title: t('graph.zoomFitHint'),
        onClick: handlers.onFit, className: 'anic-btn',
      }, t('graph.zoomFit')),
    ],
  });
}

/** 辅助组：邻接高亮开关（label 包 checkbox）+ 清空筛选。 */
export function renderAuxGroup(input: {
  adjacencyOn: boolean;
  filterActive: boolean;
  onAdjacencyToggle: () => void;
  onClear: () => void;
}): ReactElement {
  return renderToolbarGroup({
    id: 'a11y',
    label: GROUP_LABEL.a11y,
    children: [
      createElement('label', {
        key: 'adjacency',
        'data-anic-graph-adjacency-toggle': 'true',
        style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' },
      },
      createElement('input', {
        key: 'adjacency-input', type: 'checkbox', checked: input.adjacencyOn,
        onChange: input.onAdjacencyToggle, 'aria-label': t('graph.adjacencyLabel'),
      }),
      createElement('span', { key: 'adjacency-text' }, t('graph.adjacency'))),
      createElement('button', {
        key: 'clear', type: 'button', 'data-anic-graph-clear': 'true',
        'aria-label': t('graph.clearFilter'), onClick: input.onClear,
        disabled: !input.filterActive, className: 'anic-btn',
      }, t('graph.clearFilter')),
    ],
  });
}
