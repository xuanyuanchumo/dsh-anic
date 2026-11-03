/**
 * 筛选与邻接高亮（cycle-82 · G 战线）——纯函数，不产生 DOM，不删节点。
 *
 * ## 核心立场：筛选**不改变图的成员集合**
 *
 * 最直觉的做法是「筛掉的就别渲染了」，但本仓有两条硬不变量拦着：
 * `scripts/offline-smoke.mjs` 断言 `circle 数 == snapshot.counts.nodes`，
 * `tests/contract/graphInteractiveContract.test.ts` 同样钉死「188 个节点一个不少」。
 * 更本质的理由是**可访问性更好**：被筛掉的节点若从 DOM 消失，屏幕阅读器用户就
 * 再也遍历不到它们（AT 没有"淡出"这种概念，只有"存在"和"不存在"）。
 *
 * 所以本模块的输出是**一层可见性标注**：渲染层据此改 `opacity` 与
 * `pointer-events`，节点全在、边全在、等价数据表全在，只是视觉上退后。
 *
 * ## 三条语义决定（都写进测试）
 *
 * 1. **空筛选 = 全可见**。既没有类型选中、也没有裁决选中、也没有查询词时，
 *    不能返回空集——那会让首屏白屏。这是 `matchAll` 的默认态。
 * 2. **冲突取交集，不是并集**。类型选「gate」+ 裁决选「fail」= 失败的门禁，
 *    不是"所有门禁加上所有失败"。多条件同时激活时用户的心智就是收窄。
 * 3. **查询大小写不敏感，且同时匹配 id 与 label**。用户看到的是 label（「G0 评估收敛门」），
 *    想按 id 找时输入 `evt:12` 也必须命中——两者是不同的搜索意图，不能只支持一种。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';

/** 类型 chip 的输入：`Map<type, count>`，由数据现算（不硬编码类型表）。 */
export interface TypeCount {
  type: string;
  count: number;
}

export interface FilterState {
  /** 选中的类型（空数组 = 不按类型筛）。 */
  types: readonly string[];
  /** 选中的裁决（空数组 = 不按裁决筛）。归一后的规范键（pass/fail/...）。 */
  verdicts: readonly string[];
  /** 查询词（空串 = 不按文本筛）。 */
  query: string;
  /**
   * 选中的节点角色（cycle-100；空数组 = 不按角色筛）。规范键 entry/hub/leaf/orphan。
   *
   * 为什么是 FilterState 的第四维而不是独立开关：用户的心智是「图上多了一种
   * 收窄方式」，与类型/裁决/查询是**同一维度的并列取值**（交集语义一致）；
   * 独立开关会出现「类型筛选 × 角色筛选谁赢」的第二真相（与 graphAnomalyFilter
   * 复用 FilterState 的同一条裁决）。旧 FilterState 字面量没有该键 ⇒
   * `roles` 为 undefined ⇒ 视为不筛（向后兼容，旧测试/视图态存档零迁移）。
   */
  roles?: readonly string[];
}

export const EMPTY_FILTER: FilterState = { types: [], verdicts: [], query: '' };

/**
 * 节点裁决归一表。
 *
 * 这里**不复制** `gateColors.canonicalVerdict` 的实现，而是独立写一份最小映射——
 * 因为 gateColors 属于 Host 侧的语义（PASS/FAIL 五态），而筛选面需要的是
 * 「用户勾了哪些 chip 就保留哪些」，且要容忍 `PASS`/`pass`/`approve` 三种拼写。
 * 两份表若漂移会被 `graphFilter.test.ts` 的对账断言抓住（不是靠人记得）。
 */
export function verdictKeyOf(verdict: string | undefined): string {
  if (verdict === undefined || verdict === '') return 'none';
  const v = verdict.trim().toLowerCase();
  if (v === 'pass' || v === 'approve') return 'pass';
  if (v === 'fail' || v === 'reject') return 'fail';
  if (v === 'doubt') return 'doubt';
  if (v === 'pending') return 'pending';
  if (v === 'skip' || v === 'skipped') return 'skip';
  return 'none';
}

/**
 * 类型计数（chip 上的数字）。按出现顺序返回，不按字母序——
 * `phase` 排在 `gate-event` 前是因为读图时先看到阶段再看到事件，
 * chip 顺序与 lane 顺序一致会让「筛选面板」和「图」互相对得上。
 */
export function countTypes(nodes: readonly WorkflowNode[], order: readonly string[] = []): TypeCount[] {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const known = order.filter((t) => counts.has(t));
  const rest = [...counts.keys()].filter((t) => !order.includes(t)).sort();
  return [...known, ...rest].map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

/** 裁决计数（同样是 chip 上的数字；无裁决单列 `none`）。 */
export function countVerdicts(
  nodes: readonly WorkflowNode[],
  verdicts?: Map<string, string>,
): TypeCount[] {
  const order = ['pass', 'fail', 'doubt', 'pending', 'skip', 'none'];
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = verdictKeyOf(verdicts?.get(n.id) ?? n.result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.filter((k) => counts.has(k)).map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

/** 查询归一：去首尾空白 + 小写。空串（或纯空白）代表「未筛选」。 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 单节点是否命中**全部**激活条件（条件间取交集）。 */
export function nodeMatches(
  node: WorkflowNode,
  filter: FilterState,
  verdicts?: Map<string, string>,
  roleOfNode?: (id: string) => string | null | undefined,
): boolean {
  if (filter.types.length > 0 && !filter.types.includes(node.type)) return false;
  if (filter.verdicts.length > 0) {
    const key = verdictKeyOf(verdicts?.get(node.id) ?? node.result);
    if (!filter.verdicts.includes(key)) return false;
  }
  // 角色维（cycle-100）：filter.roles 非空时按节点角色收窄。roleOfNode 缺席 =
  // 调用方没接角色表 ⇒ 诚实退化（该条件当作「无节点命中」而不是「全命中」——
  // 假装全命中会让用户以为"角色筛选坏了"的图是完整图）。
  if (filter.roles !== undefined && filter.roles.length > 0) {
    if (roleOfNode === undefined) return false;
    const role = roleOfNode(node.id);
    if (role === null || role === undefined || !filter.roles.includes(role)) return false;
  }
  const q = normalizeQuery(filter.query);
  if (q !== '') {
    const label = node.label.toLowerCase();
    const id = node.id.toLowerCase();
    // id 与 label 任一命中即可：两个都是用户心里"这个名字"的载体。
    if (!label.includes(q) && !id.includes(q)) return false;
  }
  return true;
}

/** 匹配集合（渲染层据此决定谁"留在前景"）。 */
export function matchingNodes(
  nodes: readonly WorkflowNode[],
  filter: FilterState,
  verdicts?: Map<string, string>,
  roleOfNode?: (id: string) => string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) if (nodeMatches(n, filter, verdicts, roleOfNode)) out.add(n.id);
  return out;
}

/** 筛选是否有任何激活条件（用于「清空筛选」按钮的禁用态与 aria-pressed）。 */
export function isFilterActive(filter: FilterState): boolean {
  return filter.types.length > 0 || filter.verdicts.length > 0
    || (filter.roles !== undefined && filter.roles.length > 0)
    || normalizeQuery(filter.query) !== '';
}

/**
 * 邻接索引（无向 1 跳）：`id → Set<相邻 id>`。
 *
 * **无向**是刻意的：数据里边是有向的（`from → to`），但「高亮邻居」是阅读辅助，
 * 用户看向一个门禁节点时既关心它由哪些事件支撑（入边），也关心它指向哪个阶段
 * （出边）。只算出边会让 `evt:*` 这类只有入边的节点看起来"孤立"——而它们恰恰
 * 是图里数量最多的一类（122 个门禁事件）。
 *
 * 悬空边（端点不在节点集里）**跳过**而不是报错：布局是纯函数、不改拓扑，
 * 渲染层已有同样的跳过逻辑，两边一致才不会出现"高亮了不存在的节点"。
 */
export function buildAdjacency(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Map<string, Set<string>> {
  const known = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    if (e.from === e.to) continue; // 自环不进邻接集（高亮自己等于没高亮）
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }
  return adj;
}

/**
 * 1 跳邻接高亮集：焦点节点 **+ 它的邻居**。
 *
 * 焦点自己也算进来——否则"当前这个点"会和非邻接节点一样淡下去，
 * 用户失去"我在看哪个"的锚点。
 */
export function neighborhoodOf(
  focusId: string | null,
  adjacency: Map<string, Set<string>>,
): Set<string> {
  if (focusId === null) return new Set();
  const out = new Set<string>([focusId]);
  for (const nb of adjacency.get(focusId) ?? []) out.add(nb);
  return out;
}

/**
 * 单节点的最终视觉状态。
 *
 * 三档而不是两档，因为**筛选**与**邻接高亮**是两种不同的"淡"：
 * - `filtered`（被筛选排除）→ 最淡，且不可点（它已经不在当前语义子集里）；
 * - `dimmed`（在子集里，但不是当前焦点的邻居）→ 中等淡，**仍可点**（用户可能想顺着看过去）；
 * - `active`（命中筛选且属于高亮集）→ 全亮。
 *
 * 折叠成两档会让用户分不清"这东西不存在"与"这东西不是邻居"——两种状态
 * 需要不同的后续动作（前者要清筛选，后者只需移开鼠标）。
 */
export type NodeVisibility = 'active' | 'dimmed' | 'filtered';

export const OPACITY: Record<NodeVisibility, number> = { active: 1, dimmed: 0.35, filtered: 0.12 };

export function visibilityOf(
  nodeId: string,
  matching: ReadonlySet<string>,
  highlight: ReadonlySet<string>,
): NodeVisibility {
  if (!matching.has(nodeId)) return 'filtered';
  if (highlight.size === 0) return 'active';
  return highlight.has(nodeId) ? 'active' : 'dimmed';
}

/** 渲染层用的批量视图（一次算完，避免每个节点重复 set 查询）。 */
export interface FilterView {
  matching: Set<string>;
  highlight: Set<string>;
  active: boolean;
}

export function buildFilterView(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  filter: FilterState,
  focusId: string | null,
  verdicts?: Map<string, string>,
  roleOfNode?: (id: string) => string | null | undefined,
): FilterView {
  const matching = matchingNodes(nodes, filter, verdicts, roleOfNode);
  const highlight = focusId === null ? new Set<string>() : neighborhoodOf(focusId, buildAdjacency(nodes, edges));
  return { matching, highlight, active: isFilterActive(filter) };
}
