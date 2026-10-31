/**
 * 节点角色（cycle-95 · WS-B）——「这个节点是什么角色」。
 *
 * ## 为什么需要角色（这是用户第三个真问题）
 *
 * 真实快照里 `wf:gate-g0` 有 8 条入边，而大多数门禁只有 1 条。**两者此前画得
 * 一模一样**：度是图的拓扑事实，但图上没有任何像素承载它。用户看不出「这是
 * 汇聚点」与「这是普通门禁」的区别，于是「它为什么重要」这个问题在图上无解。
 *
 * ## 四类角色 + null，判据必须写死成常量
 *
 *   hub    入度 ≥ `HUB_INDEGREE`（汇聚点：多个因都汇到它）
 *   orphan 入度 0 且出度 0（度 0 的标量节点，见下）
 *   entry  入度 0 且出度 > 0（因果链的起点）
 *   leaf   出度 0 且入度 > 0（因果链的终点）
 *   null   其余（中间节点：既是结果又是原因，**这不是缺陷**）
 *
 * 判据顺序是 hub → orphan → entry → leaf。hub 优先于 leaf 不是随意：一个
 * 入度 12 / 出度 0 的门禁事件**语义上是汇聚点**（12 条证据汇到它），画成
 * 「末端」会丢掉真正重要的信息。反过来若 leaf 优先，"多少因汇到我"这件事
 * 就从图上消失了。契约里有一条专门断言这个顺序。
 *
 * ## 为什么 orphan 必须**如实**存在，而不是被当成数据缺陷
 *
 * `aux:auto` 这类标量节点度 0。在「孤立节点 = 缺陷」的直觉下，它们看起来像
 * 数据清洗没做完（O-94-08 登记过这个误读）。但 aux 节点本来就不参与因果链：
 * 度 0 是它的**预期形态**。显式标注成 orphan 正好把它从"疑似缺陷"变成
 * "已知形态"——用户看到孤立角色就知道"这不是漏了边"，而不是去追一条不存在的边。
 *
 * ## 为什么第二参 `nodeIds` 是必需的（任务签名的诚实扩展）
 *
 * 孤立节点**永远不会出现在边集里**。只吃 edges 的函数在原理上判不出 orphan：
 * 它连这个节点存在都不知道。所以 `buildNodeRoles(edges, nodeIds?)` 的第二参
 * 不是可选优化，而是「orphan 判据能不能成立」的前提。缺省时退化为"只认边端点"
 * （此时 orphan 恒为 0，这是**诚实的退化**而不是假装判过）。
 *
 * ## 纯函数（零 DOM / 零 clock / 零 random）
 *
 * 与 `graphTrace` / `graphFilter` 同纪律：可在 node 环境逐条断言，同一份数据
 * 两次调用结果深相等。结果只依赖 (edges, nodeIds)。
 */
import type { WorkflowEdge } from '../../workflowGraphData.ts';

/** 节点角色；`null` = 中间节点（既非起点/终点/汇聚/孤立，属正常形态）。 */
export type NodeRole = 'entry' | 'orphan' | 'leaf' | 'hub' | null;

/** 角色计数（面板读数 / 契约断言用）。 */
export interface RoleStats {
  entry: number;
  orphan: number;
  leaf: number;
  hub: number;
  /** 参与判定的节点总数（含角色为 null 的中间节点）。 */
  total: number;
}

/**
 * hub 的入度阈值。
 *
 * 为什么是 8：真实快照（169 节点 / 217 边）的入度分布里 8 是明显的断点——
 * 低于它的节点入度集中在 1–3，8 以上只剩门禁事件与几个阶段推进点。阈值写成
 * 常量而不是散落的字面量，是为了让"什么算枢纽"可被机器审计（契约会断言
 * 恰好 8 入边的节点判 hub、7 入边的不判）。
 */
export const HUB_INDEGREE = 8;

/** 度统计的内部形状（不入公开面，避免消费者承担实现细节）。 */
interface Degrees {
  in: number;
  out: number;
}

/**
 * 从边集构建节点角色表。
 *
 * @param edges 真实边集（重复边只算一次度，与 `buildTraceAdjacency` 的去重口径一致）
 * @param nodeIds 可选：全部节点 id。**判 orphan 必需**（见文件头说明）。缺省时
 *   只认边端点，孤立节点不会被判出来（诚实退化）。
 */
export function buildNodeRoles(
  edges: readonly WorkflowEdge[],
  nodeIds?: readonly string[],
): Map<string, NodeRole> {
  const deg = new Map<string, Degrees>();
  /** 同一对端点重复出现时，度不能重复累加（重复边是数据形状，不是两条因果）。 */
  const pairs = new Set<string>();
  const touch = (id: string): Degrees => {
    const cur = deg.get(id);
    if (cur !== undefined) return cur;
    const fresh: Degrees = { in: 0, out: 0 };
    deg.set(id, fresh);
    return fresh;
  };
  for (const e of edges) {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    const key = `${e.from}\u0000${e.to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    touch(e.from).out += 1;
    touch(e.to).in += 1;
  }
  // 节点清单里的度 0 节点要**先**进表，否则下面的判据永远看不到它们。
  if (nodeIds !== undefined) for (const id of nodeIds) touch(id);

  const roles = new Map<string, NodeRole>();
  for (const [id, d] of deg) roles.set(id, classify(d));
  return roles;
}

/**
 * 度 → 角色（判据顺序见文件头；hub 最先，null 兜底）。
 *
 * 抽成独立导出函数是为了让契约能**直接喂度对**断言顺序，不必构造整张图。
 */
export function roleOfDegrees(inDeg: number, outDeg: number): NodeRole {
  return classify({ in: inDeg, out: outDeg });
}

function classify(d: Degrees): NodeRole {
  if (d.in >= HUB_INDEGREE) return 'hub';
  if (d.in === 0 && d.out === 0) return 'orphan';
  if (d.in === 0) return 'entry';
  if (d.out === 0) return 'leaf';
  return null;
}

/**
 * 角色统计。`total` = 被判定过的节点数（含 null）。
 *
 * 为什么 total 不排除 null：面板要显示"这个视图里我判了 169 个节点，其中 4 个
 * 是枢纽"——分母若只数非 null，读起来会像"整张图只有 20 个节点"，比不显示更误导。
 */
export function roleStatsOf(roles: ReadonlyMap<string, NodeRole>): RoleStats {
  const out: RoleStats = { entry: 0, orphan: 0, leaf: 0, hub: 0, total: 0 };
  for (const role of roles.values()) {
    if (role !== null) out[role] += 1;
    out.total += 1;
  }
  return out;
}

/** 取某节点的角色（未判定 → null，绝不抛）。 */
export function roleOf(roles: ReadonlyMap<string, NodeRole>, id: string): NodeRole {
  return roles.get(id) ?? null;
}
