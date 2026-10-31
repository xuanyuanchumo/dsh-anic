/**
 * **类型专属形状**（cycle-94）—— WCAG 1.4.1「颜色不能是唯一通道」的真正落地。
 *
 * ## 为什么必须有形状通道（这不是锦上添花）
 *
 * `src/shared/palette.ts` 的 cycle-94 重校准证明了**硬件层面的不可达**：
 * 9 个类型色必须在浅底与暗底**同时** ≥3.3 ⇒ 相对亮度被锁进
 * `[0.1441, 0.2541]` 的窄带（宽 1.76 倍）⇒ 只能靠色相区分 ⇒ 而该带内
 * "两两 ΔE ≥ 15"的色数**不足 9**。三项同时最优的实测上限是：正常 6.92 /
 * deuter 5.39 / protan 5.45。
 *
 * ⇒ **9 个类型靠颜色本身永远分不清**。这是几何/色域事实，不是调色水平问题。
 * 所以 WCAG 1.4.1（Use of Color）在这里不是"建议"而是**唯一可行的合规路径**：
 * 分类信息必须有第二通道。本文件提供形状，`graphNodeCard` 的 meta 行提供文字。
 *
 * ## 为什么形状表要和色彩表分开成文件
 *
 * 两者的**失效模式不同**：颜色失效是"两个色太近"（连续量问题，可量化 ΔE）；
 * 形状失效是"两个形状太像"（离散量问题，只能靠穷举比对路径）。混在一起时，
 * 改颜色的人会顺手把形状表也当"配色表"来调，而形状的可辨性判据（两两不同）
 * 就没人守了。分开后，各有各的契约测试。
 *
 * ## 硬约束：不许用 `<circle>`
 *
 * `scripts/offline-smoke.mjs` 与 `graphVisualUpgradeContract.test.ts` 钉死
 * 「SVG `<circle>` 数 == 节点数」。这条不变量守的是「一个节点恰好一个裁决点」。
 * ⇒ 形状渲染**只能用 `<rect>`（可带 `rx` 圆角）或 `<path>`**。
 * `shapeOf` 返回的是**语义形状名**，渲染层负责翻译成这两种元素之一。
 *
 * ## 边界
 *
 * 纯映射表（零 DOM、零 IO）。不做布局计算，也不持有任何状态。
 */

/** 形状语义名（渲染层据 `data-anic-type-shape` 断言，翻译成 rect/path）。 */
export type TypeShape =
  | 'square'    // 方：相位（宏观阶段，块状推进）
  | 'diamond'   // 菱形：微步骤（流程节点）
  | 'triangle'  // 三角：门禁（收敛判定，指向上）
  | 'chevron'   // 人字形：人工门（人的介入）
  | 'ring'      // 空心方（描边）：循环（回环）
  | 'star'      // 星形：门禁事件（重要事件）
  | 'cross'     // 叉：事故（异常）
  | 'hexagon'   // 六边形：自主级
  | 'dot';      // 小实心方：兜底未知

/**
 * 类型 → 形状（**9 个类型 9 个不同形状**，闭合表）。
 *
 * 顺序即 `LANE_ORDER` 的语义顺序（与 `graphLayoutSpec.LANE_ORDER` 同源），
 * 让"图上从左到右"与"表里从上到下"一致 —— 读者学一次形状表就能通读整图。
 *
 * ⚠️ 这个表是**闭合**的：新增节点类型必须同时在这里加一行，否则会落到 `dot`。
 * 那是有意的退化（未知类型画小方点）而不是抛错 —— 图不能因为一个没登记的类型
 * 就整块渲染失败。但 `tests/contract/graphTypeShapeContract.test.ts` 会断言
 * "已登记类型全部有专属形状"，所以漏登记会在测试里红。
 */
export const TYPE_SHAPES: Readonly<Record<string, TypeShape>> = {
  phase: 'square',
  'micro-step': 'diamond',
  gate: 'triangle',
  'human-gate': 'chevron',
  cycle: 'ring',
  'gate-event': 'star',
  incident: 'cross',
  autonomy: 'hexagon',
  unknown: 'dot',
};

/** 兜底形状（未登记类型）。 */
export const FALLBACK_SHAPE: TypeShape = 'dot';

/** 取某类型的形状（未登记 → `dot`，绝不抛）。 */
export function shapeOf(type: string | undefined): TypeShape {
  if (typeof type !== 'string') return FALLBACK_SHAPE;
  return TYPE_SHAPES[type] ?? FALLBACK_SHAPE;
}

/** 全部已登记形状（契约测试用来断言"两两不同"与"覆盖完整"）。 */
export function allShapes(): TypeShape[] {
  return Object.values(TYPE_SHAPES);
}

/** 全部已登记类型（= `TYPE_SHAPES` 的键）。 */
export function shapeTypes(): string[] {
  return Object.keys(TYPE_SHAPES);
}
