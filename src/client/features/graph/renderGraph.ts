/**
 * 纯渲染：工作流图数据 → SVG 元素树（M0-① 图区 + M3 三态色 + cycle-83 卡片/语义边/小地图）。
 *
 * 从 WorkflowGraphPanel.ts 提取（12 §3.1 特性模块制：单文件 ≤~250 行）。
 * smoke 直接断言此函数，不经 React 生命周期。
 *
 * ## 职责切分（cycle-83 重新划线）
 *
 * - `graphLayout.ts`：世界坐标（变尺寸卡片 + lane pitch）；
 * - `graphViewport.ts`：`{scale,tx,ty}` 的纯算术；
 * - `graphFilter.ts`：每个节点该亮到什么程度；
 * - `graphNodeRender.ts`（门面）→ `graphNodeCard` / `graphEdgeRender` / `graphNodeStyle`：
 *   单个节点 / 单条边的元素构成；
 * - `graphCanvas.ts`：这些元素**怎么装进一张 svg**（画布尺寸 / viewBox / role / 键盘 / 小地图）；
 * - **本文件**：数据 → 布局 → 遍历产出元素集合，再交给上面两层。
 *
 * 本文件仍是纯渲染（可被 smoke 断言），交互状态全部在 `GraphInteractive.ts`。
 *
 * ## 为什么布局既接受外部传入又在内部算一次
 *
 * 交互态用 ref 缓存布局（数据 tick 未变时复用，否则每次 2s 轮询都会重建 188 个
 * 节点的元素树）。但纯渲染路径（smoke / graphA11y）不应被迫先布局一次——要求
 * 外部先算好，两个调用点迟早有一个忘。所以缺省时内部算；纯函数多算一次 O(n)，
 * 换来"任何调用都得到同一张可读的图"。
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { FAIL_PULSE_STYLE } from './gateColors.ts';
import { GRAPH_INTERACT_STYLE } from './graphInteractStyle.ts';
import { renderGraphDataTable } from './graphDataTable.ts';
import { layoutGraph, type GraphLayout } from './graphLayout.ts';
import { visibilityOf, type FilterView } from './graphFilter.ts';
import { IDENTITY, transformOf, type Viewport } from './graphViewport.ts';
import { renderArrowMarker, renderNode } from './graphNodeRender.ts';
import { renderEdges } from './graphEdgeRenderAll.ts';
import { renderCanvas } from './graphCanvas.ts';
import { renderLaneHeaders } from './graphLaneHeader.ts';
import { traceDepthOf, traceRoleOf, type TraceResult } from './graphTrace.ts';
import { buildNodeRoles, roleOf, type NodeRole } from './graphNodeRole.ts';
import { t } from '../../i18n.ts';

export interface GraphData {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * 渲染选项（cycle-82 建立 · cycle-83 扩展）。全部可选 —— 不传时行为与改造前
 * **逐字节等价**：恒等视口、无筛选视图（全亮）、无焦点、无小地图。这条"零参调用
 * 仍可用"是 smoke 与 graphA11y 等既有契约不需要改的前提。
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
   * 即改造前的行为。小地图也只在这个字段存在时渲染（它需要屏幕坐标）。
   */
  size?: { width: number; height: number };
  /**
   * 额外的键盘处理器（交互态的 +/−/0/Escape）。
   *
   * 为什么合并进 svg 的 onKeyDown 而不是给外层容器另挂一个：既有契约
   * （graphA11y / graphRoving）钉死「svg 是**唯一** Tab 停靠点，方向键 roving」。
   * 若外层再给一个 tabIndex，图区就变成两个停靠点，键盘用户要按两次 Tab 才能穿过
   * ——那正是 P1-2 花力气消灭的反模式。
   */
  keyHandler?: (ev: { key: string; preventDefault: () => void }) => void;
  /**
   * 路径追溯视图（cycle-84）：root / up / down 三集合，来自 `graphTrace.buildTrace`。
   * 缺省 undefined = 未启用追溯（零行为变化）。
   */
  trace?: TraceResult;
  /** 双击节点进入该节点的上下游追溯（cycle-84）。缺省不挂处理器。 */
  onNodeTrace?: (node: WorkflowNode) => void;
  /**
   * 泳道表头（cycle-90）。
   *
   * 缺省 = **不渲染表头**（零参调用仍是改造前那张图）。存在时按布局算好的
   * `laneHeaders` 画 —— 渲染层不碰坐标（见 `graphLayout.ts` 头注）。
   */
  laneHeaders?: boolean;
  /**
   * `aria-describedby` 指向的元素 id（键盘操作说明）。
   *
   * 说明必须挂在 **svg** 上：svg 是唯一 Tab 停靠点，AT 聚焦它时才会读 describedby；
   * 挂在不可聚焦的外层容器上，屏幕阅读器用户永远听不到"+/−/0 能缩放"。
   */
  describedBy?: string;
  /**
   * 关闭节点角色标记（cycle-95）。缺省 false = 画角色。
   *
   * 为什么要留一个开关：角色标记是**新增视觉元素**，而 smoke / 导出 / 若干
   * 元素树断言按元素计数比对（rect/circle 不变量）。开关让"零参调用仍是旧图"
   * 这条既有纪律继续成立——需要角色时显式打开（交互态与面板默认打开）。
   */
  nodeRoles?: boolean;
  /** 边命中层（cycle-98）：缺省 false=旧元素树；交互态开 overlay（见 graphEdgeHit）。 */
  edgeHits?: boolean;
}

/**
 * 把任意裁决拼写归一到五态规范键（转出口）。
 *
 * 实现已收敛到 `gateColors.ts` 的 `canonicalVerdict`（全仓唯一别名表）：
 * 填充色 / 线型字形 / 文本色三个消费面共用一份归一化。`graphA11y.test.ts`
 * 从本文件导入 `verdictKey`，故保持这个转出口。
 */
export { canonicalVerdict as verdictKey } from './gateColors.ts';

/**
 * 数据 → SVG 元素树。M3：三态色 + FAIL 脉冲 + 节点点击。
 *
 * @param verdicts nodeId → verdict（PASS/FAIL/doubt/pending/skip），来自 step-trace
 * @param onNodeClick 节点点击回调（面板传入以打开详情抽屉）
 * @param opts cycle-82/83 渲染选项（视口/筛选/焦点/布局/尺寸），缺省等价于改造前行为
 */
export function renderGraph(  data: GraphData,
  verdicts?: Map<string, string>,
  onNodeClick?: (node: WorkflowNode) => void,
  opts?: GraphRenderOptions,
): ReactElement {
  const { nodes, edges } = data;
  /**
   * 两级"可交互"，**必须分开**：
   * - `clickable`：节点能被点 → 节点才拿 role=button/tabIndex/onKeyDown。
   *   没有回调却给 role=button，等于渲染 188 个"按了没反应"的按钮。
   * - `containerInteractive`：容器有键盘行为（roving 或缩放键）→ role=group + tabIndex=0。
   *   交互态即使没有 onNodeClick 也有缩放/筛选，容器必须是可聚焦的组。
   */
  const clickable = onNodeClick !== undefined;
  const containerInteractive = clickable || opts?.keyHandler !== undefined;
  const viewport = opts?.viewport ?? IDENTITY;
  const filterView = opts?.filterView;
  const focusId = opts?.focusId ?? null;
  const trace = opts?.trace;
  const onNodeTrace = opts?.onNodeTrace;
  const layout = opts?.layout ?? layoutGraph(nodes, edges);
  const bounds = layout.bounds;
  /**
   * 节点角色表（cycle-95）：按 edges + nodeIds 现算。
   *
   * 为什么在**这里**算而不是让调用方传：角色是纯数据事实（与追溯/筛选正交），
   * 让每个调用点各自算一次，迟早就有一个忘了算（这正是 graphLayout 头注里
   * "缺省时内部算一次"的同一条纪律）。O(E) 一次，169 节点可忽略。
   */
  const roles = opts?.nodeRoles === false
    ? new Map<string, NodeRole>()
    : buildNodeRoles(edges, nodes.map((n) => n.id));

  /** 布局后位置索引（边端点查表；不重新 find，避免 O(E·N)）。 */
  const positionOf = new Map<string, { x: number; y: number }>(
    layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]),
  );

  const children: ReactElement[] = [
    // <desc> 必须先于图形内容（SVG a11y 树按文档顺序取第一个 desc）。
    createElement('desc', { key: 'graph-desc' }, t('panel.graphDesc')),
    createElement('style', { key: 'fail-pulse' }, FAIL_PULSE_STYLE),
    createElement('style', { key: 'graph-interact' }, GRAPH_INTERACT_STYLE),
    createElement('defs', { key: 'defs' }, renderArrowMarker()),
  ];

  // 边与节点全部塞进**唯一**的 <g>：缩放/平移只改这一个 transform，
  // 不给每条边各自算一遍坐标。这也是"单 svg + 单 transform"能被断言的形式。
  const worldChildren: ReactElement[] = [];

  // 泳道表头（cycle-90）：**先画**（在卡片之下），否则表头会被卡片盖住。
  // 挂在 world 里 ⇒ 与它标注的卡片一起随缩放平移移动（固定在屏幕上会让
  // 表头指着别的列）。
  if (opts?.laneHeaders === true) {
    const laneCounts = new Map(layout.lanes.map((l) => [l.type, l.count]));
    worldChildren.push(...renderLaneHeaders({
      headers: layout.laneHeaders,
      counts: laneCounts,
      matching: filterView?.matching,
    }));
  }

  // 边（追溯/可见度见 graphEdgeRenderAll 头注；edgeHits 语义见该文件 edgeHits 注释）。
  worldChildren.push(...renderEdges({
    edges: layout.edges, positionOf, filterView, trace,
    ...(opts?.edgeHits === true ? { edgeHits: true } : {}),
  }));

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
        ...(trace === undefined ? {} : { trace: traceRoleOf(trace, n.id) }),
        ...(onNodeTrace === undefined ? {} : { onNodeTrace }),
        // 角色与追溯跳数（cycle-95）：角色是纯数据事实、跳数是追溯态读数。
        role: roleOf(roles, n.id),
        traceDepth: trace === undefined ? 0 : traceDepthOf(trace, n.id),
      }),
    );
  }

  const world = createElement('g', {
    // 唯一的缩放/平移承载点。`data-anic-graph-world` 让测试能断言"确实是单 transform"
    // ——改造前每个节点各自 translate，缩放只能靠改 viewBox（视口裁剪不可控）。
    // key 必需：它是 `children.concat([world])` 这个**数组**里的成员，其余成员
    // 都有 key，独缺它 React 会报 "Each child in a list should have a unique key"
    // —— 那条警告只在真挂载时出现，元素树断言看不见。
    key: 'graph-world',
    'data-anic-graph-world': 'true',
    // 顺序是 translate 再 scale（`graphInteractiveContract` ⑤ 逐字钉死）。
    transform: transformOf(viewport),
  }, worldChildren);

  return createElement(
    'div',
    { 'data-anic-graph-wrap': 'true' },
    renderCanvas({
      world, children, bounds, layout, viewport,
      size: opts?.size,
      containerInteractive,
      describedBy: opts?.describedBy,
      keyHandler: opts?.keyHandler,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      focusId,
      ...(verdicts === undefined ? {} : { verdicts }), // 小地图裁决着色（同源 verdicts）
    }),
    // 等价数据表（P1-3）：屏幕阅读器的全量文本替代，视觉折叠（.anic-sr-only）。
    renderGraphDataTable(data, verdicts),
  );
}

/**
 * `buildVerdicts` 转出口（cycle-82 已拆到 `graphVerdicts.ts`，保持调用面不变）。
 * 调用点（panelSections / graphA11y.test）从本文件导入，拆文件不改 import。
 */
export { buildVerdicts } from './graphVerdicts.ts';
