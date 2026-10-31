/**
 * 工具栏紧凑度读数（cycle-96 · WS-D3）——把「排版是否恶化」变成可断言的数字。
 *
 * ## 被守卫的缺陷形态
 *
 * 工具栏是 `flexWrap: 'wrap'` 容器，7 个控件组 + 图例行在同一条流里。窄面板下它会
 * 折成 3–4 行，把图区往下推。而**没有任何断言在看这件事**：
 *   - 加一个控件 ⇒ 悄悄多占一行 ⇒ 谁也不会注意到，除非有人恰好截图对比。
 * 这正是本仓反复出现的「无读数的改动 = 无法评审的改动」。
 *
 * ## 为什么用结构化下界而非真实布局测量
 *
 * 本模块与 `graphToolbarRender` 同纪律：**纯函数**（零 DOM / 零 clock）。
 * 真实占行数要 `getBoundingClientRect`，而 smoke 的 React 桩环境里没有 DOM 测量，
 * 且带测量的实现不可确定性测试（同输入不同机器给不同答案）。
 *
 * ⇒ 用「每组最少占宽 × 容器的保守估宽」算出**下界**。估少了会让守卫偏松，
 * 但**不会骗人**：判据是「不得超过预算」，低估只可能漏报严重情形，不可能误报
 * （误报会让守卫被学会忽略，那比漏报更糟 —— 本仓既有教训）。
 *
 * ## 宽度常量的依据
 *
 * - `MIN_GROUP_W = 78`：最短的组是「缩放」（三个小按钮 + 两个分隔符），实测约 78px；
 * - `PANEL_W = 460`：面板在右侧栏展开时的近似可用宽度（比这更窄时真实行为是横向滚动，
 *   不在本读数要表达的范围内）；
 * - `LEGEND_ROW_W = 210`：图例行（三类图例 + 间距）的保守估宽。
 *
 * 改这些数字必须同步改 `graphUxContract` 的行数预算 —— 判据只有一个来源。
 */

/** 每组最少占宽（px）。见文件头「宽度常量的依据」。 */
const MIN_GROUP_W = 78;
/** 面板近似可用宽度（px）。 */
const PANEL_W = 460;
/** 图例行保守估宽（px）。 */
const LEGEND_ROW_W = 210;

/** 工具栏结构读数（数据驱动，不是手写常量）。 */
export interface ToolbarDensity {
  /** 控件组总数（搜索 / 类型 / 裁决 / 缩放 / 辅助 / 视图 / 路径 —— 后两组条件性）。 */
  total: number;
  /** 其中**实际渲染**的组数（`view` / `path` 缺省不渲染）。 */
  rendered: number;
  /** 图例行是否渲染（角色图例要真实计数，零参调用没有）。 */
  legendRow: boolean;
}

/** 统计组件的最小形状（避免 import 整个 RenderProps 造成环）。 */
export interface ToolbarDensityInput {
  /** 视图组是否渲染（`view === undefined` 时不渲染）。 */
  hasView: boolean;
  /** 路径组是否渲染。 */
  hasPath: boolean;
  /** 角色图例是否渲染（`roles === undefined` 时不渲染）。 */
  hasRoleLegend: boolean;
}

/**
 * 统计工具栏组件数。
 *
 * 固定组 5 个（搜索 / 类型 / 裁决 / 缩放 / 辅助）+ 条件组（视图 / 路径）。
 * 为什么固定部分写成常量而不是靠扫元素树：元素树在渲染函数体里，本模块要能
 * **独立单测**（喂 `{hasView:true,hasPath:false,…}` 就得到答案，不必构造整棵代理树）。
 */
export function toolbarDensityOf(input: ToolbarDensityInput): ToolbarDensity {
  const total = 5 + (input.hasView ? 1 : 0) + (input.hasPath ? 1 : 0);
  return {
    total,
    rendered: total,
    legendRow: input.hasRoleLegend,
  };
}

/**
 * 估算工具栏占几行（保守**下界**）。
 *
 * 算法：把每组的保守最小宽度累加，超过 `PANEL_W` 就换行；图例行单独算一次宽度
 * （它 `marginLeft: 'auto'`，在容器放得下时与前一组并肩，放不下时才独占一行）。
 *
 * @returns 估算行数（≥ 1）
 */
export function estimateToolbarRows(density: ToolbarDensity): number {
  const groupsW = density.rendered * MIN_GROUP_W + Math.max(0, density.rendered - 1) * 6;
  let rows = Math.max(1, Math.ceil(groupsW / PANEL_W));
  if (density.legendRow) {
    // 图例行与前一组并肩的前提是"当行还剩 ≥ 图例宽度"；否则它自己占一行。
    const lastRowFill = groupsW % PANEL_W;
    const spare = lastRowFill === 0 ? PANEL_W : PANEL_W - lastRowFill;
    if (spare < LEGEND_ROW_W) rows += 1;
  }
  return rows;
}

/** 工具栏占行预算（**唯一**判据来源；契约从这里读，不另写数字）。 */
export const TOOLBAR_ROW_BUDGET = 2;

/**
 * 工具栏容器属性（含紧凑度读数锚点）。
 *
 * ## 为什么把容器属性放在本文件（而不是渲染文件里手写）
 *
 * 容器属性里有三件事必须**同源**：`role/label`（可访问性）、紧凑度读数（可断言证据）、
 * 布局样式（`flexWrap` 决定行数）。把它们散在渲染函数里，改一处忘另一处就会
 * 「读数说 2 行、实际折成 3 行」——而这正是本轮要消灭的那类无读数改动。
 * 放在本文件，`estRows` 与读数锚点由**同一次计算**产出。
 *
 * @param toolbarLabel `aria-label` 文案（由调用方经 `t()` 取得，本模块不碰 i18n）
 */
export function toolbarContainerAttrs(toolbarLabel: string, input: ToolbarDensityInput): Record<string, string> {
  const density = toolbarDensityOf(input);
  return {
    'data-anic-graph-toolbar': 'true',
    // 紧凑度读数进 DOM：契约据此断言"没超出预算行数"（视觉之外的可断言证据）。
    'data-anic-toolbar-groups': String(density.total),
    'data-anic-toolbar-est-rows': String(estimateToolbarRows(density)),
    role: 'toolbar',
    'aria-label': toolbarLabel,
  };
}
