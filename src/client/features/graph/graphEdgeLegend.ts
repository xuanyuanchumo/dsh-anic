/**
 * **边语义图例**（cycle-91 建立 · cycle-94 改为零 `<svg>` 实现）。
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
 * ## 为什么不再用 `<svg>` 画线型示意（cycle-94 的实际返工）
 *
 * 初版给**每种边类型**各建一个 16×6 的 `<svg>`，6 种就是 6 个。结果撞红三条
 * 既有不变量（`graphInteractiveContract` / `graphVisualUpgradeContract` /
 * `offline-smoke` 的 `svg 恰好 1 个`）。
 *
 * 那三条断言的名义是「小地图不**嵌套** svg」——6 个**并列** svg 在语义上并不
 * 违反它。但两条路都不能走：
 *   - **放宽断言**（把全树计数改窄）去迁就实现 = 用削弱守卫来换功能，方向反了；
 *   而 `svg === 1` 顺带守住了「没有人偷偷加第二个画布」，这条价值不小。
 *   - **合并成单个 svg** 仍然要在 320px 宽的工具栏里塞 6 条独立日线的坐标，
 *   而这条图例本质上只是 6 段 16px 的**装饰性线段**。
 *
 * ⇒ 正确解法是**换实现**而不是改判据：线段用 CSS
 * `repeating-linear-gradient` 画。它本来就不是「图」，不该占用 SVG 画布配额。
 *
 * ## 三条纪律
 *
 * 1. **线型必须与 `EDGE_STYLES` 同源**：`dashToBackground` 从 `EDGE_STYLES[type].dash`
 *    **解析**出渐变（`'3 2'` → 实 3px / 空 2px 的循环），**绝不**在图例里另写一张表。
 *    图例自建表必然漂移，漂移后的图例是**骗人的东西**（与节点色点同款纪律，
 *    见 `graphToolbarLegend.ts` 头注）。
 * 2. **不新增 `<svg>` / `<circle>`**：前者撞 `svg === 1`，后者撞 `circle == 节点数`。
 * 3. **不进 Tab 序列**（`aria-hidden`）：图例是说明而非控件；AT 用户能从
 *    等价数据表拿到全量边信息。
 *
 * ## 边界
 *
 * 纯渲染 + 一个纯函数（`dashToBackground`），零状态 / 零 IO。
 */
import { createElement, type ReactElement } from 'react';
import { EDGE_STYLES, edgeStyleOf } from './graphEdgeRender.ts';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** 线段示意的像素长度（世界无关，纯装饰）。 */
const MARK_W = 16;
/** 线段示意的高度（可视高度 2px，留 1px 上下呼吸）。 */
const MARK_H = 2;

/** 边类型的中文名（动态键族 `graph.edge.<type>`）。 */
function edgeLabel(type: string): string {
  return t('graph.edge.' + type);
}

/** 全部已登记的边类型（按登记顺序，确定性）。 */
export function edgeTypes(): string[] {
  return Object.keys(EDGE_STYLES);
}

/**
 * 把 SVG 的 `stroke-dasharray` 解析成等价的 CSS 渐变背景（**纯函数，可单测**）。
 *
 * ## 为什么必须解析而不是复制
 *
 * `EDGE_STYLES` 是线型的**唯一事实源**。图例若自己写 `'3px 2px'` 这类字面量，
 * 改动 `EDGE_STYLES` 时图例会**静默不同步** —— 而这类漂移没有任何断言会红
 * （图例元素还在、文案还在、看起来也对）。解析则让漂移不可能发生。
 *
 * ## 渐变语法
 *
 * `repeating-linear-gradient(90deg, <color> <offset 1>, transparent <offset 1> <offset 2>)`：
 * 每段的 `from/to` 用**像素**（`px`），因为 dasharray 的单位是用户单位（≈px）。
 * `dash === undefined`（实线）→ 普通 `linear-gradient`，整段实色。
 *
 * ## 参数防御
 *
 * 只接受「正数个空白分隔的正数」。题目里的 `'0.5 2.4'` 是点线 —— 小数必须支持，
 * 否则点线会退化成实线（`parseInt` 会把它读成 0，而 0 长度段在渐变里是可见边界
 * 抖动）。无法解析 → 返回实线（**可见地退化**，而不是抛错让整条工具栏崩）。
 * 返回 `string` 而非 `undefined`：调用方永远拿得到可渲染值。
 *
 * @param dash `strokeDasharray` 原值（如 `'3 2'`）；undefined = 实线
 * @param color CSS 颜色（调用方传 `token(...)`，图例不硬编码色值）
 */
export function dashToBackground(dash: string | undefined, color: string): string {
  const segments = (dash ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => Number.parseFloat(s));
  const usable = segments.filter((n) => Number.isFinite(n) && n > 0);
  // 实线，或 dasharray 语法异常（如全是 0 / 非数）⇒ 退化为实线（可见、不抛）。
  if (dash === undefined || usable.length === 0 || usable.length !== segments.length) {
    return `linear-gradient(90deg, ${color} 0, ${color} ${String(MARK_W)}px)`;
  }
  // dasharray 允许奇数个数：SVG 会自动重复一轮使其变偶。镜像同一条规则，
  // 否则 `'3'` 这种值在图上是一段实一段空、在图例里会变成纯实线。
  const even = usable.length % 2 === 1 ? [...usable, ...usable] : usable;
  const stops: string[] = [];
  let offset = 0;
  for (let i = 0; i < even.length; i += 2) {
    const on = even[i] ?? 0;
    const off = even[i + 1] ?? on;
    const onTo = offset + on;
    const offTo = onTo + off;
    stops.push(`${color} ${String(offset)}px ${String(onTo)}px`);
    stops.push(`transparent ${String(onTo)}px ${String(offTo)}px`);
    offset = offTo;
  }
  // 循环长度 = 一轮 dash 之和。段数太多时不必截断：渐变会自然重复。
  return `repeating-linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * 渲染边语义图例（零 `svg` 实现，见文件头）。
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
        // 线型示意：**纯 CSS 线段**（不是 svg）。dash 由 dashToBackground 从
        // EDGE_STYLES 解析得到 —— 同源，图例画的是图上真实线型。
        createElement('span', {
          'data-anic-graph-edge-legend-mark': type,
          // 把解析后的渐变也写进 DOM：契约测试可以断言"图例线型 == EDGE_STYLES"，
          // 而不必去解析 CSS 规则（后者在 jsdom 里读不到）。
          'data-anic-graph-edge-legend-dash': style.dash ?? 'solid',
          style: {
            display: 'inline-block', width: MARK_W, height: MARK_H,
            background: dashToBackground(style.dash, token(style.stroke)),
          },
        }),
        edgeLabel(type),
      );
    }),
  );
}
