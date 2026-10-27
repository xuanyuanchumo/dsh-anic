/**
 * 图区分区订阅薄组件（cycle-82 从 components/panelSections.ts 拆出）。
 *
 * ## 为什么单独一个文件
 *
 * `panelSections.ts` 是「十个分区的订阅薄层」聚合文件，加完 cycle-82 的图区注释后
 * 触到 T3 的 ≤250 行硬限（`truthAuditChecks` 的 MAX_FILE_LINES 会扫）。
 * 拆分的界线是**职责**而不是行数：本文件属于「图特性域」（与 GraphInteractive /
 * renderGraph 同目录同域），panelSections 继续作为聚合门面**再导出**
 * `GraphSection` —— 装配层（WorkflowGraphPanel）与契约测试的 import 路径零变更。
 *
 * ## 为什么交互状态不放在这里
 *
 * 本组件是 memo 的薄订阅层，把缩放/筛选状态放进来会让每次拖拽都触发一次
 * store 切片比较 + memo 包装的函数重入。状态住在 `GraphInteractive` 内部；
 * 本层 props 引用恒定（nodes/edges 引用来自 store 切片，verdicts 派生后稳定），
 * memo 拦截照常生效。
 *
 * `verdicts` 仍在此派生（`buildVerdicts(trace)`）：它是"数据 → 派生"的纯转换，
 * 与 graph 同属数据面；放进交互组件会让那个组件同时懂 store 形状与交互，两种职责。
 */
import { createElement, memo, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import { buildVerdicts } from './renderGraph.ts';
import { GraphInteractive } from './GraphInteractive.ts';

const selGraph = (s: PanelState) => s.graph;
const selTrace = (s: PanelState) => s.trace;

interface GraphSectionProps { store: PanelDataStore; onNodeClick: (node: WorkflowNode) => void; }

function GraphSectionImpl({ store, onNodeClick }: GraphSectionProps): ReactElement {
  const graph = usePanelSlice(store, selGraph);
  const trace = usePanelSlice(store, selTrace);
  return createElement(GraphInteractive, {
    nodes: graph.nodes,
    edges: graph.edges,
    verdicts: buildVerdicts(trace),
    onNodeClick,
  });
}

/** 图区：订阅 graph + trace 两切片（verdicts 由 trace 派生）。 */
export const GraphSection = memo(GraphSectionImpl);
