/**
 * 追溯**距离分档**的视觉样式（cycle-95 · WS-B）——「它炸了影响多远」。
 *
 * ## 为什么分档要独立成文件（而不是塞进 graphNodeCard）
 *
 * 三档语义是**跨元素**的：卡片描边（虚线/实色）与圆点透明度、以及将来可能的
 * 边加粗都读同一组档位。把它写在卡片里，就会出现"卡片改了、边没改"的漂移。
 * 独立成纯函数后，任何元素都能取到同一套档位（与 `graphNodeStyle` 的
 * "视觉语言单一事实源"是同一条纪律）。
 *
 * 另有一个现实理由：`graphNodeCard.ts` 已在 233 行（T3 ≤250 的 93%），
 * 任何新渲染逻辑内联都会越线。**新逻辑一律新建文件承载**，卡片只留一行调用。
 *
 * ## 为什么同时改两个通道（不是"有点冗余"）
 *
 *   - `dash`：实线 / 短虚线 / 长虚线 —— 灰度打印、色盲、强制高对比下可分；
 *   - `fade`（strokeOpacity）：1 / 0.5 / 1 —— 屏幕上的"远近感"。
 *
 * 单靠透明度不行：半透明在浅底上几乎看不出（对比度被底吃掉），而且 AT 与
 * 灰度打印完全读不到。单靠线型也不行：3 跳虚线在缩小后与 2 跳相近。
 * 两个通道叠加才让"1 跳直接 / 2 跳邻接 / 3 跳波及"**在没有颜色的情况下**可分。
 *
 * ## 纯函数（零 DOM / 零 hook / 零 clock）
 *
 * 只做 (traceRole, depth) → 样式对象的映射，可逐档断言。
 */

/** 追溯深度上限（与 `graphTrace.MAX_TRACE_DEPTH` 同值；此处只用于夹取输入）。 */
const MAX_DEPTH = 3;

export interface TraceDepthStyle {
  /** 卡片描边线型（undefined = 实线）。 */
  dash: string | undefined;
  /** 描边不透明度（1 = 不透明）。 */
  fade: number;
  /** 描边宽度（深 3 跳更细：虚线 + 细线 = "间接"的视觉合流）。 */
  width: number;
}

/** 无追溯时的缺省样式（与改造前逐字节等价：实线、不透明、按焦点档给宽）。 */
export const NO_TRACE_DEPTH: TraceDepthStyle = { dash: undefined, fade: 1, width: 1.8 };

/** 三档常量（表驱动，避免 if 链在每个调用点重复一遍）。 */
export const TRACE_DEPTH_STYLES: Readonly<Record<1 | 2 | 3, TraceDepthStyle>> = {
  1: { dash: undefined, fade: 1, width: 1.8 },
  2: { dash: '0.9 0.9', fade: 0.5, width: 1.8 },
  3: { dash: '2.4 1.6', fade: 1, width: 1.2 },
};

/**
 * 取某节点在追溯里的描边样式。
 *
 * @param enabled 该节点是否处于**任何**追溯角色（root / up / down / both）。
 *   false ⇒ 返回 `null`（调用方走自己的焦点/常态分支，不看本模块）。
 * @param depth 跳数；0 = root 自身或圈外，一律按"1 跳档"（实色）——
 *   root 是起点，画虚线与"波及"混淆反而错。
 */
export function traceDepthStyleOf(enabled: boolean, depth: number): TraceDepthStyle | null {
  if (!enabled) return null;
  const d = depth >= 1 && depth <= MAX_DEPTH ? Math.floor(depth) : 1;
  return TRACE_DEPTH_STYLES[d as 1 | 2 | 3];
}

/** 供 `data-anic-trace-depth` 归一化用的跳数（夹到 0..3，非法值 → 0）。 */
export function clampTraceDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  const d = Math.floor(depth);
  if (d < 0) return 0;
  return d > MAX_DEPTH ? MAX_DEPTH : d;
}
