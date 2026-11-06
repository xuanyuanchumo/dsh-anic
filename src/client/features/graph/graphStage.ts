/**
 * 图区交互舞台（cycle-83 · V 战线）——把 tooltip / 小地图事件 / 悬停代理装进视口容器。
 *
 * ## 为什么单独成文件
 *
 * `GraphInteractive`（cycle-82 时 248 行）已贴着 250 行纪律。cycle-83 要给它加
 * 悬浮预览、小地图点击、面包屑三件事，**加不进去**。拆分的界线是职责：
 * 本文件负责「屏幕交互层怎么摆」（tooltip 挂在哪、小地图怎么接事件、悬停代理的
 * 委托规则），`GraphInteractive` 只剩「状态 → 舞台 props」的一层装配。
 *
 * ## 为什么 tooltip 延迟逻辑**不**抽成自定义 hook
 *
 * `graphInteractiveContract` ⑦ 的 stub-hooks 守卫按**固定文件名清单**扫源码，
 * 并把跨文件收集的自定义 hook 名当白名单。在新文件里定义 `useTooltipReveal(`
 * 会被判成"未列入允许集的 hook"，而 smoke 的 React 桩也只认七个内置 hook ——
 * 就算守卫放过它，smoke 里也会 TypeError。所以延迟逻辑内联在 `GraphInteractive.ts`
 * （那里已在扫描集内，且只用 useState/useEffect/useRef）。
 *
 * ## 为什么悬停代理挂在容器上而不是每个节点
 *
 * 188 个节点各挂一对 pointerenter/pointerleave = 376 个闭包，每次数据 tick 都要
 * 重建。外层一个代理靠事件冒泡覆盖全部节点，且**同时**拿到 pointerover 与 focus
 * 两条通道（键盘可达性就靠 focus 这一条，这是 a11y 硬要求而非加分项）。
 */
import { createElement, type ReactElement } from 'react';
import { renderTooltip, type TooltipModel } from './graphTooltip.ts';
import { minimapLocalPoint } from './graphMiniMap.ts';

/** 舞台里 tooltip 的当前状态（null = 不显示）。 */
export interface TooltipState {
  model: TooltipModel;
  at: { x: number; y: number };
}

export interface StageInput {
  /** renderGraph 产出的图（含 svg 与等价数据表）。 */
  graph: ReactElement;
  tooltip: TooltipState | null;
  /** 悬停/聚焦节点的 id（null = 无）。 */
  focusId: string | null;
  /** 钉住的节点（cycle-109 · U1；null = 未钉住）。 */
  pinnedId: string | null;
  /** 整个选中集（cycle-109 · U3；空数组 = 未多选）。 */
  selectedIds: readonly string[];
  onFocusNode: (id: string | null) => void;
  /** 小地图点击（**局部坐标**，未换算成世界坐标）。 */
  onMinimapClick: ((local: { x: number; y: number }) => void) | undefined;
  /** 小地图左上角在当前坐标系里的偏移（`translate(x,y)` 的两个数）。 */
  minimapOrigin: { x: number; y: number };
  dragging: boolean;
  /** Escape 清筛选（挂在容器上，确保焦点在任意子元素时都能响应）。 */
  onKeyDown: (ev: { key: string; preventDefault: () => void }) => void;
  /**
   * 双击空白处 → 适配视图（cycle-85）。
   *
   * 为什么必须判"空白"：节点上的双击已被**路径追溯**占用（cycle-84）。
   * 若不判目标，双击节点会同时触发"追溯 + 适配"，两个动作互相打断——
   * 用户看到的是图猛地缩放一下，然后又变了色，两个都没得到。
   */
  onBackgroundDoubleClick?: (() => void) | undefined;
}

/** 事件目标是否落在小地图内部（自身或任一后代带 `data-anic-graph-minimap`）。 */
export function insideMiniMap(
  target: { getAttribute?: (n: string) => string | null; parentElement?: unknown } | null | undefined,
): boolean {
  let cur: typeof target = target;
  let hops = 0;
  while (cur !== null && cur !== undefined && hops < 8) {
    const attr = cur.getAttribute?.('data-anic-graph-minimap');
    if (attr === 'true') return true;
    cur = cur.parentElement as typeof cur;
    hops += 1;
  }
  return false;
}

/**
 * 从事件目标向上找最近的 `data-anic-node`。
 *
 * 为什么不能直接读 `ev.target`：指针落在卡片内的 `<rect>`/`<text>` 上时 target
 * 是那个子元素，它没有 `data-anic-node`。向上找是最小且确定的规则（不用
 * `closest`：stub 环境不一定有它，朴素上溯纯函数可测）。
 */
export function nodeIdFromTarget(
  target: { getAttribute?: (n: string) => string | null; parentElement?: unknown } | null | undefined,
): string | null {
  let cur: typeof target = target;
  let hops = 0;
  while (cur !== null && cur !== undefined && hops < 8) {
    const id = cur.getAttribute?.('data-anic-node');
    if (typeof id === 'string' && id !== '') return id;
    cur = cur.parentElement as typeof cur;
    hops += 1;
  }
  return null;
}

export function renderStage(input: StageInput): ReactElement {
  const {
    graph, tooltip, focusId, pinnedId, selectedIds, onFocusNode, onMinimapClick, minimapOrigin, dragging, onKeyDown,
    onBackgroundDoubleClick,
  } = input;
  return createElement(
    'div',
    {
      'data-anic-graph-stage': 'true',
      // 舞台不可聚焦：图区唯一 Tab 停靠点是内部 svg（既有 graphA11y / graphRoving
      // 契约）。给它 tabIndex 会让图区变成两个停靠点。
      onKeyDown,
      // 悬停代理：一个外层处理覆盖全部节点（见文件头）。
      onPointerOver: (ev: { target?: unknown }) => {
        onFocusNode(nodeIdFromTarget(ev.target as Parameters<typeof nodeIdFromTarget>[0]));
      },
      onPointerOut: () => { onFocusNode(null); },
      // 双击空白 → 适配视图（节点双击归追溯，小地图双击不算"空白"）。
      onDoubleClick: (ev: { target?: unknown }) => {
        if (onBackgroundDoubleClick === undefined) return;
        const tgt = ev.target as Parameters<typeof nodeIdFromTarget>[0];
        if (nodeIdFromTarget(tgt) !== null) return;
        if (insideMiniMap(tgt)) return;
        onBackgroundDoubleClick();
      },
      // 键盘通道：focus 也触发预览（a11y 硬要求）。
      onFocusCapture: (ev: { target?: unknown }) => {
        onFocusNode(nodeIdFromTarget(ev.target as Parameters<typeof nodeIdFromTarget>[0]));
      },
      onBlurCapture: () => { onFocusNode(null); },
      // 小地图点击：只有落在小地图内部才跳转（点在图上应正常拖拽/点节点）。
      // 局部坐标 = 指针 − 舞台偏移 − 小地图偏移；舞台偏移在 jsdom 下为 0，
      // 在真机上必须减，否则面板一旦被放进滚动容器，点击就会偏一层。
      onMouseDown: (ev: {
        target?: unknown; clientX: number; clientY: number;
        currentTarget?: { getBoundingClientRect?: () => { left?: number; top?: number } };
      }) => {
        if (onMinimapClick === undefined) return;
        if (!insideMiniMap(ev.target as Parameters<typeof insideMiniMap>[0])) return;
        const rect = ev.currentTarget?.getBoundingClientRect?.();
        const point = minimapLocalPoint({ clientX: ev.clientX, clientY: ev.clientY }, rect);
        onMinimapClick({ x: point.x - minimapOrigin.x, y: point.y - minimapOrigin.y });
      },
      style: { position: 'relative', width: '100%', height: '100%', cursor: dragging ? 'grabbing' : undefined },
    },
    graph,
    tooltip === null ? null : renderTooltip({ model: tooltip.model, at: tooltip.at }),
    // 当前焦点进 DOM：状态是异步交互的结果，没有可断言的锚点就只能靠肉眼。
    createElement('span', {
      key: 'focus-flag',
      'data-anic-graph-focus': focusId ?? 'none',
      className: 'anic-sr-only',
    }, focusId ?? ''),
    /*
     * 选区集合进 DOM（cycle-109 · U1/U3）：钉住与多选都是**异步点击**的结果，
     * 而它们的视觉（描边加粗 / 高亮环）是 AT 读不到的通道。集合级读数必须有一个
     * 可断言的落点——否则"点了两下选中两个"只能靠肉眼看，契约无处落地。
     * 挂在舞台（而非 svg）里：svg 的子树只放图元，任何额外元素都会撞
     * 「单 svg + 每节点固定元素数」这条既有不变量。
     */
    createElement('span', {
      key: 'selection-flag',
      'data-anic-graph-pinned': pinnedId ?? 'none',
      'data-anic-graph-selected': selectedIds.join(' '),
      'data-anic-graph-selected-count': String(selectedIds.length),
      className: 'anic-sr-only',
    }, selectedIds.join(' ')),
  );
}
