/**
 * 时间轴回放契约（cycle-99 · 图谱交互增强 ④）——三块判据全部纯函数断言：
 * ① buildTimeline：event-seq 链提取 + detail 时间戳解析（坏戳如实 null）；
 * ② visibleSetAtStep：步 k 的可见集（骨架常亮 / 前缀链 / evidences 传播）；
 * ③ composeWithTimeline：与既有 FilterView 的合成语义（只收窄不放大）。
 * 渲染面（renderTimelineBar）在 graphExtras 内，锚点由 DOM 契约覆盖。
 */
import { describe, it, expect } from 'vitest';
import { buildTimeline, visibleSetAtStep, composeWithTimeline } from '../../src/client/features/graph/graphTimeline.ts';
import type { WorkflowEdge, WorkflowNode } from '../../src/client/workflowGraphData.ts';

const NODES: WorkflowNode[] = [
  { id: 'wf:gate-g0', type: 'gate', label: 'G0', x: 0, y: 0 },
  { id: 'wf:gate-g1', type: 'gate', label: 'G1', x: 0, y: 46 },
  { id: 'evt:group-1', type: 'gate-event', label: 'group 1: G0 PASS', x: 10, y: 0, result: 'PASS', detail: 'entries 1–2 (2 records), last 2026-11-01T10:00:00.000Z' },
  { id: 'evt:group-2', type: 'gate-event', label: 'group 2: G1 FAIL', x: 10, y: 46, result: 'FAIL', detail: 'entries 3–4 (2 records), last 2026-11-02T11:00:00.000Z' },
  { id: 'evt:folded', type: 'gate-event', label: 'folded', x: 10, y: -46, result: 'FOLDED', detail: 'windowed out' },
];

const EDGES: WorkflowEdge[] = [
  { from: 'evt:group-1', to: 'evt:group-2', type: 'event-seq' },
  { from: 'evt:group-1', to: 'wf:gate-g0', type: 'evidences' },
  { from: 'evt:group-2', to: 'wf:gate-g1', type: 'evidences' },
];

const STEPS = buildTimeline(NODES);

describe('cycle-99 时间轴回放', () => {
  it('① buildTimeline：提取链序节点（folded 排除），时间戳与裁决如实', () => {
    expect(STEPS.map((s) => s.nodeId)).toEqual(['evt:group-1', 'evt:group-2']);
    expect(STEPS[0]?.at).toBe('2026-11-01T10:00:00.000Z');
    expect(STEPS[0]?.result).toBe('PASS');
    // 坏/缺 detail → at=null（不猜时间）
    const bad = buildTimeline([{ id: 'evt:group-9', type: 'gate-event', label: 'g9', x: 0, y: 0, detail: 'no timestamp here' }]);
    expect(bad[0]?.at).toBeNull();
  });

  it('② 步 0：骨架常亮 + 链首可见 + 其 evidences 目标点亮；链尾 filtered', () => {
    const visible = visibleSetAtStep(NODES, EDGES, STEPS, 0);
    expect(visible.has('wf:gate-g0')).toBe(true);  // 骨架常亮
    expect(visible.has('evt:group-1')).toBe(true); // 链首
    expect(visible.has('wf:gate-g1')).toBe(true);  // evidences 目标（group-1 支撑 G1? 否——group-1→g0）
    expect(visible.has('evt:group-2')).toBe(false); // 链尾未到
  });

  it('② 传播语义：只沿 evidences 亮门禁，不沿 event-seq 把未来点亮', () => {
    const visible = visibleSetAtStep(NODES, EDGES, STEPS, 0);
    // group-1 的 evidences 目标是 g0（已亮）；group-2 没被点亮 ⇒ 它的 evidences 目标 g1
    // 也不该因传播亮——但 g1 是骨架本来就亮。用专门构造验证"不沿时序传播"：
    const nodes2: WorkflowNode[] = [
      { id: 'a', type: 'gate', label: 'A', x: 0, y: 0 },
      { id: 'e1', type: 'gate-event', label: 'e1', x: 10, y: 0, detail: 'last 2026-11-01T10:00:00.000Z' },
      { id: 'e2', type: 'gate-event', label: 'e2', x: 10, y: 46, detail: 'last 2026-11-02T10:00:00.000Z' },
    ];
    const edges2: WorkflowEdge[] = [{ from: 'e1', to: 'e2', type: 'event-seq' }];
    const steps2 = buildTimeline(nodes2);
    const v = visibleSetAtStep(nodes2, edges2, steps2, 0);
    expect(v.has('e1')).toBe(true);
    expect(v.has('e2')).toBe(false); // event-seq 不传播（时序 ≠ 因果）
  });

  it('② 末步：全链可见；空链/负步：只有骨架', () => {
    const full = visibleSetAtStep(NODES, EDGES, STEPS, STEPS.length - 1);
    expect(full.has('evt:group-2')).toBe(true);
    expect(full.has('wf:gate-g1')).toBe(true);
    const none = visibleSetAtStep(NODES, EDGES, [], 0);
    expect(none.has('evt:group-1')).toBe(false); // 无链 = 无事件可见
    expect(none.has('wf:gate-g0')).toBe(true);   // 骨架照常
  });

  it('③ composeWithTimeline：matching ∩ 回放集，highlight 原样保留', () => {
    const base = { matching: new Set(['a', 'b', 'c']), highlight: new Set(['b']), active: false };
    const composed = composeWithTimeline(base, new Set(['a', 'c']));
    expect([...composed.matching].sort()).toEqual(['a', 'c']);
    expect(composed.highlight).toBe(base.highlight); // 引用保留（不重建）
    expect(composed.active).toBe(true); // 回放本身是一种激活态
  });
});
