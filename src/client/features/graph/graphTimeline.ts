/**
 * 时间轴回放（cycle-99 · 图谱交互增强 ④）——"逐轮演化"回放器。
 *
 * ## 缺陷（研究报告 ④ 实测）
 *
 * `evt:group-*` 是现成的 `event-seq` 链且 detail 首行带时间戳，但图只能静态
 * 全显——读者看不出"这批账本事件是怎么一轮轮长出来的"。
 *
 * ## 方案：纯函数计算「回放第 k 步的可见集」，复用 FilterView 的 opacity 通道
 *
 * - 回放第 k 步 = event-seq 链上**前 k+1 个** gate-event 组可见，其 evidences
 *   目标（门禁）也随之点亮——"筛选不删节点"纪律原样保留（节点/边全在 DOM，
 *   只是 opacity 退后），AT 可遍历性不变；
 * - 布局、数据面、既有契约（circle==节点数 / 单 svg / 边锚点计数）零变化；
 * - `prefers-reduced-motion` 下自动播放由组件层禁用（本文件只出纯函数）。
 *
 * ## 为什么回放只切 matching 集而不用独立渲染通道
 *
 * FilterView 已被 renderGraph 全链路消费（节点 opacity / 边取两端较亮 / 泳道
 * 表头 matching）。回放作为**又一层 FilterView 合成**（`composeWithTimeline`），
 * 与路径高亮（withPathHighlight）同构——多一个渲染通道就是多一个失效面。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import type { FilterView } from './graphFilter.ts';

/** 时间轴步描述：第 k 步对应哪个 event-seq 节点（含时间戳与摘要）。 */
export interface TimelineStep {
  /** event-seq 链上第 k 个节点的 id（`evt:group-N`）。 */
  nodeId: string;
  /** detail 首行时间戳（解析失败为 null——不猜具体时间）。 */
  at: string | null;
  /** 节点 label（工具栏步进器显示用）。 */
  label: string;
  /** 该步的裁决（result 字段原样，null = 无裁决）。 */
  result: string | null;
}

/** event-seq 链节点识别：type === 'gate-event'（assembleSnapshot 的链成员）。 */
function isSeqNode(n: WorkflowNode): boolean {
  return n.type === 'gate-event' && !n.id.startsWith('evt:folded');
}

/**
 * 从图数据提取时间轴（event-seq 链序 = 数组出现序，assembleSnapshot 保序）。
 * 返回空数组 = 无可回放链（时间轴控件整条不渲染）。
 */
export function buildTimeline(nodes: readonly WorkflowNode[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const n of nodes) {
    if (!isSeqNode(n)) continue;
    // detail 首行形如 "entries 214–218 (5 records), last 2026-10-30T00:32:27.290Z"
    const m = /last\s+(\S+)/.exec(n.detail ?? '');
    const at = m?.[1] ?? null;
    steps.push({
      nodeId: n.id,
      at: at !== null && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at : null,
      label: n.label,
      result: n.result ?? null,
    });
  }
  return steps;
}

/**
 * 回放第 k 步的可见集（纯函数，可单测）。
 *
 * 规则（三条，全部确定性）：
 * 1. 链上前 k+1 个 gate-event 可见；k 之后的事件 filtered（0.12 透明度）；
 * 2. 可见事件的 **evidences 目标**（门禁）随点亮——"证据支撑了哪个门"是
 *    回放的叙事本体；非 evidences 边不传播（cycle-seq/next 是时序，不该把
 *    "未来"点亮）；
 * 3. 无链数据 / 非 gate-event 节点（phase/gate/循环骨架）**永不** filtered
 *    ——回放的是账本事件流，生命周期骨架必须常亮做参照系。
 */
export function visibleSetAtStep(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  steps: readonly TimelineStep[],
  stepIndex: number,
): Set<string> {
  const visible = new Set<string>();
  // 3. 骨架常亮：非 gate-event 节点全部可见。
  for (const n of nodes) {
    if (!isSeqNode(n)) visible.add(n.id);
  }
  if (steps.length === 0 || stepIndex < 0) return visible;
  const k = Math.min(stepIndex, steps.length - 1);
  // 1. 前 k+1 个链节点可见。
  for (let i = 0; i <= k; i += 1) visible.add(steps[i]?.nodeId ?? '');
  // 2. 可见事件的 evidences 目标随点亮。
  const visibleEvents = new Set(steps.slice(0, k + 1).map((s) => s.nodeId));
  for (const e of edges) {
    if (e.type === 'evidences' && visibleEvents.has(e.from)) visible.add(e.to);
  }
  return visible;
}

/**
 * 把回放可见集**合成进**既有 FilterView（与 withPathHighlight 同构）。
 * 合成语义：既在原 matching 又在回放集 → active；否则退到 filtered。
 * 原视图的 highlight（邻接/路径高亮）保留——回放不覆盖观察模式。
 */
export function composeWithTimeline(
  base: FilterView,
  visible: ReadonlySet<string>,
): FilterView {
  const matching = new Set<string>();
  for (const id of base.matching) {
    if (visible.has(id)) matching.add(id);
  }
  // 原本 filtered 的节点保持 filtered（回放不放大任何东西——只收窄）。
  return { matching, highlight: base.highlight, active: true };
}
