/**
 * **边语义图例**（cycle-91）—— 让 6 种边类型的线型可被解码。
 *
 * ## 为什么需要这个（实测缺口）
 *
 * `EDGE_STYLES` 定义了 **6 种**边类型，每种的**线型都不同**
 * （实线 / `3 2` 虚线 / `0.5 2.4` 点线 / `6 3` 长划 / `2 2` 短划），
 * 但工具栏图例**只有节点类型，没有边类型**。
 *
 * ⇒ 读者看得见"这条线不一样"，但**完全不知道"不一样意味着什么"**。
 * 边语义只能靠猜 —— 而边正是工作流图的**主叙事**（谁支撑谁、谁通向谁）。
 *
 * ## 三条纪律
 *
 * 1. **图例的线型必须与 `EDGE_STYLES` 同源** —— 图例自建一张表必然漂移，
 *    漂移后的图例是**骗人的东西**（与节点色点同款纪律，见
 *    `graphToolbarLegend.ts` 头注）。
 * 2. **用 `<line>` 而不是 `<circle>`** —— smoke 钉死「circle 数 == 节点数」，
 *    图例的圆点会破坏它。
 * 3. **不进 Tab 序列**（`aria-hidden`）：图例是说明而非控件；AT 用户能从
 *    等价数据表拿到全量边信息。
 *
 * ## 边界
 *
 * 纯渲染（无状态、无 IO）。
 */
import { createElement, type ReactElement } from 'react';
import { EDGE_STYLES, edgeStyleOf } from './graphEdgeRender.ts';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** 边类型的中文名（动态键族 `graph.edge.<type>`）。 */
function edgeLabel(type: string): string {
  return t('graph.edge.' + type);
}

/** 全部已登记的边类型（按登记顺序，确定性）。 */
export function edgeTypes(): string[] {
  return Object.keys(EDGE_STYLES);
}

/**
 * 渲染边语义图例。
 *
 * @param types 只画这些类型（缺省 = 全部已登记类型）
 */
export function renderEdgeLegend(types?: readonly string[]): ReactElement {
  const list = types ?? edgeTypes();
  return createElement(
    'span',
    {
      key: 'edge-legend',
      'data-anic-graph-edge-legend': 'true',
      'aria-hidden': 'true',
      style: {
        display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 10, opacity: 0.85,
      },
    },
    ...list.map((type) => {
      const style = edgeStyleOf(type);
      return createElement(
        'span',
        {
          key: `edge-legend-${type}`,
          'data-anic-graph-edge-legend-item': type,
          style: { display: 'inline-flex', alignItems: 'center', gap: 3 },
        },
        // 真实线型示意：dash 与宽度直接取自 EDGE_STYLES（同源，不另建表）。
        createElement('svg', {
          'data-anic-graph-edge-legend-mark': type,
          width: 16, height: 6, viewBox: '0 0 16 6',
          style: { overflow: 'visible' },
        }, createElement('line', {
          x1: 0, y1: 3, x2: 16, y2: 3,
          stroke: token(style.stroke),
          strokeWidth: style.width,
          // ⚠️ dash 直接来自 EDGE_STYLES：图例画的是**图上真实线型**。
          strokeDasharray: style.dash,
        })),
        edgeLabel(type),
      );
    }),
  );
}
