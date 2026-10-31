/**
 * 布局**规格**（尺度参数 + 模式表 + 耦合机理）——从 `graphLayout.ts` 拆出。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `graphLayout.ts` 回答的是「节点摆在哪」（算法），本文件回答的是「摆多密 /
 * 摆多大 / 什么算合格」（**规格**）。两者混在一个文件里的代价是：改一个像素
 * 常量的人会顺手改算法，而算法里那条"行数上限与像素上限互相耦合"的推理链
 * 会被一起搬走——下次有人只调一个数就重演 cycle-89 的宽高比爆炸。
 *
 * 拆开后：规格集中在此（**判据只有一个来源**），算法文件只消费 `specOf(mode)`。
 *
 * ## 判据常量为什么也在这里
 *
 * `LAYOUT_ASPECT_BOUNDS` 是「宽高比 ∈ (0.8, 3.2)」这条验收线的**唯一**来源。
 * 留在算法文件里，测试与工具栏就会各写一份数字；放在规格文件里，改判据的人
 * 一定看到它。
 */
import type { TokenName } from '../../../shared/tokens.ts';

/** 布局尺度参数（一个模式 = 一张这样的表）。 */
export interface LayoutSpec {
  /** 单列最多放多少行（折列判据之一）。 */
  rowsPerColumn: number;
  /** 列距（世界坐标 px）。节点 x = column × columnPitch。 */
  columnPitch: number;
  /** 最小行距：卡片比它高时以卡片高为准。 */
  rowPitch: number;
  /** 单列像素高上限（变尺寸后真正的"一屏高"判据）。 */
  columnBudgetPx: number;
  /** 同 lane 相邻卡片的垂直净空。 */
  gap: number;
  /**
   * 目标宽高比（只被 `flow` 消费；lane/compact 缺省 = 不设目标）。
   *
   * 为什么可选而不是必填：lane/compact 的宽高比是折列参数的**副产品**（cycle-89
   * 的爆炸就出在这里），给它们加一个"目标比例"会诱导后来者去调参数凑比例。flow
   * 反过来——它的层数由拓扑决定、不由参数决定，所以只能靠"层带多宽"这一个自由度
   * 去逼近目标，目标比例因此是**必需**的输入。
   */
  aspectRatio?: number;
}

/**
 * 布局尺度。四个数字都有明确依据，改动必须同时改测试里的量化断言：
 * - `rowPitch: 26`：**最小**行距（cycle-82 原值）。卡片比 26 高时以卡片高为准；
 * - `columnPitch: 120`：最宽卡片 112 + 8px 列间净空。改它要同步改契约 ⑤ 的取模断言；
 * - `rowsPerColumn: 24`：行数上限（折列位置）；
 * - `columnBudgetPx: 840`：单列像素高上限。变尺寸后这才是真正的"一屏高"判据；
 * - `gap: 8`：同 lane 相邻卡片的垂直净空（小于 6 时卡片描边会在 0.5 倍缩放下粘连）。
 *
 * ## ⚠️ rowsPerColumn 与 columnBudgetPx 是**耦合**的，不能各自单独调小（cycle-89 教训）
 *
 * cycle-89 的工作树曾把 24→14、840→480 两个数**同时**调小，结果宽高比从 2.00
 * 冲到 **6.21**（验收上界 3.2，两条契约同时红）。机理是两头夹击：
 *   - 单列装得越少（rowsPerColumn / columnBudgetPx ↓）→ **列数变多** → 宽度涨；
 *   - columnBudgetPx ↓ → **单列高度变矮** → 高度降；
 *   - 宽高比 = 宽/高 ⇒ 两边同时朝相反方向动，比值必然爆炸。
 *
 * 实测（249 节点全量投影，同构扫描）：
 *   | rowsPerColumn | columnBudgetPx | 宽 | 高 | 宽高比 | 列数 | 高/原高 |
 *   |---|---|---|---|---|---|---|
 *   | 14 | 480 | 2980 | 480 | **6.21**（红） | 25 | 0.047 |
 *   | 24 | 840 | 1696 | 850 | 2.00（绿） | 14 | 0.083 |
 *   | 20 | 720 | 1936 | 700 | 2.77（绿） | 16 | 0.068 |
 *   | 16 | 720 | 1936 | 700 | 2.77（绿） | 16 | 0.068 |
 *
 * 结论：**要么两个都别动**（基线 24/840，比值 2.00，距上界 3.2 有 60% 余量），
 * **要么只调小 columnBudgetPx 并同步放宽 rowsPerColumn**（"一降一升"的配对），
 * **绝不能两个一起降**。反过来（两个一起**升**）比值单调下降，是安全方向。
 *
 * 真正的防退化判据是结构性那三条（高度 ≤ 原高 60% / 单列 ≤ rowsPerColumn /
 * 宽高比 ∈ (0.8, 3.2)），它们由 `graphLayout.test.ts` 与
 * `graphInteractiveContract.test.ts` ⑤ 逐条钉死。
 */
export const LAYOUT: LayoutSpec = {
  rowsPerColumn: 24,
  columnPitch: 120,
  rowPitch: 26,
  columnBudgetPx: 840,
  gap: 8,
};

/**
 * 宽高比验收区间（与 graphLayout.test.ts / 契约 ⑤ 同口径）。
 *
 * 为什么要导出成常量而不是留在测试里各写一份：判据一旦**只存在于测试**，
 * 改布局的人看不到自己正在碰哪条红线；导出来之后，工具栏想显示「当前比值」
 * 或加新断言时，判据只有一个来源。
 */
export const LAYOUT_ASPECT_BOUNDS = { min: 0.8, max: 3.2 } as const;

/** 泳道表头带高度（世界坐标 px）。表头画在卡片上方，卡片必须下移让位。 */
export const LANE_HEADER_H = 18;

/**
 * 布局模式。
 *
 * - `lane`（疏朗）：按泳道折列。同一泳道的节点在**连续的列**里，读者能顺着
 *   一列读下去 —— 这是默认模式，也是 `LAYOUT` 的原样。
 * - `compact`（紧凑）：**卡间隙更小 + 单列容量更大** ⇒ 同样的节点占**更少的列**。
 * - `flow`（流程，cycle-94）：**不看泳道，看边的拓扑**。Sugiyama 简化版分层，
 *   同一条链上的节点相邻，跨层边最少（算法见 `graphLayoutFlow.ts`）。
 *
 * ## 为什么"紧凑"不是"把卡片缩小"
 *
 * 卡片尺寸（`NODE_BOX`）与渲染层的字形常量（DOT_X / LABEL_DY / 字号）是一套
 * 耦合坐标：卡片一旦缩小，10.5px 的主标签就会溢出卡片边界。要真正缩小卡片
 * 必须同步缩放整套渲染常量，那是**渲染层的**改动，且会让截断预算（`fitLabel`）
 * 全部重算。代价远大于收益。
 *
 * 紧凑模式的真实收益在**装进视口后的可读性**：249 节点的图在疏朗模式下要适配
 * 到 900px 宽的视口，比例约 0.5 ⇒ 10.5px 的标签只剩 5px（看不清）；紧凑模式
 * 列数更少 ⇒ 适配比例更高 ⇒ 标签可读。**同样高度下更窄 = 缩放后更大**。
 *
 * ## `flow` 为什么不复用 lane 的参数表（这是三者里唯一的"换算法"）
 *
 * lane/compact 的差异全在**尺度**上（`LAYOUT_MODES` 的两张表），算法是同一份
 * `planColumns`。flow 换的是**算法**：分桶折列 → 拓扑分层。所以它的参数表只是
 * "尺度"，拓扑判据（分层/排序/交叉）在 `graphLayoutFlow.ts` 里，不在本表。
 */
export type LayoutMode = 'lane' | 'compact' | 'flow';

/**
 * 三种模式的参数表。
 *
 * `compact` 的取值依据（与 cycle-89 的耦合机理同源，此处是**安全方向**）：
 * - `rowsPerColumn: 30`（↑）：单列装更多 ⇒ 列数变少 ⇒ 宽度**降**；
 * - `columnBudgetPx: 900`（↑）：单列更高 ⇒ 高度**升** ⇒ 宽高比**降**（远离 3.2 上界）；
 * - `gap: 4`（↓）：卡间隙更紧 ⇒ 单列像素高更省 ⇒ 同样列高塞更多节点；
 * - `rowPitch: 24`（↓）：仅影响比 26 矮的卡片（当前无此类型），
 *   保留它是为了"卡片比行距高时以卡片高为准"这条不变式仍然成立。
 *
 * 两个数**一起升**是耦合机理里唯一被证明安全的方向（比值单调下降），
 * 所以本模式不会重演 cycle-89 的爆炸。两个模式的实测宽高比见
 * `tests/unit/graphLayoutMode.test.ts`。
 *
 * `flow` 的取值依据：`aspectRatio: 1.2` 是本仓实测目标（ELK Layered 的默认是
 * 1.6，本研究 B1-4 建议 flow 单独取 ~1.2 以贴合 16:9 视口）。`rowsPerColumn`
 * 与 `columnBudgetPx` 对 flow **不生效**（那是折列的判据），保留合理值只为让
 * `LayoutSpec` 是同一张表、消费方不必分支取值 —— `graphLayoutFlow.assignCoordinates`
 * 真正用的是 `columnPitch` / `rowPitch` / `gap` / `aspectRatio` 四个。
 */
export const LAYOUT_MODES: Readonly<Record<LayoutMode, LayoutSpec>> = {
  lane: LAYOUT,
  compact: {
    rowsPerColumn: 30,
    columnPitch: 120,
    rowPitch: 24,
    columnBudgetPx: 900,
    gap: 4,
  },
  flow: {
    // 折列判据对 flow 不生效；取 lane 同值以免读者误以为它被用到了。
    rowsPerColumn: 24,
    columnPitch: 120,
    rowPitch: 26,
    columnBudgetPx: 840,
    gap: 8,
    aspectRatio: 1.2,
  },
};

/** 模式 → 规格（未知模式回落到默认的疏朗模式，绝不抛）。 */
export function specOf(mode: LayoutMode | undefined): LayoutSpec {
  if (mode === 'compact') return LAYOUT_MODES.compact;
  if (mode === 'flow') return LAYOUT_MODES.flow;
  return LAYOUT_MODES.lane;
}

/**
 * lane 优先级 = 读图时的语义顺序（宏观 → 门禁 → 循环 → 事件 → 兜底）。
 * 写成常量而不是从数据里推导：类型集合是闭合的，顺序是**设计决定**，
 * 让它随数据首现顺序漂移会让同一份数据在不同 cycle 下画出不同图。
 */
export const LANE_ORDER: readonly string[] = [
  'phase', 'micro-step', 'gate', 'human-gate', 'cycle', 'gate-event', 'incident', 'autonomy',
];

/**
 * 泳道表头用的令牌（与卡片类型色同源）。
 *
 * 为什么单独列：表头是**文字 + 计数**，不是卡片，所以不能用卡片的类型色做大面积
 * 填充（会与卡片色条抢注意力）；只用「文本强 + 文本弱 + 边框」三档。
 */
export const LANE_HEADER_TOKENS: Readonly<Record<'text' | 'count' | 'rule', TokenName>> = {
  text: 'anic-text-strong',
  count: 'anic-text-dim',
  rule: 'anic-border-strong',
};
