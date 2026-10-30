/**
 * 布局缓存的 hook 形态（cycle-90）——把「ref + 模式 + 纯函数」包起来。
 *
 * ## 为什么抽成 hook
 *
 * `GraphInteractive.ts` 在 cycle-90 前已 237 行（250 是机械硬限）。布局缓存的
 * ref 声明 + 模式 state + 调用共 11 行，全部是**样板**（没有一行交互逻辑），
 * 留在组件里只会挤占真正需要被读的位置。
 *
 * 为什么不是 `useMemo`：`scripts/offline-smoke.mjs` 的 React 桩只提供七个
 * API，**没有** `useMemo`（用了会在 smoke 里 TypeError，而 smoke 是唯一在
 * 「无宿主」条件下验证组件树能展开的层）。所以这里用 ref + 纯函数。
 *
 * ## 模式是缓存键的一部分
 *
 * 换布局模式必须重算布局（产物完全不同）。若缓存键只看 nodes/edges 引用，
 * 切模式会拿到**旧模式的布局** —— 而界面上却显示"紧凑"模式，图却没变。
 */
import { useRef, useState } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { layoutOf } from './graphCaches.ts';
import type { GraphLayout } from './graphLayout.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';

/** 布局缓存 hook 的返回值。 */
export interface LayoutCacheState {
  /** 当前布局（按当前模式算出来的）。 */
  layout: GraphLayout;
  /** 当前布局模式。 */
  mode: LayoutMode;
  /** 切换模式。 */
  setMode: (mode: LayoutMode) => void;
}

/**
 * 按引用缓存的布局（模式感知）。
 *
 * @param nodes 输入节点（引用变化 ⇒ 重算）
 * @param edges 输入边（引用变化 ⇒ 重算）
 */
export function useLayoutCache(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): LayoutCacheState {
  const cacheRef = useRef<{
    nodes: readonly WorkflowNode[];
    edges: readonly WorkflowEdge[];
    mode: LayoutMode;
    layout: GraphLayout;
  } | null>(null);
  const [mode, setMode] = useState<LayoutMode>('lane');
  const layout = layoutOf(nodes, edges, cacheRef, mode);
  return { layout, mode, setMode };
}
