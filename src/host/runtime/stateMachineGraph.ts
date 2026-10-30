/**
 * 工作流图的**依赖图构建**（cycle-91 拆分 · 守 T3 ≤250 行）。
 *
 * ## 为什么拆出去
 *
 * `stateMachineFields.ts` 回答「YAML 声明字段怎么被解析」；
 * 本文件回答「**解析出来的声明怎么变成依赖图**」。两者是不同问题：
 * 前者是**语法**（正则 + 字段），后者是**语义**（哪些边阻塞推进、
 * 环在哪里、环的入口是谁）。
 *
 * 混在一起时，「circuit-breaker 到底算不算前置条件」这个决策会
 * 藏在边类型的枚举旁边，看不出它与「环入口」判据是同一族决策。
 *
 * ## 边界
 *
 * 纯函数、零 IO：同输入必同输出（可复算）。
 */
import { tarjanScc } from './tarjanScc.ts';

/**
 * 判断一条边是否应计入**前驱依赖**（即"不完成它就推不动目标"）。
 *
 * ## 判据（cycle-91）
 *
 * | 边类型 | 计入依赖？ | 理由 |
 * |---|---|---|
 * | `human-gate` | ✅ | 人工门是**硬前置**：没走人审不能进下一阶段 |
 * | `gate-chain` | ✅ | 门禁链：上一道门过了才能进下一道 |
 * | `phase-transition` | ✅ | 相位切换的硬前置 |
 * | `micro-entry` | ✅ | 进入微观循环的入口 |
 * | `micro-exit` | ✅ | 微观循环退出 ⇒ 进入门禁 |
 * | `circuit-breaker` | ❌ | **失败分支**：它是"门禁失败 ⇒ 回退"的路径，**不是**"推进的前置" |
 * | `evidence` / 其它 | ❌ | 证据边是**引用关系**（A 引用 B 的产物），不是时序依赖 |
 *
 * ## 为什么 `circuit-breaker` 不能计入
 *
 * `gate-g0 → micro-eval`（circuit-breaker，fail）是"g0 失败 ⇒ 回退到评估"。
 * 若计入依赖 ⇒ `micro-eval` 要等 `gate-g0` done ⇒ 而 `gate-g0` 又要等
 * `micro-retro` done ⇒ 环 ⇒ **整条链死锁**（比现状更糟）。
 *
 * ## 为什么这是「fail-open」而不是「fail-closed」
 *
 * 把**没列入白名单**的边类型当作**非依赖**（放行）看起来像 fail-open，
 * 但在这里是**正确**的：
 * - 前驱依赖的语义是「**阻塞**」—— 依赖边会让推进**失败**；
 * - 引用关系（evidence）不该阻塞推进（g0 的证据来自 evt:group-*，
 *   那些是**别的** lane 的产物，不是 g0 的前置）；
 * - 若把非依赖边误判成依赖边 ⇒ 推进被无谓阻塞 ⇒ 功能不可用。
 *
 * ⇒ 这里的 fail-open 方向是「**少阻塞**」，与「门禁 fail-closed」不冲突。
 */
const DEPENDENT_EDGE_TYPES: ReadonlySet<string> = new Set([
  'human-gate',
  'gate-chain',
  'phase-transition',
  'micro-entry',
  'micro-exit',
]);

/** 该边类型是否计入前驱依赖。 */
export function isDependentEdgeType(type: string | undefined): boolean {
  // 无 type 的边（纯文本形态）**按依赖处理**——它通常就是主线。
  if (type === undefined || type === '') return true;
  return DEPENDENT_EDGE_TYPES.has(type);
}

/**
 * 把 `next:` 声明展开成**顺序边**，并**断开回环**（cycle-91 核心）。
 *
 * ## 为什么需要这一步（这是本轮最关键的设计决策）
 *
 * `next:` 声明的是「这个节点之后自然接哪个」，含两处**显式回环**：
 *
 * ```yaml
 * - id: maintain
 *   next: plan  # 回到 Plan，形成宏观循环
 * - id: micro-retro
 *   next: micro-eval  # 回到评估，形成微观循环
 * ```
 *
 * 若把这些边**原样**加进前驱依赖：
 * - `plan` 的依赖前驱包含 `maintain` ⇒ 要推进 plan 得先完成 maintain；
 * - `maintain` 的依赖前驱包含 `deploy` ⇒ …⇒ 绕一圈回到 plan ⇒
 *   **环上的每个节点都要求对方先完成** ⇒ 「所有前驱都 done」**永远无法满足**
 *   ⇒ 宏观循环**一次都推不动**（比现状更糟：现状至少 gate 链之外还能动）。
 *
 * ## 断环判据：**环入口**（entry point of the cycle）
 *
 * 一个回环 `A → B`（B 在 A 之前）应当被断开，当且仅当 **B 是该环的入口**：
 * 环的**起点**不是"从外部进入"的那一点。
 *
 * 本图的两个环：
 * - 宏观环：`plan → design → build → test → deploy → maintain → plan`
 *   ⇒ 入口 = `plan`（`plan` 的依赖前驱里没有来自环内的节点）；
 * - 微观环：`micro-eval → micro-plan → micro-task → micro-verify → micro-fix
 *   → micro-gate → micro-retro → micro-eval`
 *   ⇒ 入口 = `micro-eval`。
 *
 * ⇒ **断开指向入口的那条边**（`maintain → plan`、`micro-retro → micro-eval`），
 *   其余边保留 ⇒ 依赖图变成 **DAG** ⇒ 每个节点都有可满足的前驱序列。
 *
 * ## 为什么入口判据是**可计算的**而非硬编码
 *
 * 入口 = 「**没有任何来自环内的依赖前驱**」的节点。算法：
 * 1. 用 `next:` 展开出顺序边集合 `nextEdges`；
 * 2. 对顺序边做 **Tarjan SCC**（强连通分量）——每个 SCC 就是**一个环**
 *   （单点自环也算）；
 * 3. 对每个 SCC（大小 ≥ 2，或单点且有自环）：
 *   - 找出该 SCC 内**入度为 0** 的节点（相对 SCC 内部而言）⇒ 它就是**入口**；
 *   - 若有多个候选入口（多个源点）⇒ 取**字典序最小**的（确定性，可复算）；
 *   - 若没有候选入口（SCC 内每个节点都有入边 ⇒ 纯环）⇒ 取字典序最小节点；
 * 4. 断开所有「从 SCC 内某节点 → 该 SCC 入口」的 `next:` 边。
 *
 * ### 为什么用 Tarjan 而不是「拓扑排序找剩余节点」
 *
 * 拓扑排序会把**所有**环内节点都标为"在环上"，无法区分**入口**。
 * Tarjan 给出**极强连通分量**（每个环恰好一个分量），分量内的**源点**
 * 才是入口。Tarjan 是 O(V+E) 且确定性（按边插入序遍历）。
 *
 * ## 为什么不直接用 `on_pass` / `on_fail` 当依赖
 *
 * `on_pass:` / `on_fail:` 是**条件**后继（"通过后走 A，失败后走 B"），
 * 不是**前置条件**（"必须先完成 X"）。把条件后继当前置 ⇒ 门禁节点要求
 * 自己的后继先完成 ⇒ 又成环。
 *
 * ⇒ `on_pass`/`on_fail` 解析为**节点字段**（供图谱与门禁链分析），
 *   **不**进依赖图。
 */
export interface NextEdge {
  from: string;
  to: string;
  /** 边类型标记（区别于 `edges:` 段里的真实边，便于图谱区分来源）。 */
  type: 'next';
}

/**
 * 由 `next:` 字段展开顺序边（每节点至多一条）。
 *
 * @param nodes 节点表（读 `node.next`）
 */
export function expandNextEdges(nodes: readonly { id: string; next?: string }[]): NextEdge[] {
  const out: NextEdge[] = [];
  for (const n of nodes) {
    if (typeof n.next === 'string' && n.next !== '') out.push({ from: n.id, to: n.next, type: 'next' });
  }
  return out;
}

/**
 * 计算每个强连通分量的**入口节点**（环的起点）。
 *
 * @param comp      SCC 成员
 * @param edges     全部边（用于算分量内部的入度）
 * @returns 入口节点 id
 */
export function cycleEntryOf(
  comp: readonly string[],
  edges: readonly { from: string; to: string }[],
  declOrder?: (id: string) => number,
): string {
  const order = declOrder ?? ((id: string) => comp.indexOf(id));
  const inComp = new Set(comp);
  const hasIncoming = new Set<string>();
  for (const e of edges) {
    if (!inComp.has(e.from) || !inComp.has(e.to)) continue;
    if (e.from !== e.to) hasIncoming.add(e.to);
  }
  // 候选入口 = 分量内**无分量内前驱**的节点。
  const candidates = comp.filter((id) => !hasIncoming.has(id));
  // 兜底（纯环：每个节点都有分量内前驱 ⇒ 图论上无入口）：
  // 取**声明序最早**的节点——YAML 书写顺序 = 作者的阅读顺序 = 环的起点。
  // ⚠️ 不能用 comp 数组下标兜底：Tarjan 返回的分量顺序是**逆序**（弹出序），
  //   实测会选到 maintain 而非 plan ⇒ 断错边 ⇒ 依赖图仍有环。
  const pool = candidates.length > 0 ? candidates : [...comp];
  return [...pool].sort((a, b) => order(a) - order(b))[0] ?? (comp[0] ?? '');
}

export function buildDependentNextEdges(
  nodes: readonly { id: string; next?: string }[],
  edges: readonly { from: string; to: string }[],
): { from: string; to: string; type: 'next' }[] {
  const nextEdges = expandNextEdges(nodes);
  if (nextEdges.length === 0) return [];
  const nodeIds = nodes.map((n) => n.id);
  // 声明序映射（YAML 书写顺序 = 作者的阅读顺序 = 环起点的语义依据）。
  const declIndex = new Map<string, number>();
  nodes.forEach((n, i) => declIndex.set(n.id, i));
  const declOrder = (id: string): number => declIndex.get(id) ?? Number.MAX_SAFE_INTEGER;

  const sccs = tarjanScc(nodeIds, nextEdges);
  // 每个节点所在环的入口。
  const entryOfNode = new Map<string, string>();
  for (const comp of sccs) {
    const isSelfLoop = comp.length === 1 && nextEdges.some((e) => e.from === comp[0] && e.to === comp[0]);
    if (comp.length < 2 && !isSelfLoop) continue; // 非环
    const entry = cycleEntryOf(comp, nextEdges, declOrder);
    for (const id of comp) entryOfNode.set(id, entry);
  }
  // 断开「指向环入口」的 next 边（回环边）。
  const out: { from: string; to: string; type: 'next' }[] = [];
  for (const e of nextEdges) {
    const entry = entryOfNode.get(e.from);
    if (entry !== undefined && e.to === entry) continue; // 断开回环边
    out.push(e);
  }
  return out;
}
