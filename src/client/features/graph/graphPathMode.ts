/**
 * 路径选择模式（cycle-95 · WS-C）——「起点 → 终点 → 最短路径」的**纯状态机**。
 *
 * ## 为什么必须有模式，而不是点两下就出结果
 *
 * 用户点第一个节点的语义在两种模式下**完全不同**：
 * 平时 = "打开这个节点的详情"；找路径时 = "这是起点"。若不做模式，一次点击
 * 会同时触发两件不相干的事（抽屉弹出来 + 跑去算路径），而用户只想要后者。
 * 所以必须有一个**显式进入/退出**的模式，进入后点击语义整体改写 —— 与
 * `graphTrace`（双击进入追溯）同一条模式纪律：模式必须可见、必须可退。
 *
 * ## 为什么状态机做成纯函数
 *
 * "第一下设起点、第二下设终点、再点起点则清空" 这类三态转移是**最容易写错又
 * 最不容易测出**的地方：真挂组件测要模拟两次点击 + 断言结果节点色，
 * 而纯函数可以直接喂 (state, id) 断言下一状态。可访问性也依赖同一套转移
 * （键盘 Enter 与鼠标点击**必须**走同一个转移函数，否则键盘用户会得到
 * 一套不一样的行为）。
 *
 * ## 为什么结果不缓存在状态里
 *
 * 路径是 `(adjacency, from, to)` 的纯派生：缓存在 state 就多了一个"边变了但
 * 路径没重算"的失效面（数据 4s 一轮询，边集引用会换）。每次渲染现算一次
 * 双向 BFS —— 有界（`MAX_PATH_HOPS`）且只在两端都选定时才算，代价可忽略。
 *
 * ## 边界（诚实退化，不是"差不多"）
 *
 * 起点 === 终点 → `findPath` 返回 `length=0, found=true`，但**语义上不是路径**，
 * 面板应说"需要两个不同的节点"（`pathFindInvalid`），所以本模块把它记成
 * `duplicate` 而不是 `found`。
 */
import type { TraceAdjacency } from './graphTrace.ts';
import { buildTrace, blastRadiusStats, type BlastRadiusStats } from './graphTrace.ts';
import { findPath, findPathCandidates, MAX_PATH_HOPS, type PathResult } from './graphPathFind.ts';
import type { FilterView } from './graphFilter.ts';

/** 选择状态：`active` = 处于路径模式；`from`/`to` = 已选的端点。 */
export interface PathSelection {
  active: boolean;
  from: string | null;
  to: string | null;
}

/** 未进入模式、未选任何点（useState 初值必须自足可渲染）。 */
export const PATH_IDLE: PathSelection = { active: false, from: null, to: null };

/** 进入/退出模式。退出时**同时清掉端点**：下次进入不该带着上一轮的起点。 */
export function togglePathOf(sel: PathSelection): PathSelection {
  if (sel.active) return PATH_IDLE;
  return { active: true, from: null, to: null };
}

/** 退出模式（Escape 语义）。 */
export function pathExitOf(sel: PathSelection): PathSelection {
  return sel.active ? PATH_IDLE : sel;
}

/**
 * 在节点上"选一个点"（Enter / Space / 点击都走这里）。
 *
 * 转移：未选起点 → 设起点；再点**同一个**起点 → 清空起点（"我选错了"）；
 * 否则 → 设为终点。已选终点后再点第三个节点 → **重开场**（起点 = 该节点），
 * 而不是静默忽略：用户点了一下却什么都没发生，是"键位没反应"的观感。
 */
export function pathPickOf(sel: PathSelection, id: string): PathSelection {
  if (!sel.active) return sel;
  if (sel.from === null) return { active: true, from: id, to: null };
  if (sel.to === null) {
    return sel.from === id ? { active: true, from: null, to: null } : { active: true, from: sel.from, to: id };
  }
  // 两端都已有：再选一次 = 以新节点重新开始（保留模式，换一对端点）。
  return sel.from === id ? { active: true, from: null, to: null } : { active: true, from: id, to: null };
}

/**
 * 状态条该说什么（渲染层据此选文案键；`null` = 不在模式里，不渲染）。
 *
 * ## 为什么 `noPath` 必须拆成 `unreachable` 与 `tooLong`（cycle-96 修正）
 *
 * `findPath` 早已区分两种失败：
 *   - `reason === 'unreachable'` —— 图上**真的没有**这条路径（两块不连通）；
 *   - `reason` 点名上限（如 `no path within 6 hops`）—— 路径**可能存在**，只是超出预算。
 *
 * 但本类型把它们合并成一个 `noPath`。这是**信息在类型层丢失**：
 * 前者用户该做的是"换一对端点"，后者该做的是"提高跳数上限"。合并后
 * 两种完全不同的补救动作被渲染成同一句话 —— 用户只能靠猜。
 *
 * 判据（本仓既有教训「数据源 A 与视图 B 一致吗要用跨源对账」的同族）：
 * 视图层的失败分类**不得比数据层更粗**。`statusOf` 必须消费 `result.reason`，
 * 而不是只看 `found === false`。
 *
 * ## 第三种"没找到"：`reverseOnly`（cycle-109 · U4 ③）
 *
 * 有向图里"a 走不到 b"与"a 其实被 b 走到"是两个完全不同的结论：前者可能是
 * 因果方向反了（"它导致它" vs "它被它导致"），后者才是真的不连通。此前两者都
 * 报 `unreachable`，用户看到"不可达"就去换端点——而正确答案是**把端点对调**。
 *
 * 判据的边界（写死，不许含糊）：
 *   - 只有正向 `reason === 'unreachable'`（结构性不可达）才试反向。正向"超上限"
 *     说明那条路**真的存在**，只是太远；此时展示反向路径会把"太远"误报成
 *     "反向才通"——正是上一条纪律禁止的"视图比数据更粗"。
 *   - 反向也找不到 ⇒ 仍是 `unreachable`（两向都不通才是真的不连通）。
 */
export type PathStatus = 'pickStart' | 'pickEnd' | 'found' | 'unreachable' | 'tooLong' | 'duplicate' | 'reverseOnly';

/**
 * 把 `findPath` 的结果分类成视图状态（**唯一**分类点）。
 *
 * 这样"两种失败分得开"只在一个地方决定：渲染层、契约、面板读到的都是这一个答案。
 * 任何人在别处再写一次 `found === false ? 'noPath' : …`，就会重新把两类揉回去。
 */
export function classifyPathResult(result: PathResult): 'found' | 'unreachable' | 'tooLong' {
  if (result.found) return 'found';
  // `reason === 'unreachable'` 是**结构性不可达**；其余（点名上限）都归 tooLong。
  return result.reason === 'unreachable' ? 'unreachable' : 'tooLong';
}

/** 路径模式的完整读数（一次算完，渲染层只画）。 */
export interface PathModel {
  active: boolean;
  from: string | null;
  to: string | null;
  status: PathStatus;
  /** 找到的路径节点集（高亮用）；未找到为空集。 */
  highlight: ReadonlySet<string>;
  /** 跳数（未找到 = 0）。 */
  length: number;
  /** 起点的影响半径分档（起点已选时才有值）。 */
  blast: BlastRadiusStats | null;
  /** 原始的 findPath 结果（面板/契约可读 reason / path）。 */
  result: PathResult | null;
  /**
   * 候选路径（≤3，含第一条；found / reverseOnly 时非空，其余为空数组）。
   *
   * 为什么必填而不是可选：可选会让面板无法区分"没算过"与"只有一条"，
   * 于是要么静默漏渲染候选、要么渲染一个空列表占位（本仓零占位纪律不许）。
   */
  candidates: readonly PathResult[];
}

/** 不在模式里的空模型（**不共享可变 Set**，避免调用方误改）。 */
export function idlePathModel(): PathModel {
  return {
    active: false, from: null, to: null, status: 'pickStart',
    highlight: new Set<string>(), length: 0, blast: null, result: null, candidates: [],
  };
}

/**
 * 反向路径的翻转（节点序反转；`found` / `length` / `reason` 不变）。
 *
 * 为什么必须翻转再交给渲染层：高亮与状态文字都按"用户选的起点 → 终点"读。
 * 若把 `to → from` 的原始顺序直接塞进去，读者会以为高亮方向就是用户点选的顺序
 * ——而"因果方向"正是这个功能要说清的东西（见 PathStatus 的 reverseOnly 段）。
 */
function flippedOf(result: PathResult): PathResult {
  const flipped: PathResult = { found: result.found, path: [...result.path].reverse(), length: result.length };
  if (result.reason !== undefined) flipped.reason = result.reason;
  return flipped;
}

/**
 * 选择状态 → 读数（纯派生）。
 *
 * 影响半径只算**起点**：用户在这一步问的是"从这儿出发能影响多远"，
 * 终点的影响半径是另一个问题的答案（终点已在别处答过：双击追溯）。
 * 两边都算会让状态条变成一张小报表，没人读。
 *
 * @param sel 选择状态
 * @param adjacency 正/反邻接表（`buildTraceAdjacency` 产出，调用方按 edges 引用缓存）
 */
export function pathModelOf(sel: PathSelection, adjacency: TraceAdjacency): PathModel {
  if (!sel.active) return idlePathModel();
  const from = sel.from;
  const to = sel.to;
  const blast = from === null ? null : blastRadiusStats(buildTrace(adjacency, from));
  if (from === null) {
    return { active: true, from: null, to: null, status: 'pickStart', highlight: new Set<string>(), length: 0, blast: null, result: null, candidates: [] };
  }
  if (to === null) {
    return { active: true, from, to: null, status: 'pickEnd', highlight: new Set<string>(), length: 0, blast, result: null, candidates: [] };
  }
  // 两端相同：findPath 会返回 length=0 的"路径"，但那不是用户要的东西。
  if (from === to) {
    return { active: true, from, to, status: 'duplicate', highlight: new Set<string>(), length: 0, blast, result: null, candidates: [] };
  }
  const result = findPath(adjacency, from, to, MAX_PATH_HOPS);
  if (!result.found) {
    /*
     * 反向可达（cycle-109 · U4 ③）：只在**结构性不可达**时试。
     * 正向"超上限"意味着那条路真的存在，只是太远；此时给反向路径会把
     * "太远"误报成"反向才通"（视图比数据更粗）。理由全文见 PathStatus 段。
     */
    if (result.reason === 'unreachable') {
      const reversed = findPathCandidates(adjacency, to, from, 3, MAX_PATH_HOPS).map(flippedOf);
      const first = reversed[0];
      if (first !== undefined) {
        return {
          active: true, from, to, status: 'reverseOnly',
          highlight: new Set(first.path), length: first.length, blast, result: first, candidates: reversed,
        };
      }
    }
    // 失败分类走 `classifyPathResult`（**唯一**分类点）——不在此处重写判据，
    // 否则"不可达"与"超上限"又会在这里被揉回同一态（见 PathStatus 头注）。
    return { active: true, from, to, status: classifyPathResult(result), highlight: new Set<string>(), length: 0, blast, result, candidates: [] };
  }
  const candidates = findPathCandidates(adjacency, from, to, 3, MAX_PATH_HOPS);
  return {
    active: true, from, to, status: 'found',
    highlight: new Set(result.path), length: result.length, blast, result,
    // 候选必含首条（同一实现 ⇒ 第一条恒等于 result）；空数组只可能是实现漂移，
    // 此时退回 `[result]` 而不是渲染一个"有路径但没有候选"的矛盾读数。
    candidates: candidates.length === 0 ? [result] : candidates,
  };
}

/**
 * 把路径高亮并进筛选视图的 `highlight` 通道。
 *
 * 为什么复用 `highlight` 而不是新增一条渲染通道：渲染层（`renderGraph` /
 * `graphNodeCard` 属 WS-B 写域）对 `highlight` 已有完整的视觉语义
 * （命中 → 全亮、其余 → 中等淡且仍可点）。复用意味着**零新增渲染代码**，
 * 也就零新增"图例说一套、画的是另一套"的漂移面。
 *
 * 为什么是**替换**而不是求交：路径模式下用户要看的正是那条链，
 * 邻接高亮的 1 跳圈会把链外的节点也点亮，稀释掉唯一有用的信息。
 */
export function withPathHighlight(view: FilterView, highlight: ReadonlySet<string>): FilterView {
  if (highlight.size === 0) return view;
  return { matching: view.matching, highlight: new Set(highlight), active: view.active };
}
