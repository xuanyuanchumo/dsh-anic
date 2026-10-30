/**
 * 路径追溯 + 搜索命中（cycle-84 · V 战线）——「这张图不能只用来瞄一眼」。
 *
 * ## 为什么需要追溯（这是 cycle-83 之后用户最直接的抱怨点）
 *
 * 真实快照有 169 个节点 / 217 条边。用户点开一个「门禁事件」节点后，真正想回答的
 * 是两个问题，而图区此前一个都答不了：
 *   ① 它是**因为什么**失败的？→ 沿入边向上游找（cycle / phase / gate）
 *   ② 它**影响了谁**？→ 沿出边向下游找（后续事件 / 循环状态）
 * 只靠"悬停高亮一跳邻居"（cycle-82）只能看到相邻一圈，链式因果（A→B→C）看不到。
 *
 * ## 语义：双向 BFS，**方向分开返回**
 *
 * 上游与下游必须是两个集合，不能合成"相关节点"：用户看到一圈高亮但分不清哪边是
 * 因、哪边是果，等于没答问题。故返回 `{ root, up, down }`，渲染层给两种不同描边
 * （上游冷色虚线、下游暖色实线），并在图例/提示里点名方向。
 *
 * ## 有界（深度上限）不是性能优化，是**正确性**
 *
 * 217 条边在密度高的图上双向可达体积接近全图。若追溯结果等于全图，高亮就退化成
 * "没有信息"（所有节点一样亮）。`MAX_TRACE_DEPTH = 3` 让结果停在"因果链的三跳内"：
 * 对 workflow 图，三跳已覆盖「事件 ← 门禁 ← 循环 ← 阶段」的完整解释链。
 * 触到上限时返回 `truncated: true` —— 诚实标注"还有更多"，而不是假装完整。
 *
 * ## 纯函数（零 DOM / 零 clock / 零 random）
 *
 * 与 `graphFilter` / `graphLayout` 同纪律：可在 node 环境逐条断言，且同一份数据
 * 两次调用深相等。追溯结果只依赖 (edges, rootId)。
 */
import type { WorkflowEdge } from '../../workflowGraphData.ts';

/** 追溯深度上限（见文件头「有界不是性能优化」）。 */
export const MAX_TRACE_DEPTH = 3;

export interface TraceResult {
  /** 追溯起点（null = 未启用追溯）。 */
  root: string | null;
  /** 上游（沿入边反向可达）——"我是因为什么"。不含 root 自身。 */
  up: ReadonlySet<string>;
  /** 下游（沿出边正向可达）——"我影响了谁"。不含 root 自身。 */
  down: ReadonlySet<string>;
  /** 是否因深度上限被截断（诚实标注，不伪造完整）。 */
  truncated: boolean;
}

export const EMPTY_TRACE: TraceResult = {
  root: null, up: new Set<string>(), down: new Set<string>(), truncated: false,
};

/** 邻接表：正向（出边）与反向（入边）各一份。 */
export interface TraceAdjacency {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
}

/** 从边集构建双向邻接表（同一对重复边只保留一次，避免 BFS 队列膨胀）。 */
export function buildTraceAdjacency(edges: readonly WorkflowEdge[]): TraceAdjacency {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const seen = new Set<string>();
  const push = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (list === undefined) map.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const e of edges) {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(forward, e.from, e.to);
    push(reverse, e.to, e.from);
  }
  return { forward, reverse };
}

/**
 * 以 rootId 为起点的双向有界 BFS。
 *
 * @param adjacency 预构建邻接表（组件层随 edges 引用缓存，见 GraphInteractive）
 * @param rootId 起点节点 id；空串/null → EMPTY_TRACE
 */
export function buildTrace(
  adjacency: TraceAdjacency,
  rootId: string | null | undefined,
  maxDepth = MAX_TRACE_DEPTH,
): TraceResult {
  if (rootId === null || rootId === undefined || rootId === '') return EMPTY_TRACE;
  const depth = Math.max(1, Math.min(MAX_TRACE_DEPTH, Math.floor(maxDepth)));
  const walk = (links: Map<string, string[]>): { set: Set<string>; truncated: boolean } => {
    const seen = new Set<string>();
    let frontier: string[] = [rootId];
    let truncated = false;
    for (let d = 0; d < depth; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of links.get(id) ?? []) {
          if (nb === rootId || seen.has(nb)) continue;
          seen.add(nb);
          next.push(nb);
        }
      }
      if (next.length === 0) break;
      frontier = next;
      // 最后一层仍能扩展 ⇒ 说明链比上限更长（下一跳未收进来）。
      if (d === depth - 1) {
        for (const id of next) {
          if ((links.get(id) ?? []).some((nb) => nb !== rootId && !seen.has(nb))) { truncated = true; break; }
        }
      }
    }
    return { set: seen, truncated };
  };
  const upWalk = walk(adjacency.reverse);
  const downWalk = walk(adjacency.forward);
  return {
    root: rootId,
    up: upWalk.set,
    down: downWalk.set,
    truncated: upWalk.truncated || downWalk.truncated,
  };
}

/** 单节点在追溯视图里的角色（渲染层据此给不同描边）。 */
export type TraceRole = 'root' | 'up' | 'down' | 'both' | null;

export function traceRoleOf(trace: TraceResult, id: string): TraceRole {
  if (trace.root === null) return null;
  if (trace.root === id) return 'root';
  const up = trace.up.has(id);
  const down = trace.down.has(id);
  if (up && down) return 'both';
  if (up) return 'up';
  if (down) return 'down';
  return null;
}

/**
 * 搜索命中：按 label / id 大小写不敏感包含匹配，返回**有界**结果。
 *
 * 为什么返回列表而不是只返回第一个：169 个节点里查 "gate" 会命中上百个，
 * 直接跳到第一个几乎肯定不是用户要的。列表让用户自己选（工具条只显示前 N 条 +
 * "共 M 条"），而"只跳第一个"是看似省事、实际让人反复重查的设计。
 *
 * 空查询 → 空数组（不是全量）：调用方据长度决定是否显示结果面板。
 */
export function matchNodes<T extends { id: string; label: string }>(
  nodes: readonly T[],
  query: string,
  limit = 8,
): { matches: T[]; total: number } {
  const q = query.trim().toLowerCase();
  if (q === '') return { matches: [], total: 0 };
  const hit: T[] = [];
  for (const n of nodes) {
    if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) hit.push(n);
  }
  const max = Math.max(1, Math.floor(limit));
  return { matches: hit.slice(0, max), total: hit.length };
}
