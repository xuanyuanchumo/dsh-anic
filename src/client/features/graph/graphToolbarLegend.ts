/**
 * 工具栏图例（cycle-83 · V 战线，从 graphToolbarRender.ts 拆出）。
 *
 * ## 为什么图例必须是"真色点"
 *
 * 用户看图例是为了把颜色映射回类型。只写类型名的图例等于没写——而这类缺陷
 * **任何行为测试都不会红**（图例元素存在、文案齐全、计数正确）。所以图例的色点
 * 必须与图上卡片色条**同源**（都走 `typeColorOf`）：各自维护一张表必然漂移，
 * 图例就成了骗人的东西。
 *
 * ## 为什么图例不进 Tab 序列
 *
 * 它是说明而不是控件：`aria-hidden` + 纯展示。AT 用户已经能通过等价数据表
 * 拿到全量节点，图例对他们没有增量信息，进 Tab 序列只会多一个空停靠点。
 */
import { createElement, type ReactElement } from 'react';
import type { TypeCount } from './graphFilter.ts';
import { typeColorOf } from './graphNodeRender.ts';
import { t } from '../../i18n.ts';

/** 类型 chip / 图例的可见文案（动态键族 `graph.lane.<type>`）。 */
function laneLabel(type: string): string {
  return t('graph.lane.' + type);
}

/** 渲染图例（纯展示，`data-anic-graph-legend-dot` 是色点断言锚点）。 */
export function renderLegend(typeCounts: TypeCount[]): ReactElement {
  return createElement(
    'span',
    {
      key: 'legend',
      'data-anic-graph-legend': 'true',
      'aria-hidden': 'true',
      style: {
        marginLeft: 'auto', display: 'inline-flex', gap: 8,
        alignItems: 'center', fontSize: 10, opacity: 0.85,
      },
    },
    ...typeCounts.map((tc) => createElement(
      'span',
      {
        key: `legend-${tc.type}`,
        'data-anic-graph-legend-item': tc.type,
        style: { display: 'inline-flex', alignItems: 'center', gap: 2 },
      },
      createElement('span', {
        'data-anic-graph-legend-dot': tc.type,
        // 真色点：与图上卡片色条同源，不允许图例自建一张表。
        style: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', background: typeColorOf(tc.type) },
      }),
      laneLabel(tc.type),
    )),
  );
}
