/**
 * 边的元素序列（cycle-90 · 从 `renderGraph.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么单独成文件
 *
 * `renderGraph.ts` 的职责是「数据 → 布局 → 遍历产出元素集合」。边的产出是
 * 其中**最重的一块**（每条边要做：查表、追溯方向判定、双端可见度取大），
 * 它把主文件推到 257 行。拆开的界线是**职责**而不是行数：边有自己的语义
 * （方向、类型线型、追溯态、可见度传播），值得一个独立文件承载。
 *
 * ## 追溯方向为什么用**集合归属**而不是几何方向
 *
 * 上游边 = from 在 up 集合且 to 也在 up 或就是 root（链条朝 root 收敛）；
 * 下游边 = from 在 down 或就是 root，且 to 在 down（链条从 root 发散）。
 * 两边都满足（环）时按下游显示：环上「谁先谁后」本就无意义，给一个稳定取舍
 * 好过在两条规则间跳来跳去。
 *
 * ## 可见度取两端中**较亮**的那个
 *
 * 只淡节点不淡边，会留下一团悬空线条，看起来像渲染 bug。取两端中较亮的那个：
 * 一端在焦点邻域里就该看得见这条关系。
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowEdge } from '../../workflowGraphData.ts';
import { OPACITY, visibilityOf, type FilterView } from './graphFilter.ts';
import { renderEdge } from './graphNodeRender.ts';
import { traceRoleOf, type TraceResult } from './graphTrace.ts';

/** 边产出入参。 */
export interface EdgeRenderInput {
  edges: readonly WorkflowEdge[];
  /** 布局后位置索引（`id → {x,y}`；查表而非 find，避免 O(E·N)）。 */
  positionOf: ReadonlyMap<string, { x: number; y: number }>;
  filterView: FilterView | undefined;
  trace: TraceResult | undefined;
}

/** 边的追溯方向（'down' | 'up' | undefined）。 */
export type EdgeTrace = 'down' | 'up' | undefined;

/**
 * 判定一条边的追溯方向。
 *
 * 环上「谁先谁后」本就无意义，两条规则都满足时按下游显示 —— 给一个稳定取舍
 * 好过在两条规则间跳来跳去（后者会让边在用户眼前反复变色）。
 */
export function edgeTraceOf(trace: TraceResult | undefined, e: WorkflowEdge): EdgeTrace {
  if (trace === undefined || trace.root === null) return undefined;
  if (trace.down.has(e.to) && (trace.down.has(e.from) || trace.root === e.from)) return 'down';
  if (trace.up.has(e.from) && (trace.up.has(e.to) || trace.root === e.to)) return 'up';
  return undefined;
}

/** 产出全部边的元素（顺序 = 输入顺序，与边原样保留的不变量一致）。 */
export function renderEdges(input: EdgeRenderInput): ReactElement[] {
  const { edges, positionOf, filterView, trace } = input;
  const out: ReactElement[] = [];
  // 边流量编码（cycle-91）：预计算每个**目标节点**被多少条同类边支撑（O(E) 单遍）。
  // 只对「证据类」边有意义（cycle-seq 是时序，支撑数无意义）⇒ 其余类型不启用。
  const supportCounts = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'evidences') continue;
    supportCounts.set(e.to, (supportCounts.get(e.to) ?? 0) + 1);
  }
  for (const e of edges) {
    // 边端点必须用**布局后**的坐标：`data.nodes` 存的是快照坐标，
    // 直接取 `a.x` 会画出改造前的长条 —— 这是本模块最容易踩的一处。
    const pa = positionOf.get(e.from);
    const pb = positionOf.get(e.to);
    if (pa === undefined || pb === undefined) continue;
    out.push(renderEdge({
      from: e.from,
      to: e.to,
      // 边语义进渲染：六种边类型全部退化成无差别直线是 cycle-83 要修的缺陷。
      type: e.type,
      fromPos: pa,
      toPos: pb,
      // 支撑数（仅 evidences 边）⇒ 枢纽门禁的线更粗。
      support: e.type === 'evidences' ? (supportCounts.get(e.to) ?? 0) : undefined,
      // 边跟着端点一起淡：取两端中**较亮**的那个。
      opacity: filterView === undefined
        ? undefined
        : Math.max(
          OPACITY[visibilityOf(e.from, filterView.matching, filterView.highlight)],
          OPACITY[visibilityOf(e.to, filterView.matching, filterView.highlight)],
        ),
      ...(trace === undefined || trace.root === null
        ? {}
        : { trace: edgeTraceOf(trace, e) as 'down' | 'up' | undefined }),
    }));
  }
  return out;
}

/** 节点在追溯里的角色（供渲染层复用同一判定）。 */
export { traceRoleOf };
