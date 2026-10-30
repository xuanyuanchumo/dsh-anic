/**
 * 图区引用键缓存（cycle-84 从 graphInteractiveParts 拆出）——纯函数，无 hook。
 *
 * ## 为什么是"手写 ref 缓存"而不是 `useMemo`
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供七个 API（无 `useMemo`）。
 * 图区每次数据 tick 都会拿到**同一引用**的 nodes/edges（快照对象稳定），
 * 所以"引用做键"的记忆化既满足语义，又不触碰 stub 的禁区。
 * 三个缓存共用一个形状：`{ key, value }` 挂在调用方的 ref 上。
 *
 * ## 为什么单独成文件
 *
 * `graphInteractiveParts` 在 cycle-84 到 253 行（250 行纪律是 `truthAuditChecks`
 * 的机械扫描项）。缓存的语义是"记住上一次计算结果"，与"把状态摆成 props"
 * 是两件事——按职责拆，而不是按行数硬切。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { buildAdjacency } from './graphFilter.ts';
import { layoutGraph, type GraphLayout } from './graphLayout.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import { buildTraceAdjacency, type TraceAdjacency } from './graphTrace.ts';

/** 邻居数表缓存（预览卡要显示"几条关系"）。 */
export function adjacencyOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  cache: { current: { key: readonly WorkflowNode[]; map: Map<string, Set<string>> } | null },
): Map<string, Set<string>> {
  const hit = cache.current;
  if (hit === null || hit.key !== nodes) {
    cache.current = { key: nodes, map: buildAdjacency(nodes, edges) };
  }
  return (cache.current as { map: Map<string, Set<string>> }).map;
}

/**
 * 布局缓存（引用做键）。
 *
 * 169 节点布局约 0.1ms，本身不贵；但**引用不稳定**会让下游元素树每次全部重建，
 * 在 2s 轮询的数据 tick 下就是持续抖动。
 *
 * 布局模式（cycle-90）也是键的一部分：换了模式必须重算（布局产物完全不同）。
 */
export function layoutOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  cache: {
    current: {
      nodes: readonly WorkflowNode[];
      edges: readonly WorkflowEdge[];
      mode: LayoutMode;
      layout: GraphLayout;
    } | null;
  },
  mode: LayoutMode = 'lane',
): GraphLayout {
  if (!sameLayoutKey(cache.current, nodes, edges, mode)) {
    cache.current = { nodes, edges, mode, layout: layoutGraph(nodes, edges, { mode }) };
  }
  const hit = cache.current;
  if (hit === null) throw new Error('layout cache invariant: unreachable');
  return hit.layout;
}

/** 布局缓存键：两个数组引用与模式都没变 ⇒ 可复用上一次布局。 */
export function sameLayoutKey(
  a: { nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[]; mode?: LayoutMode } | null,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  mode: LayoutMode = 'lane',
): boolean {
  if (a === null) return false;
  const prevMode = a.mode ?? 'lane';
  return a.nodes === nodes && a.edges === edges && prevMode === mode;
}

/** 追溯用双向邻接表缓存（cycle-84；edges 引用变化才重建）。 */
export function traceAdjacencyOf(
  edges: readonly WorkflowEdge[],
  cache: { current: { key: readonly WorkflowEdge[]; adj: TraceAdjacency } | null },
): TraceAdjacency {
  const hit = cache.current;
  if (hit === null || hit.key !== edges) {
    cache.current = { key: edges, adj: buildTraceAdjacency(edges) };
  }
  return (cache.current as { adj: TraceAdjacency }).adj;
}
