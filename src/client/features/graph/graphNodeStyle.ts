/**
 * 节点视觉常量（cycle-83 · V 战线）——图区唯一的「卡片长什么样」事实源。
 *
 * ## 为什么单独成文件
 *
 * 拆分的界线是**职责**：本文件只回答"颜色、线型、卡片几何是什么"（视觉语言），
 * `graphNodeCard.ts` 回答"一张卡片由哪几个元素组成"。界线一句话能说清，
 * 拆开就不会造成"为凑行数而割裂"（250 行模块纪律是 `truthAuditChecks` 的机械项）。
 *
 * ## 颜色只能经 token()
 *
 * 本文件的每个色值都是 `token('anic-*')` / `hostToken('anic-*')`。cycle-83 的新视觉
 * 元素（卡片体 / 色条 / 悬浮卡 / 小地图）沿用同一套 46 个语义令牌与**同一套对比度
 * 角色判定**（非文本 ≥3.3、文本 ≥4.5，见 `tests/contract/contrastContract.test.ts`）。
 * **不自造颜色**是硬纪律：新加一个十六进制值等于绕开整张表的校准与契约。
 *
 * ## 宿主令牌是 fallback 的**上游**，不是新调色板
 *
 * `hostToken()` 产出 `var(--anic-x, var(--dsw-alias-..., <原语>))`：`anic-*` 永远
 * 最外层（保住对比度契约与暗色覆盖），宿主令牌次之（主题跟随更准），原语垫底。
 *
 * ## 标签宽度预算（与设计稿 13px/22 字的偏差，实测后修正）
 *
 * 合同要求"主标签 13px、截断 22 字"，但**物理上做不到**：`columnPitch` 是 120
 * 且 `graphInteractiveContract` ⑤ 钉死「节点 x 是 120 的整数倍」，所以卡片最宽
 * 112px；减去 3px 色条、17px 圆点列、8px 右侧留白后，文本预算只剩 **87px**。
 * 13px 中文单字宽 13px ⇒ 22 字需要 286px。于是本文件把字号定在 10.5px，并按
 * **显示宽度**（CJK 记 2 个宽度单位）动态截断 —— 视觉上不再有"标签压到隔壁列"
 * （改造前 6.4px × 18 字实际越出卡片 30px 以上，那才是真的不可读）。
 */
import { token } from '../../../shared/tokens.ts';
import { hostToken } from '../../../shared/hostTokens.ts';

/**
 * 节点类型色。
 *
 * 令牌引用（P1-TOKENS）：同一张表曾是私有十六进制，与 gateColors / renderStepTrace
 * 各自重复一份，"改一处亮一处"且暗色主题只能覆盖到被 `var()` 引用的那一份。
 */
const TYPE_COLORS: Record<string, string> = {
  phase: token('anic-type-phase'),
  'micro-step': token('anic-type-micro-step'),
  gate: token('anic-type-gate'),
  'human-gate': token('anic-type-human-gate'),
  cycle: token('anic-type-cycle'),
  'gate-event': token('anic-type-gate-event'),
  incident: token('anic-type-incident'),
  autonomy: token('anic-type-autonomy'),
};

export function colorOf(type: string): string {
  return TYPE_COLORS[type] ?? token('anic-type-unknown');
}

/**
 * 类型色对外查询（图例色点 / 卡片色条 / 小地图同源）。
 *
 * 图例必须是**真色点**而不是文字标签：用户看图例是为了把颜色映射回类型。
 * 转出同一个 `colorOf` 保证图例、卡片、小地图永远同源（各自维护一张表必然漂移，
 * 图例就成了骗人的东西）。
 */
export function typeColorOf(type: string): string {
  return colorOf(type);
}

/**
 * 裁决 → 线型 + 字形（与颜色正交的第二通道，WCAG 1.4.1）。
 *
 * PASS 实线·✓ / FAIL 虚线·✕ / doubt 点线·? / pending 细虚线· / skip 短划·–
 * 颜色永远不能是唯一通道：红绿色盲用户（约 8% 男性）PASS 与 FAIL 完全不可分，
 * 而**任何 DOM 断言都看不出来**（圆点照常存在、颜色照常"正确"）。
 */
export const VERDICT_SHAPE: Record<string, { dash: string | undefined; glyph: string }> = {
  pass: { dash: undefined, glyph: '✓' },
  fail: { dash: '2 1.4', glyph: '✕' },
  doubt: { dash: '0.6 1.6', glyph: '?' },
  pending: { dash: '3 2', glyph: '·' },
  skip: { dash: '1 2', glyph: '–' },
};

/* ── 卡片几何（世界坐标，相对卡片左缘 / 垂直中心）────────────────── */

/**
 * 卡片圆角。
 *
 * cycle-109（视觉现代化）7px：卡片高 34–46px，6px 时圆角只占 13–18%，读起来仍像
 * 「切了角的长方框」；7px 是"卡片"与"方框"的临界档，且不会吃掉左侧 3px 类型色条
 * （色条是独立 rect，圆角在它右侧起效）。几何量不影响布局（`graphLayout` 只算
 * x/y/w/h），所以这条改动**不碰任何不变量**。
 */
export const CARD_RADIUS = 7;
/** 左侧类型色条宽 3px（非文本角色：3.3 阈值）。 */
export const BAR_W = 3;
/** 色条上下内缩：贴满整高会在圆角处露尖。 */
export const BAR_INSET = 6;
/** 状态圆点半径（**每节点严格一个 circle**，见 graphNodeCard 头注）。 */
export const DOT_R = 4.6;
/** 圆点中心 x（相对卡片左缘）：色条 3 + 净空 7 + 半径。 */
export const DOT_X = BAR_W + 10;
/** 文本起点 x：圆点右缘 + 4px 净空。 */
export const LABEL_X = DOT_X + DOT_R + 4;
/** 文本右侧留白（贴到卡片右缘会与描边粘连）。 */
export const LABEL_PAD = 8;
/** 主标签字号：见文件头「标签宽度预算」。 */
export const LABEL_PX = 10.5;
/** 次标签字号。 */
/*
 * cycle-109（视觉现代化）：8.6 → 9.0。次标签是「类型 · 裁决 · 测试摘要」三条信息
 * 的载体，8.6px 在 1080p 缩放下实测只有 7 个物理像素高（笔画粘连），9.0px 是
 * 等宽字体在非 Retina 屏上仍可辨的最小档。宽度预算由 `fitLabel` 动态收敛，
 * 所以抬字号不会导致标签越界（只是截断更早一点）。
 */
export const META_PX = 9;
/** 主标签**绝对**上限（即使卡片够宽也不超过 22 字，防超长 label 吃掉整个卡片）。 */
export const LABEL_MAX = 22;

/** 主标签基线（相对卡片垂直中心）。 */
export const LABEL_DY = -2.6;
/** 次标签基线（相对卡片垂直中心）。 */
export const META_DY = 10.4;
/** 圆点垂直中心（相对卡片垂直中心）：与主标签首行对齐。 */
export const DOT_DY = -5.6;

/**
 * 单字符显示宽度（等宽字体近似）：CJK/全角算 1 个字宽，ASCII 算 0.58 个字宽。
 *
 * 为什么不用 `label.length` 截断（改造前的做法）：`Maintain（维护）` 的 length 是 12
 * 但显示宽度是 8*0.58 + 4 ≈ 8.6 个字宽 —— 按 length 截会多截掉肉眼看着还放得下的字，
 * 而按固定字数截又会在中文 label 上越界。宽度估算让截断与实际像素预算对齐。
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 全角/CJK/emoji 记 1，ASCII 记 0.58；这两档覆盖本仓全部 label 字符。
    w += code > 0x2e80 ? 1 : 0.58;
  }
  return w;
}

/**
 * 按卡片实际宽度截断标签（纯函数，可单测）。
 *
 * @param label 原始标签
 * @param cardW 卡片宽（布局产出，不再取常量）
 * @returns 截断后的标签（截断时补省略号；未截断时原样返回）
 */
export function fitLabel(label: string, cardW: number): string {
  const budgetPx = cardW - LABEL_X - LABEL_PAD;
  // 字宽 = 字号 × 宽度单位；预算 / 字宽 = 可容纳的宽度单位数。
  const budgetUnits = budgetPx / LABEL_PX;
  if (displayWidth(label) <= budgetUnits && label.length <= LABEL_MAX) return label;
  let out = '';
  let used = 0;
  // 留 0.7 个字宽给省略号，否则"截断后仍然越界"。
  const limit = Math.min(budgetUnits - 0.7, LABEL_MAX - 1);
  for (const ch of label) {
    const w = displayWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/* ── 卡片配色 ───────────────────────────────────────────────── */

/**
 * 卡片体填充与描边。
 *
 * 为什么卡片体**不**用类型色大面积填充：类型色是按"非文本 ≥3.3"校准的填充色，
 * 铺满后 10.5px 标签压在上面只有约 2:1（远低于文本 4.5）。所以卡片体用表面色
 * （hostToken：跟随宿主背景更准），语义色只出现在 3px 色条与 9px 圆点上 ——
 * 这两个都是非文本角色，阈值适用。
 */
export const CARD_FILL = hostToken('anic-surface');
export const CARD_STROKE = hostToken('anic-border-strong');
export const LABEL_FILL = hostToken('anic-text-strong');
export const META_FILL = hostToken('anic-text-dim');
