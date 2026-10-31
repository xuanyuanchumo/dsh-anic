/**
 * 卡片的**几何与标记元素**（cycle-95 · 从 `graphNodeCard.ts` 拆出）。
 *
 * ## 为什么拆（职责边界，不是为凑行数）
 *
 * `graphNodeCard.ts` 拆前 233 行（离 T3 ≤250 只剩 17 行）。cycle-95 要加两条
 * 新视觉通道（节点角色、追溯深度），内联必越线。边界沿**元素构成**切：
 *   - 本文件：卡片体 / 色条 / 状态圆点 / 裁决字形 / 角色标记 / 健康条 ——
 *     "这一组元素各自长什么样、用了哪些通道"；
 *   - `graphNodeCard.ts`：一个节点 `<g>` 的**属性**（交互、a11y、data-* 锚点）
 *     与元素**装配顺序**。
 *
 * ## 三条计数不变量（任何新元素必须先核对这一节）
 *
 * `scripts/offline-smoke.mjs` 与契约钉死：
 *   ① SVG `<circle>` 数 == 节点数（"一个节点恰好一个裁决点"）；
 *   ② 每节点 2 个 `<rect>`（卡片 + 色条），外加 1 个画布背景 rect；
 *   ③ FAIL 红圈 = `strokeWidth === 2` 的 circle（数据驱动断言）。
 *
 * ⇒ 新通道只能用**改既有元素的属性**或 `<path>`。角色标记走 `<path>`、
 * 追溯深度走卡片 `strokeDasharray`/`strokeOpacity`（都不新增 rect/circle）。
 *
 * ## 通道分工（角色 vs 裁决不许互相吞）
 *
 *   - 裁决：圆点 `strokeDasharray` + 字形 `<text>`（既有语义，**不许抢**）；
 *   - 角色：圆点 `strokeWidth` 档位 + 独立 `<path>` 标记；
 *   - 深度：卡片 `strokeDasharray` / `strokeOpacity` / `strokeWidth`。
 *
 * 同一个圆点上角色与裁决共存，若都吃 dasharray，用户就再也分不出 PASS/FAIL
 * （`chevron`/`cross` 塌缩过的那一族缺陷）。契约 `graphNodeRoleContract` ⑤
 * 断言角色特征元组与裁决特征元组**不相交**。
 *
 * ## 纯渲染（零 hook / 零状态）
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import type { NodeRole } from './graphNodeRole.ts';
import { renderRoleMark, roleStrokeWidthOf } from './graphNodeRoleRender.ts';
import type { TraceDepthStyle } from './graphTraceDepth.ts';
import {
  BAR_INSET, BAR_W, CARD_FILL, CARD_RADIUS, CARD_STROKE, DOT_DY, DOT_R, DOT_X,
} from './graphNodeStyle.ts';

export interface CardBodyInput {
  /** 卡片世界坐标尺寸（布局产出）。 */
  w: number;
  h: number;
  /** 节点类型（色条的 `data-anic-node-bar` 值，契约据此断言"每节点一根色条"）。 */
  type: string;
  /** 色条填充（类型色或裁决色）。 */
  fill: string;
  /** 圆点填充（与色条同源）。 */
  dotFill: string;
  /** 该节点 result === 'FAIL'（决定红圈 strokeWidth=2，smoke 判据）。 */
  failed: boolean;
  /** 裁决线型（`VERDICT_SHAPE[key].dash`；无裁决 → undefined）。 */
  verdictDash: string | undefined;
  /** 裁决字形（无裁决 → undefined，不画字形）。 */
  verdictGlyph: string | undefined;
  /** 追溯态描边色（null = 无追溯）。 */
  traceStroke: string | null;
  /** 追溯距离分档样式（null = 无追溯）。 */
  depthStyle: TraceDepthStyle | null;
  /** 焦点描边（追溯态优先于焦点态）。 */
  focused: boolean;
  /** 节点角色（null = 不画标记）。 */
  role: NodeRole;
}

/**
 * 卡片体 + 色条 + 圆点 + 字形 + 角色标记。
 *
 * 返回数组由调用方按顺序摊平进节点 `<g>`（顺序即 z 序：卡片在底、标记在上）。
 */
export function renderCardBody(input: CardBodyInput): ReactElement[] {
  const { w, h, failed, role, traceStroke, depthStyle } = input;
  // 角色标记先求值一次：null（未判定）时整段不出现，否则包一层 <g> 便于定位。
  const roleMark = renderRoleMark({
    role,
    x: w - BAR_INSET,
    y: -h / 2 + BAR_INSET,
    r: 3.4,
    stroke: token('anic-text-dim'),
  });
  return [
    // 卡片体。`data-anic-node-card` 是"卡片确实渲染了"的可断言锚点。
    createElement('rect', {
      key: 'card',
      'data-anic-node-card': 'true',
      x: 0, y: -h / 2, width: w, height: h,
      rx: CARD_RADIUS, ry: CARD_RADIUS,
      fill: CARD_FILL,
      // 焦点卡片描边加粗：182 个节点里"我在看哪个"必须一眼可见。
      // 追溯态优先于焦点态：追溯是用户**显式进入**的模式，它的颜色编码
      // （上游/下游）比"鼠标刚好停在这"承载更多信息。
      stroke: traceStroke ?? (input.focused ? token('anic-focus-ring') : CARD_STROKE),
      // 追溯三档：深度 3 改虚线+细线、深度 2 降透明度（见 graphTraceDepth 头注）。
      strokeWidth: depthStyle?.width ?? (input.focused ? 1.6 : 0.8),
      strokeDasharray: depthStyle?.dash,
      strokeOpacity: traceStroke === null ? undefined : depthStyle?.fade ?? 1,
    }),

    // 左侧类型/裁决色条（非文本角色，3.3 阈值适用）。
    createElement('rect', {
      key: 'bar',
      'data-anic-node-bar': input.type,
      x: 0, y: -h / 2 + BAR_INSET, width: BAR_W, height: h - BAR_INSET * 2,
      rx: BAR_W / 2, ry: BAR_W / 2,
      fill: input.fill,
    }),

    // 状态圆点：每节点**恰好一个**。FAIL 用 strokeWidth=2 的红圈（smoke 数据驱动断言）。
    createElement('circle', {
      key: 'dot',
      'data-anic-node-dot': 'true',
      // 角色进 DOM（cycle-95）：角色是**形状/线型**通道（见 graphNodeRoleRender 头注），
      // 与裁决的 strokeDasharray 分通道——所以角色只吃 strokeWidth 档位。
      'data-anic-node-role': role ?? 'none',
      cx: DOT_X, cy: DOT_DY, r: DOT_R,
      fill: input.dotFill,
      stroke: failed ? token('anic-bad-text') : token('anic-text'),
      // 角色描边档叠加在 FAIL 的 2 / 常态的 0.6 之上：FAIL 优先（红圈是 smoke 的
      // 数据驱动判据，任何新通道都不许把它盖掉），没角色时退回原值。
      strokeWidth: failed ? 2 : (roleStrokeWidthOf(role) ?? 0.6),
      strokeDasharray: input.verdictDash,
      className: failed ? 'anic-fail-node' : undefined,
    }),

    // 字形是与颜色**正交**的第二个通道：灰度打印、色盲、强制高对比下仍可读。
    // 没有裁决时不画字形（画一个"无"字反而是噪声）。
    ...(input.verdictGlyph === undefined
      ? []
      : [createElement('text', {
          key: 'glyph',
          x: DOT_X, y: DOT_DY + 2.1, fontSize: 5.4, textAnchor: 'middle',
          fill: token('anic-on-accent'), 'data-anic-verdict-glyph': input.verdictGlyph,
        }, input.verdictGlyph)]),

    // 角色标记（cycle-95）：<path> 而非 <rect>/<circle> —— 后两者都有计数不变量
    // （每节点 2 rect / 1 circle），见文件头与 graphNodeRoleRender 头注。
    // 贴在卡片右上角内侧：与圆点（左侧）、色条（左缘）、健康条（底缘）都不抢位。
    ...(roleMark === null ? [] : [createElement('g', { key: 'role' }, roleMark)]),
  ];
}
