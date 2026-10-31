/**
 * 路径状态条 + 影响半径读数（cycle-95 · WS-C）——两个**零占位**的读数条。
 *
 * ## 为什么路径模式必须有状态条
 *
 * 路径模式是**模式**：进入后节点的点击语义整体改写（点一下不再打开详情，而是
 * 设端点）。模式类交互的第一原则是"当前模式必须可见、必须可退"（与
 * `graphTraceBar` 同一条纪律），否则用户点了一个节点发现没弹抽屉、却不知道
 * 为什么，也找不到退出的入口。这条同时回答三件事：现在要你干什么（选起点 /
 * 选终点）、选完了吗（路径几跳 / 不可达 / 两端相同）、怎么退。
 *
 * ## 为什么影响半径要显示**选中节点**的
 *
 * `blastRadiusStats` 给出 1/2/3 跳各多少节点（"它炸了影响多远"）。追溯状态条
 * 已在"进入追溯"时显示过一次 —— 但用户在**进入追溯之前**就需要这个信号来
 * 决定值不值得追。选中（悬停/键盘聚焦）任何一个节点就给出读数，是"先读数、
 * 再决定"的顺序；反过来（先进入模式再看数）会让用户为了看一个数而先做一串动作。
 *
 * 读数只在**有选中节点**时出现；未选中时整条不渲染（零占位）。悬停触发的
 * O(E) 一次 BFS 由组件侧缓存邻接表摊薄，见 `useGraphInteraction`。
 *
 * ## 纯渲染（无 hook、无状态）
 *
 * 与 `renderTraceBar` / `renderBudget` 同纪律：调用方传状态与回调，本文件只出
 * 元素树。这样"选中节点 → 读到 d1/d2/d3"能直接喂数据断言，不必真挂组件。
 */
import { createElement, type ReactElement } from 'react';
import { blastRadiusStats, buildTrace, type BlastRadiusStats, type TraceAdjacency } from './graphTrace.ts';
import { MAX_PATH_HOPS } from './graphPathFind.ts';
import type { PathModel } from './graphPathMode.ts';
import { gt } from './graphText.ts';
import { t } from '../../i18n.ts';

/**
 * 选中节点的**双向**影响半径（null = 没有选中节点）。
 *
 * 为什么用 `buildTrace` 而不是另写一份 BFS：追溯的 up/down 语义与影响半径
 * 完全同义（沿入边是"因为什么"、沿出边是"影响了谁"），再写一份就是第二套
 * 真相 —— 而两份 BFS 的深度上限一旦漂移，读数与图上的描边就会互相矛盾。
 */
export function focusBlastOf(adjacency: TraceAdjacency, focusId: string | null): BlastRadiusStats | null {
  if (focusId === null || focusId === '') return null;
  return blastRadiusStats(buildTrace(adjacency, focusId));
}

/** 路径状态条要显示的文案（三种"还没结果"的状态各一句，理由见文件头）。 */
function statusTextOf(model: PathModel): string {
  switch (model.status) {
    case 'pickStart': return gt('pathPickStart');
    case 'pickEnd': return gt('pathPickEnd');
    case 'duplicate': return t('graph.pathFindInvalid');
    // 两种失败**必须分开说**：`unreachable` 该换端点，`tooLong` 该抬跳数上限。
    // 合并成一句会让两种完全不同的补救动作得到同样的提示 —— 等于没有提示。
    case 'unreachable': return t('graph.pathFindNoPath');
    case 'tooLong': return t('graph.pathFindTooLong', { hops: String(MAX_PATH_HOPS) });
    case 'found': return t('graph.pathFindResult', {
      hops: String(model.length),
      // 路径写进文本而不是只靠高亮：高亮在灰度/强制对比下会消失，文本不会。
      path: [...model.highlight].join(' → '),
    });
  }
}

/**
 * 路径模式状态条（`role=status`：AT 自动播报模式切换与结果）。
 *
 * `data-anic-graph-path-*` 锚点把"当前在选择什么"写进 DOM —— 状态是异步交互的
 * 结果，没有锚点就只能靠肉眼验收。
 */
export function renderPathBar(input: { model: PathModel; onExit: () => void }): ReactElement {
  const { model } = input;
  return createElement(
    'div',
    {
      key: 'path-bar',
      'data-anic-graph-path-bar': 'true',
      'data-anic-graph-path-status': model.status,
      'data-anic-graph-path-from': model.from ?? 'none',
      'data-anic-graph-path-to': model.to ?? 'none',
      'data-anic-graph-path-length': String(model.length),
      role: 'status',
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        fontSize: 10.5, padding: '2px 8px',
      },
    },
    createElement('span', { key: 'label', 'data-anic-graph-path-label': 'true' }, statusTextOf(model)),
    // 起点的影响半径：选好起点后"从这儿出发能波及多远"是下一步决定的依据。
    model.blast === null || model.blast.down.total === 0
      ? null
      : createElement('span', { key: 'blast', 'data-anic-graph-path-blast': 'true' },
          t('graph.traceDown', { count: String(model.blast.down.total) })),
    createElement('button', {
      key: 'exit', type: 'button', 'data-anic-graph-path-exit': 'true',
      'aria-label': t('graph.pathFind'),
      onClick: input.onExit,
      style: {
        fontSize: 10, padding: '0 8px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid currentColor', background: 'transparent',
      },
    }, gt('pathExit')),
  );
}

/** 单方向的分档读数（形如「1 跳 2 · 2 跳 1 · 3 跳 0」）。 */
function blastTextOf(b: BlastRadiusStats['up']): string {
  return [1, 2, 3]
    .map((d) => `${t('graph.traceDepth', { depth: String(d) })} ${String(d === 1 ? b.d1 : d === 2 ? b.d2 : b.d3)}`)
    .join(' · ');
}

/**
 * 影响半径读数条（选中节点时才有；两个方向各一行，见文件头）。
 *
 * 为什么 up 与 down **都**显示：追溯状态条只在进入模式后显示，而这里回答的是
 * "这个节点在整张图里什么位置" —— 只显示一侧会让"只会影响下游"的节点与
 * "被很多上游支撑"的节点读起来一样。
 */
export function renderBlastBar(input: { focusId: string; blast: BlastRadiusStats }): ReactElement {
  return createElement(
    'div',
    {
      key: 'blast-bar',
      'data-anic-graph-blast': 'true',
      'data-anic-graph-blast-for': input.focusId,
      'data-anic-graph-blast-up-d1': String(input.blast.up.d1),
      'data-anic-graph-blast-up-d2': String(input.blast.up.d2),
      'data-anic-graph-blast-up-d3': String(input.blast.up.d3),
      'data-anic-graph-blast-down-d1': String(input.blast.down.d1),
      'data-anic-graph-blast-down-d2': String(input.blast.down.d2),
      'data-anic-graph-blast-down-d3': String(input.blast.down.d3),
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        fontSize: 10, padding: '0 8px', opacity: 0.9,
      },
    },
    createElement('span', { key: 'up', 'data-anic-graph-blast-up': 'true' },
      `${t('graph.traceUp', { count: String(input.blast.up.total) })} ${blastTextOf(input.blast.up)}`),
    createElement('span', { key: 'down', 'data-anic-graph-blast-down': 'true' },
      `${t('graph.traceDown', { count: String(input.blast.down.total) })} ${blastTextOf(input.blast.down)}`),
  );
}

/**
 * 两条读数条的合并入口（组件只调一次 ⇒ 组件少两行，而 250 行是硬限）。
 *
 * 两者都为 null（未进入路径模式且没有选中节点）→ **整体不渲染**（零占位）。
 */
export function renderGraphExtras(input: {
  path: PathModel;
  focusId: string | null;
  blast: BlastRadiusStats | null;
  onPathExit: () => void;
}): ReactElement[] | null {
  const items: ReactElement[] = [];
  /*
   * 两条都带显式 key（各自元素的 props 里）：返回值是一个**数组**，调用方直接
   * 塞进父元素的 children。数组元素缺 key 会让 React 每次重渲报
   * "unique key prop" 警告 —— 在真实宿主是控制台噪声，在测试里会污染每条
   * DOM 断言的 stderr（实测：本文件首次落地的 6 条用例全部出现了该警告）。
   */
  if (input.path.active) items.push(renderPathBar({ model: input.path, onExit: input.onPathExit }));
  if (input.focusId !== null && input.blast !== null) {
    items.push(renderBlastBar({ focusId: input.focusId, blast: input.blast }));
  }
  return items.length === 0 ? null : items;
}
