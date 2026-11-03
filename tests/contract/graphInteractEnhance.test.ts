/**
 * 图谱交互增强 ①②③ 契约（cycle-98）。
 *
 * 三件增强的判据各一条，全部纯渲染断言（不经 React 生命周期）：
 * ① 边命中层：edgeHits 打开 → 每条边带一层透明宽描边 overlay（独立锚点
 *    `data-anic-edge-hit`，不带 `data-anic-edge` ⇒ 既有边计数契约零变化），
 *    且 overlay 内嵌 `<title>`（语义提示）；关闭 → 元素树与改造前一致。
 * ② LOD 样式常量：文本含分档选择器与 reduced-motion 逃逸。
 * ③ 小地图裁决着色：verdicts 在场 → 缩略点 fill 取 gateFillOf（与主图同源）；
 *    缺省 → 灰点行为不变。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderEdges, edgeTraceOf } from '../../src/client/features/graph/graphEdgeRenderAll.ts';
import { renderEdgeHit, edgeLabelOf, EDGE_HIT_WIDTH } from '../../src/client/features/graph/graphEdgeHit.ts';
import { GRAPH_INTERACT_STYLE } from '../../src/client/features/graph/graphInteractStyle.ts';
import { renderMiniMap } from '../../src/client/features/graph/graphMiniMap.ts';
import { token } from '../../src/shared/tokens.ts';
import type { WorkflowEdge } from '../../src/client/workflowGraphData.ts';

/** 元素树遍历（props 断言用；只做浅收集）。 */
function walk(node: ReactElement, visit: (el: ReactElement) => void): void {
  visit(node);
  const children = (node.props as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const c of children) {
      if (c !== null && c !== undefined && typeof c === 'object') walk(c as ReactElement, visit);
    }
  } else if (children !== null && children !== undefined && typeof children === 'object') {
    walk(children as ReactElement, visit);
  }
}

const POSITION = new Map<string, { x: number; y: number }>([
  ['a', { x: 0, y: 0 }],
  ['b', { x: 200, y: 0 }],
  ['c', { x: 400, y: 0 }],
]);

const EDGES: WorkflowEdge[] = [
  { from: 'a', to: 'b', type: 'evidences' },
  { from: 'b', to: 'c', type: 'cycle-seq' },
];

const NODES = [
  { id: 'a', type: 'gate', label: 'G0', x: 0, y: 0, w: 90, h: 30 },
  { id: 'b', type: 'gate', label: 'G1', x: 200, y: 0, w: 90, h: 30 },
  { id: 'c', type: 'event', label: 'e1', x: 400, y: 0, w: 90, h: 30 },
];

function countAttr(els: ReactElement[], attr: string): number {
  return els.filter((e) => (e.props as Record<string, unknown>)[attr] !== undefined).length;
}

describe('cycle-98 图谱交互增强', () => {
  it('① edgeHits 关闭：元素树与改造前一致（无 overlay）', () => {
    const els = renderEdges({ edges: EDGES, positionOf: POSITION, filterView: undefined, trace: undefined });
    expect(els.length).toBe(2);
    expect(countAttr(els, 'data-anic-edge')).toBe(2);
    expect(countAttr(els, 'data-anic-edge-hit')).toBe(0);
  });

  it('① edgeHits 打开：每条边带命中层 overlay + title，且不污染 data-anic-edge 计数', () => {
    const els = renderEdges({
      edges: EDGES, positionOf: POSITION, filterView: undefined, trace: undefined, edgeHits: true,
    });
    expect(els.length).toBe(4);
    expect(countAttr(els, 'data-anic-edge')).toBe(2);
    expect(countAttr(els, 'data-anic-edge-hit')).toBe(2);
    // overlay 与可见边交错（可见边 i → overlay 2i+1）：绘制顺序保证 overlay 在上。
    expect((els[1]?.props as Record<string, unknown>)['data-anic-edge-hit']).toBe('evidences');
    // 命中区宽度是常量（0.25 倍缩放下仍有可命中区）。
    expect((els[1]?.props as Record<string, unknown>).strokeWidth).toBe(EDGE_HIT_WIDTH);
    // 语义提示：overlay 内嵌 <title>（AT 可读 + 系统悬停提示）。
    const titles: ReactElement[] = [];
    walk(els[1] as ReactElement, (el) => { if (el.type === 'title') titles.push(el); });
    expect(titles.length).toBe(1);
    expect(titles[0]?.props.children).toBe(edgeLabelOf('evidences'));
  });

  it('① 命中层锚点独立：data-anic-edge-hit 不携带 data-anic-edge（计数契约守卫）', () => {
    const hit = renderEdgeHit({ from: 'x', to: 'y', type: 'on-fail', d: 'M 0 0 L 1 1' });
    const props = hit.props as Record<string, unknown>;
    expect(props['data-anic-edge-hit']).toBe('on-fail');
    expect(props['data-anic-edge']).toBeUndefined();
    expect(props.stroke).toBe('transparent');
  });

  it('② LOD 样式：分档选择器 + reduced-motion 逃逸齐备', () => {
    expect(GRAPH_INTERACT_STYLE).toContain('data-anic-graph-scale="0.25"');
    expect(GRAPH_INTERACT_STYLE).toContain('data-anic-graph-scale="0.4"');
    expect(GRAPH_INTERACT_STYLE).toContain('[data-anic-edge-hit]:hover');
    expect(GRAPH_INTERACT_STYLE).toContain('prefers-reduced-motion');
  });

  it('③ 小地图：verdicts 在场按裁决色着色，缺省灰点行为不变', () => {
    const base = {
      nodes: NODES, bounds: { minX: 0, minY: 0, width: 500, height: 100 },
      viewport: { scale: 1, tx: 0, ty: 0 }, size: { width: 900, height: 560 }, focusId: null,
    };
    const without = renderMiniMap(base);
    const withV = renderMiniMap({ ...base, verdicts: new Map([['a', 'PASS'], ['b', 'FAIL']]) });
    const dotsW: ReactElement[] = [];
    const dotsO: ReactElement[] = [];
    walk(withV, (el) => {
      if ((el.props as Record<string, unknown>)['data-anic-graph-minimap-node'] !== undefined) dotsW.push(el);
    });
    walk(without, (el) => {
      if ((el.props as Record<string, unknown>)['data-anic-graph-minimap-node'] !== undefined) dotsO.push(el);
    });
    expect(dotsW.length).toBe(3);
    // 有裁决的节点取 gateFillOf（非灰），无裁决/缺省回落同 token('anic-text-faint')。
    expect((dotsW[0]?.props as Record<string, unknown>).fill).toBe(token('anic-gate-pass'));
    expect((dotsW[1]?.props as Record<string, unknown>).fill).toBe(token('anic-gate-fail'));
    expect((dotsW[2]?.props as Record<string, unknown>).fill).toBe((dotsO[2]?.props as Record<string, unknown>).fill);
    // 缺省：与旧实现同色（灰点）。
    expect((dotsO[0]?.props as Record<string, unknown>).fill).toBe(token('anic-text-faint'));
  });

  it('edgeLabelOf：登记类型有语义句，未登记类型不退化', () => {
    expect(edgeLabelOf('gate-chain')).toContain('G0');
    expect(edgeLabelOf('unknown-type-x')).not.toBe('');
  });

  it('edgeTraceOf 回归：无 trace 时恒 undefined（graphEdgeRenderAll 转出保活）', () => {
    expect(edgeTraceOf(undefined, EDGES[0] as WorkflowEdge)).toBeUndefined();
  });
});

// createElement 保活引用（walk 断言的元素都由它构造；避免 tsc noUnusedLocals 误报）。
void createElement;
