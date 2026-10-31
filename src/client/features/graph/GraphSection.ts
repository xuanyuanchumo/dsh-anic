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
 *
 * ## 工作区标识从哪来（cycle-95 · O-94-03 接线）
 *
 * 分键视图态需要"当前是哪个项目"。**store 里没有** workspace 切片：cycle-89 的
 * 隔离把工作区留在 `WorkflowGraphPanel.ts` 的 `workspaceRef`（那是 ref 通道，
 * 不是 store 状态），而 `X-ANIC-Workspace` 只在请求头里往返。本轮不得改
 * `panelSections.ts` / `panelStore.ts` / `WorkflowGraphPanel.ts`（Lead 独占）。
 *
 * ⇒ 走**可选 prop 透传**：`workspace` 由装配层（`WorkflowGraphPanel`）若有则传入，
 * 缺省 `undefined`。缺省时 `useGraphViewState` 退化为"不记忆"——
 * 这是**诚实退化**，而不是把 `workspaceKeyOf(undefined)` 的 `__unknown__` 键
 * 当成一个真实分键（那会让两个都未识别的项目共用同一份视图，正是本功能要
 * 消灭的污染）。见 `useGraphViewState` 头注判据 3。
 */
import { createElement, memo, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import { buildVerdicts } from './renderGraph.ts';
import { GraphInteractive } from './GraphInteractive.ts';

const selGraph = (s: PanelState) => s.graph;
const selTrace = (s: PanelState) => s.trace;

interface GraphSectionProps {
  store: PanelDataStore;
  onNodeClick: (node: WorkflowNode) => void;
  /** 当前工作区（可选；缺省 ⇒ 视图态不记忆，见文件头）。 */
  workspace?: string;
}

function GraphSectionImpl({ store, onNodeClick, workspace }: GraphSectionProps): ReactElement {
  const graph = usePanelSlice(store, selGraph);
  const trace = usePanelSlice(store, selTrace);
  return createElement(GraphInteractive, {
    nodes: graph.nodes,
    edges: graph.edges,
    verdicts: buildVerdicts(trace),
    onNodeClick,
    // 显式传 `workspace`（可能是 undefined）：让"未学到工作区"这件事一路可见，
    // 而不是在装配层写成 `workspace ?? ''`（空串会让 workspaceKeyOf 也落到未知键，
    // 但语义上"空串"与"还没有"是两件事，本仓已用 UNKNOWN_WORKSPACE_KEY 区分）。
    workspace,
  });
}

/** 图区：订阅 graph + trace 两切片（verdicts 由 trace 派生）。 */
export const GraphSection = memo(GraphSectionImpl);
