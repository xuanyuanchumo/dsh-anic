/**
 * 导出用**具体色值**（cycle-90）——SVG 导出文件要在**宿主之外**打开。
 *
 * ## 为什么导出不能用 `token()`
 *
 * `token('anic-text-strong')` 产出的是 `var(--anic-text-strong, #475569)`。
 * 在宿主面板里这没问题（令牌块被注入），但导出的 `.svg` 文件会被用户存到
 * 硬盘、在浏览器/设计工具/Word 里打开——那里**没有** `[data-anic-workflow]`
 * 作用域的令牌块，`var()` 会回退到 fallback（可行），但如果宿主的暗色主题
 * 覆盖了 `--anic-*`，导出的文件在别处打开时会带着宿主的取值。
 *
 * 更根本的问题是：`var()` 在某些 SVG 查看器（部分图片预览器、部分 PDF 转换器）
 * 里**完全不解析** ⇒ 整张图变成黑色块。
 *
 * 所以导出必须用**具体色值**。但具体色值不能在本文件里**新造**一套调色板
 * （那就是"两套真相"的复发）。正确形态是：色值从 `PALETTE`（本仓原语的**唯一**
 * 来源）取，而不是从 `token()` 取。
 *
 * ## 为什么这里出现十六进制而不违反"零颜色字面量"纪律
 *
 * `clientRenderContract` 的颜色字面量守卫扫的是 `src/client` 下的**组件源码**，
 * 它的立意是"组件不许绕过语义令牌层"。本文件是**导出序列化器**——它的产出
 * 是一段给外部程序看的 XML 文本，不是宿主页面里的元素。这里引用 `PALETTE`
 * 的具体值是**从唯一来源取值**，不是绕过它。
 *
 * 为了不与守卫的立意冲突，本文件不写任何字面色值，而是**从 `PALETTE` 索引**，
 * 颜色实现在 `graphExportSvg.ts` 里通过 `PALETTE` 引用。
 */
import { PALETTE } from '../../../shared/palette.ts';

/** 导出用的表面/文本/边框色（从 PALETTE 取，保持与宿主同一套原语）。 */
export const EXPORT_COLORS = {
  /** 画布底色（不透明 —— 否则在深色查看器里整张图看不见）。 */
  surface: PALETTE.surface,
  /** 卡片底色。 */
  card: PALETTE.surface,
  /** 卡片描边。 */
  cardStroke: PALETTE.borderStrong,
  /** 边线色。 */
  edge: PALETTE.textFaintL,
  /** 主标签色。 */
  label: PALETTE.textStrongL,
  /** 次标签色。 */
  meta: PALETTE.textDimL,
  /** 泳道表头名色。 */
  laneName: PALETTE.textStrongL,
  /** 泳道表头计数色。 */
  laneCount: PALETTE.textDimL,
} as const;

/**
 * 裁决 → 导出填充色（具体值）。
 *
 * 复用 `gateColors` 的**归一表**（`canonicalVerdict`）保证别名口径一致
 * （`PASS` / `pass` / `approve` 必须落到同一个色），但取的是 `PALETTE`
 * 的原语而不是 `token()`（理由见文件头）。
 */
export const EXPORT_VERDICT_FILL = {
  pass: PALETTE.gatePass,
  fail: PALETTE.gateFail,
  doubt: PALETTE.gateDoubt,
  pending: PALETTE.gatePending,
  skip: PALETTE.gateSkip,
} as const;

/**
 * 节点类型 → 导出填充色（具体值）。
 *
 * 与 `graphNodeStyle.TYPE_COLORS` **同源同值**（那一份取 `token()`，这里取
 * `PALETTE`）——两者的 fallback 指向同一个原语，所以屏幕上与导出后颜色一致。
 */
export const EXPORT_TYPE_FILL = {
  phase: PALETTE.typePhase,
  'micro-step': PALETTE.typeMicroStep,
  gate: PALETTE.typeGate,
  'human-gate': PALETTE.typeHumanGate,
  cycle: PALETTE.typeCycle,
  'gate-event': PALETTE.typeGateEvent,
  incident: PALETTE.typeIncident,
  autonomy: PALETTE.typeAutonomy,
} as const;

/** 未知类型兜底色（与 `graphNodeStyle` 的 unknown 档同值）。 */
export const EXPORT_TYPE_FILL_UNKNOWN = PALETTE.typeUnknown;
