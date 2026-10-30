/**
 * 流程归属量化条渲染契约（cycle-89）。
 *
 * ## 三条诚实渲染纪律
 *
 * 1. **取不到 ≠ 零**：字段缺失显示「—」，不显示 0% ——
 *    「归属率 0%」与「读不到归属率」在面板上必须可区分。
 * 2. **无数据即无条**：一条记录都没有 → 显示「暂无流程记录」，
 *    不渲染一张全是 0 的假表。
 * 3. **门禁证据按白名单校正**：非门禁脚本的记录不算证据。
 */
import { describe, expect, it } from 'vitest';
import { renderFlowMatrix } from '../../src/client/features/flows/renderFlowMatrix.ts';
import type { FlowMatrixJson } from '../../src/client/features/flows/flowMatrixTypes.ts';

/** 收集树中的全部文本。 */
function textsOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textsOf).join(' ');
  const el = node as { props?: Record<string, unknown>; type?: unknown };
  if (el.props === undefined) return '';
  const kids = el.props['children'];
  return textsOf(kids);
}

/** 收集带某锚点的节点。 */
function nodesWith(node: unknown, attr: string): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { props?: Record<string, unknown> };
    if (el.props === undefined) return;
    if (el.props[attr] !== undefined) out.push(n);
    walk(el.props['children']);
  };
  walk(node);
  return out;
}

describe('renderFlowMatrix：量化条渲染', () => {
  it('null 数据 → 不渲染（不画假表）', () => {
    expect(renderFlowMatrix(null)).toBeNull();
  });

  it('**无记录 → 如实空态**', () => {
    const el = renderFlowMatrix({ total: 0, metrics: {} });
    expect(el).not.toBeNull();
    expect(nodesWith(el, 'data-anic-flowmatrix')).toHaveLength(1);
    const anchor = nodesWith(el, 'data-anic-flowmatrix')[0] as { props: Record<string, unknown> };
    expect(anchor.props['data-anic-flowmatrix']).toBe('empty');
  });

  it('**有数据 → 渲染归属率 / 孤儿 / 相位 / 门禁四个度量**', () => {
    const data: FlowMatrixJson = {
      total: 10,
      metrics: {
        attributionRate: 0.8,
        orphans: 2,
        byPhase: { build: 6, test: 2 },
      },
      byGate: [{ key: 'G2', flows: [{ script: 'gate-check', gate: 'G2' }] }],
    };
    const el = renderFlowMatrix(data);
    expect(el).not.toBeNull();
    expect(nodesWith(el, 'data-anic-flowmatrix')).toHaveLength(1);
    const metrics = nodesWith(el, 'data-anic-flowmatrix-metric').map(
      (n) => (n as { props: Record<string, unknown> }).props['data-anic-flowmatrix-metric'],
    );
    expect(metrics).toContain('attribution');
    expect(metrics).toContain('orphans');
    expect(metrics).toContain('phases');
    expect(metrics).toContain('gates');
  });

  it('**归属率按百分比一位小数显示**', () => {
    const el = renderFlowMatrix({ total: 3, metrics: { attributionRate: 0.6667 } });
    expect(textsOf(el)).toContain('66.7%');
  });

  it('**字段缺失 → 显示「—」而非 0%**（取不到 ≠ 零）', () => {
    const el = renderFlowMatrix({ total: 3, metrics: {} });
    const txt = textsOf(el);
    expect(txt).toContain('—');
    expect(txt).not.toContain('0.0%');
  });

  it('**门禁证据按白名单校正**：非门禁脚本的门不进证据列表', () => {
    const el = renderFlowMatrix({
      total: 3,
      metrics: { attributionRate: 1 },
      byGate: [{ key: 'G3', flows: [{ script: 'workflow-state', gate: 'G3' }] }],
    });
    // G3 不该出现在门禁证据 chips 里。
    expect(nodesWith(el, 'data-anic-flowmatrix-gate')).toHaveLength(0);
  });

  it('门禁脚本的门**进**证据列表', () => {
    const el = renderFlowMatrix({
      total: 3,
      metrics: { attributionRate: 1 },
      byGate: [{ key: 'G2', flows: [{ script: 'gate-check', gate: 'G2' }] }],
    });
    const gates = nodesWith(el, 'data-anic-flowmatrix-gate');
    expect(gates).toHaveLength(1);
    expect((gates[0] as { props: Record<string, unknown> }).props['data-anic-flowmatrix-gate']).toBe('G2');
  });

  it('相位 chips 带可断言锚点', () => {
    const el = renderFlowMatrix({ total: 3, metrics: { byPhase: { build: 2 } } });
    const phases = nodesWith(el, 'data-anic-flowmatrix-phase');
    expect(phases).toHaveLength(1);
    expect((phases[0] as { props: Record<string, unknown> }).props['data-anic-flowmatrix-phase']).toBe('build');
  });
});
