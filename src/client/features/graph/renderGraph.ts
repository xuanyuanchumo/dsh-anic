/**
 * 纯渲染：工作流图数据 → SVG 元素树（M0-① 图区 + M3 三态色/FAIL 脉冲/节点点击）。
 *
 * 从 WorkflowGraphPanel.ts 提取（12 §3.1 特性模块制：单文件 ≤~250 行）。
 * smoke 直接断言此函数，不经 React 生命周期。
 *
 * ## cycle-82：布局从「数据自带坐标」改为「布局函数产出」
 *
 * 改造前节点的 x/y 直接来自快照（`snapshotCore.ts` 的 `x = 列号*380, y = 行号*46`），
 * 渲染层只做包围盒计算——于是渲染函数**被动继承**了那个 1520×5626 的长条。
 * 现在坐标由 `graphLayout.layoutGraph` 产出（分类型 lane + 均衡折列），本文件只消费。
 *
 * 为什么布局放在本函数**内部**而不是要求调用方先算好：本函数是纯的、无状态的、
 * 且被 smoke 直接调用（不经组件）。若要求外部先布局，smoke 与契约测试就得各自
 * 记得调用一次——两个调用点迟早有一个忘。放内部则"任何调用都得到同一张可读的图"。
 * 纯函数的好处正是：多算一次的代价是 O(n)，换来的是不可能忘。
 *
 * ## cycle-82：缩放/平移/筛选的三层职责切分
 *
 * - `graphViewport.ts`：算 `{scale, tx, ty}`，纯函数，无 DOM；
 * - `graphFilter.ts`：算每个节点该亮到什么程度，纯函数，无 DOM；
 * - **本文件**：只把上面两个结果拼进 props（`transform` / `opacity` / `pointer-events`）。
 *
 * 这样本文件仍是纯渲染（可被 smoke 断言），交互状态全部在 `GraphInteractive.ts` 里。
 *
 * 单节点/单边的元素构造在 `graphNodeRender.ts`（T3 行数纪律，界线是职责而非行数）。
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { token } from '../../../shared/tokens.ts';
import { FAIL_PULSE_STYLE } from './gateColors.ts';
import { graphKeyDown } from './graphKeyboard.ts';
import { renderGraphDataTable } from './graphDataTable.ts';
import { layoutGraph, type GraphLayout } from './graphLayout.ts';
import { visibilityOf, OPACITY, type FilterView } from './graphFilter.ts';
import { clampScale, transformOf, type Viewport, IDENTITY } from './graphViewport.ts';
import { renderArrowMarker, renderEdge, renderNode } from './graphNodeRender.ts';
import { t } from '../../i18n.ts';

export interface GraphData {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * 渲染选项（cycle-82）。全部可选 —— 不传时行为与改造前**逐字节等价**：
 * 恒等视口、无筛选视图（全亮）、无焦点。这条"零参调用仍可用"是 smoke 与
 * graphA11y 等既有契约不需要改的前提。
 */
export interface GraphRenderOptions {
  /** 缩放/平移（缺省恒等）。 */
  viewport?: Viewport;
  /** 筛选与邻接高亮（缺省全亮、无高亮）。 */
  filterView?: FilterView;
  /** 当前焦点节点 id（悬停/键盘聚焦），用于 `data-anic-focus` 标注。 */
  focusId?: string | null;
  /** 预计算的布局（组件层用 ref 缓存；缺省时本函数内部算一次）。 */
  layout?: GraphLayout;
  /**
   * 可视区像素尺寸（cycle-82 交互态）。缺省时退化为「画布 = 世界包围盒」，
   * 即改造前的行为。
   *
   * 为什么缩放态必须传它：若画布尺寸等于包围盒，把内容放大后**超出画布的部分
   * 会被 SVG 自己的视口裁掉**（不是被 CSS overflow 裁），用户放大就只看到中间一块。
   * 传了可视区尺寸后，画布 = 视口，`<g transform>` 缩放平移在画布内自由移动，
   * 裁剪只发生在 CSS 的 overflow:hidden 上——这才是"放大能看细节"的正确形态。
   */
  size?: { width: number; height: number };
  /**
   * 额外的键盘处理器（交互态的 +/−/0/Escape）。
   *
   * 为什么合并进 svg 的 onKeyDown 而不是给外层容器另挂一个：既有契约
   * （graphA11y / graphRoving）钉死「svg 是**唯一** Tab 停靠点，方向键 roving」。
   * 若外层再给一个 tabIndex，图区就变成两个停靠点，键盘用户要按两次 Tab 才能穿过
   * ——那正是 P1-2 花力气消灭的反模式。合并后停靠点仍只有一个，且缩放键
   * 与方向键共用同一焦点上下文（用户不用先"进入缩放模式"）。
   */
  keyHandler?: (ev: { key: string; preventDefault: () => void }) => void;
  /**
   * `aria-describedby` 指向的元素 id（键盘操作说明）。
   *
   * 说明必须挂在 **svg** 上：svg 是唯一 Tab 停靠点，AT 聚焦它时才会读 describedby；
   * 若挂在不可聚焦的外层容器上，屏幕阅读器用户永远听不到"+/−/0 能缩放"。
   */
  describedBy?: string;
}

/**
 * 把任意裁决拼写归一到 `VERDICT_SHAPE` 的键（转出口）。
 *
 * 实现已收敛到 `gateColors.ts` 的 `canonicalVerdict`（全仓唯一别名表）：
 * 填充色 / 线型字形 / 文本色三个消费面共用一份归一化，第三份映射的加入
 * 让"各持一份 + 测试对账"的模式走到了尽头——两份还能对账，三份必然漂移。
 * 本文件只转出（graphA11y.test.ts 从本文件导入 `verdictKey`），保持调用面不变。
 */
export { canonicalVerdict as verdictKey } from './gateColors.ts';

/**
 * 数据 → SVG 元素树。M3：三态色 + FAIL 脉冲 + 节点点击。
 *
 * @param verdicts nodeId → verdict（PASS/FAIL/doubt/pending/skip），来自 step-trace
 * @param onNodeClick 节点点击回调（面板传入以打开详情抽屉）
 * @param opts cycle-82 渲染选项（视口/筛选/焦点/预计算布局），缺省等价于改造前行为
 */
export function renderGraph(
  data: GraphData,
  verdicts?: Map<string, string>,
  onNodeClick?: (node: WorkflowNode) => void,
  opts?: GraphRenderOptions,
): ReactElement {
  const { nodes, edges } = data;
  /**
   * 两级"可交互"，**必须分开**：
   * - `clickable`：节点能被点（有 onNodeClick）→ 节点才拿 role=button/tabIndex/onKeyDown。
   *   没有回调却给 role=button，等于渲染 188 个"按了没反应"的按钮（比不渲染更糟）。
   * - `containerInteractive`：容器有键盘行为（roving 或 缩放键）→ role=group + tabIndex=0。
   *   交互态即使没有 onNodeClick 也有缩放/筛选，容器必须是可聚焦的组。
   *
   * 合并成一个布尔是本轮最容易犯的错：它会让 graphA11y 的「不可交互 → role=img」
   * 与"图区能缩放"两件事互相打架，而两边都只在特定断言下才暴露。
   */
  const clickable = onNodeClick !== undefined;
  const containerInteractive = clickable || opts?.keyHandler !== undefined;
  const viewport = opts?.viewport ?? IDENTITY;
  const filterView = opts?.filterView;
  const focusId = opts?.focusId ?? null;
  // 调用方没给布局时内部算（纯函数、确定性，多算一次只为"不可能忘"，见文件头）。
  const layout = opts?.layout ?? layoutGraph(nodes, edges);
  const bounds = layout.bounds;
  /** 布局后的位置索引（边端点查表；不重新 find，避免 O(E·N)）。 */
  const positionOf = new Map<string, { x: number; y: number }>(
    layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]),
  );

  const children: ReactElement[] = [
    // <desc> 必须先于图形内容（SVG a11y 树按文档顺序取第一个 desc）。
    createElement('desc', { key: 'graph-desc' }, t('panel.graphDesc')),
    createElement('style', { key: 'fail-pulse' }, FAIL_PULSE_STYLE),
    createElement('defs', { key: 'defs' }, renderArrowMarker()),
  ];

  // 边与节点全部塞进**唯一**的 <g>：缩放/平移只改这一个 transform，
  // 不给每条边各自算一遍坐标。这也是"单 svg + 单 transform"能被断言的形式。
  const worldChildren: ReactElement[] = [];

  for (const e of layout.edges) {
    // 边端点必须用**布局后**的坐标：`data.nodes` 存的是快照坐标，
    // 直接取 `a.x` 会画出改造前的长条——这是本轮最容易踩的一处。
    const pa = positionOf.get(e.from);
    const pb = positionOf.get(e.to);
    if (pa === undefined || pb === undefined) continue;
    worldChildren.push(
      renderEdge({
        from: e.from,
        to: e.to,
        fromPos: pa,
        toPos: pb,
        // 边跟着端点一起淡：只淡节点不淡边，会留下一团悬空线条，看起来像渲染 bug。
        // 取两端中**较亮**的那个：一端在焦点邻域里就该看得见这条关系。
        opacity: filterView === undefined
          ? undefined
          : Math.max(
              OPACITY[visibilityOf(e.from, filterView.matching, filterView.highlight)],
              OPACITY[visibilityOf(e.to, filterView.matching, filterView.highlight)],
            ),
      }),
    );
  }

  for (const n of layout.nodes) {
    worldChildren.push(
      renderNode({
        node: n,
        verdict: verdicts?.get(n.id) ?? n.result,
        visibility: filterView === undefined
          ? 'active'
          : visibilityOf(n.id, filterView.matching, filterView.highlight),
        focusId,
        interactive: clickable,
        onNodeClick,
      }),
    );
  }

  const world = createElement('g', {
    // 唯一的缩放/平移承载点。`data-anic-graph-world` 让测试能断言"确实是单 transform"
    // ——改造前每个节点各自 translate，缩放只能靠改 viewBox（视口裁剪不可控）。
    // key 必需：它是 `children.concat([world])` 这个**数组**里的成员，其余成员
    // （desc/style/defs）都有 key，独缺它 React 会报 "Each child in a list should
    // have a unique key" —— 而那条警告只在真挂载时出现，元素树断言看不见。
    key: 'graph-world',
    'data-anic-graph-world': 'true',
    transform: transformOf(viewport),
  }, worldChildren);

  // 两种画布形态，几何上都**无畸变**（viewBox 与画布像素 1:1），只是原点不同：
  // - 静态态（未传 size，测试/smoke 走这条）：画布 = 世界包围盒，viewBox 带包围盒
  //   原点（minX 为负，含 padding），与改造前的几何逐像素一致；
  // - 交互态（传了 size）：画布 = 可视区，viewBox = 0 0 W H，世界→屏幕**全部**
  //   由 `<g transform>` 表达。这样放大后超出视口的部分被裁掉是**正确行为**
  //   （视口的定义就是"能看到的那一块"），而不是被 svg 自己的宽高意外裁掉。
  const canvas = opts?.size === undefined
    ? { width: bounds.width, height: bounds.height, viewBox: [bounds.minX, bounds.minY, bounds.width, bounds.height].join(' ') }
    : { width: opts.size.width, height: opts.size.height, viewBox: `0 0 ${String(opts.size.width)} ${String(opts.size.height)}` };

  const svg = createElement('svg', {
    width: canvas.width,
    height: canvas.height,
    viewBox: canvas.viewBox,
    // P1-2/P1-3：容器是唯一 Tab 停靠点；role=group（可交互组）/ img（纯图）；
    // aria-label 携带规模信息（节点/边数），键盘操作说明在 <desc>。
    'data-anic-graph': 'true',
    // 当前比例进 DOM：比例读数是异步交互的结果，没有可断言的状态就只能靠肉眼。
    'data-anic-graph-scale': String(clampScale(viewport.scale)),
    // 包围盒进 DOM：布局压缩率是本轮验收线，测试直接读它，不必自己重算布局。
    'data-anic-graph-bounds': `${String(bounds.minX)} ${String(bounds.minY)} ${String(bounds.width)} ${String(bounds.height)}`,
    role: containerInteractive ? 'group' : 'img',
    tabIndex: containerInteractive ? 0 : undefined,
    'aria-label': t('panel.graphLabel', { nodes: nodes.length, edges: edges.length }),
    // 交互态才有关联的说明元素（静态态下没有那个 <p>，挂上去就是悬空引用）。
    'aria-describedby': opts?.describedBy,
    // 键盘：方向键 roving（graphKeyDown，既有契约）与交互态的 +/−/0/Escape
    // **合并到同一个 svg 处理器**。两个处理器作用键集不重叠（方向键 vs 缩放键），
    // 顺序上先跑 roving 再跑缩放——roving 对非方向键直接 return，不会误吞。
    onKeyDown: containerInteractive
      ? (ev: Parameters<typeof graphKeyDown>[0]) => {
          graphKeyDown(ev);
          opts?.keyHandler?.(ev);
        }
      : undefined,
    style: { background: token('anic-surface'), fontFamily: 'monospace', display: 'block' },
  }, children.concat([world]));

  // 等价数据表（P1-3）：屏幕阅读器的全量文本替代，视觉折叠（.anic-sr-only）。
  return createElement('div', { 'data-anic-graph-wrap': 'true' }, svg, renderGraphDataTable(data, verdicts));
}

/**
 * `buildVerdicts` 转出口（cycle-82 已拆到 `graphVerdicts.ts`，保持调用面不变）。
 *
 * 调用点（`panelSections.ts` 的 GraphSection、`graphA11y.test.ts`）从本文件导入，
 * 拆文件不该让它们全部改 import —— 转出口是最小扰动的做法，也让"trace → verdicts"
 * 的实现在一个地方可查。本仓 `tokens.ts` 转出 `shellTheme` 用的是同一形状。
 */
export { buildVerdicts } from './graphVerdicts.ts';
