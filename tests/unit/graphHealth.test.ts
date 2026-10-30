/**
 * 图节点的**健康度编码**契约（cycle-91）。
 *
 * ## 为什么钉这个（本轮实测缺口）
 *
 * `WorkflowNode.testReport` 携带 `{ passed, failures, errors, layers }` ——
 * 这是**图上最值钱的信号**，但此前它**只出现在节点详情抽屉**里，
 * **图上一个像素都没占**。
 *
 * ⇒ 用户要判断"哪个门禁的测试在红"，必须逐个点开节点（35 节点图上不可用）。
 *
 * ## 三条诚实边界（判据的核心）
 *
 * 1. **无 testReport ⇒ 不画**（不是画"0 失败"）：`null` 与 `0` 是两件事。
 * 2. **分母为 0 ⇒ 失败率不可判定**（不是 0）：`passed=0,failures=0,errors=0`
 *    意味着"没有用例"，失败率**无定义**。
 * 3. **颜色不是唯一通道**：数字同时进 meta 行的**文字**（WCAG 1.4.1）。
 */
import { describe, expect, it } from 'vitest';
import {
  healthOf,
  healthSegments,
  healthSummaryText,
  supportCountOf,
  supportWidth,
  supportWidthOf,
} from '../../src/client/features/graph/graphHealth.ts';
import type { WorkflowNode } from '../../src/client/workflowGraphData.ts';

/** 造节点。 */
function node(over: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'n1', type: 'gate-event', label: 'G0 评估', x: 0, y: 0,
    ...over,
  } as WorkflowNode;
}

describe('cycle-91：健康度判据', () => {
  it('**无 testReport ⇒ unknown + failureRate=null**（不画"0 失败"）', () => {
    const h = healthOf(node());
    expect(h.band).toBe('unknown');
    expect(h.failureRate, '无 testReport ⇒ 失败率不可判定，不是 0').toBeNull();
    expect(h.total).toBe(0);
  });

  it('**分母为 0 ⇒ failureRate=null**（"没有用例"≠"没有失败"）', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 0, failures: 0, errors: 0, layers: [] } }));
    expect(h.band).toBe('unknown');
    expect(h.failureRate).toBeNull();
  });

  it('全通过 ⇒ band=ok + failureRate=0', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 2666, failures: 0, errors: 0, layers: [] } }));
    expect(h.band).toBe('ok');
    expect(h.failureRate).toBe(0);
    expect(h.total).toBe(2666);
  });

  it('有失败 ⇒ band=bad + 失败率可算', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 10, failures: 2, errors: 0, layers: [] } }));
    expect(h.band).toBe('bad');
    expect(h.failureRate).toBeCloseTo(2 / 12, 9);
  });

  it('失败率 < 1% ⇒ band=warn（低比例失败也要可见，但不报"红"）', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 1000, failures: 1, errors: 0, layers: [] } }));
    expect(h.band).toBe('warn');
    expect(h.failureRate).toBeCloseTo(1 / 1001, 9);
  });
});

describe('cycle-91：健康度分段与摘要', () => {
  it('分段比例之和为 1（且只含非零段）', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 10, failures: 2, errors: 1, layers: [] } }));
    const segs = healthSegments(h);
    expect(segs.map((s) => s.kind)).toEqual(['passed', 'failures', 'errors']);
    const sum = segs.reduce((a, s) => a + s.ratio, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('**无失败段**（全过）⇒ 只有 passed 段', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 10, failures: 0, errors: 0, layers: [] } }));
    expect(healthSegments(h).map((s) => s.kind)).toEqual(['passed']);
  });

  it('摘要文本给出**数字**（颜色不是唯一通道）', () => {
    const h = healthOf(node({ testReport: { report: 'r', passed: 2666, failures: 3, errors: 1, layers: [] } }));
    expect(healthSummaryText(h)).toBe('✓2666 ✗3 !1');
  });

  it('无 testReport / 无用例 ⇒ 摘要为 null（不画"0"）', () => {
    expect(healthSummaryText(healthOf(node()))).toBeNull();
    expect(healthSummaryText(healthOf(node({ testReport: { report: 'r', passed: 0, failures: 0, errors: 0, layers: [] } })))).toBeNull();
  });
});

describe('cycle-91：边流量编码（支撑度 → 线宽）', () => {
  const edges = [
    { from: 'e1', to: 'gate-g0', type: 'evidences' },
    { from: 'e2', to: 'gate-g0', type: 'evidences' },
    { from: 'e3', to: 'gate-g0', type: 'evidences' },
    { from: 'e4', to: 'gate-g0', type: 'cycle-seq' },
    { from: 'e5', to: 'gate-g1', type: 'evidences' },
  ];

  it('**系数式缩放**（保持类型间的相对关系不变）', () => {
    // 不同边类型默认宽度不同（evidences 0.7 / cycle-seq 0.9）⇒ 用**系数**而非绝对宽度，
    // 否则细边会比粗边还粗 ⇒ 跨类型比较失真。
    expect(supportWidth(0.7, undefined)).toBe(0.7);
    expect(supportWidth(0.7, 0)).toBe(0.7);
    expect(supportWidth(0.7, 1)).toBe(0.7);
    expect(supportWidth(0.7, 2)).toBeCloseTo(0.7 * 1.4, 10);
    expect(supportWidth(0.7, 8)).toBeCloseTo(0.7 * 1.9, 10);
    // 相对关系：0.9 的边在任一档都比 0.7 的边粗。
    for (const s of [1, 2, 8]) {
      expect(supportWidth(0.9, s)).toBeGreaterThan(supportWidth(0.7, s));
    }
  });

  it('按边类型统计支撑数', () => {
    expect(supportCountOf(edges, 'gate-g0', 'evidences')).toBe(3);
    expect(supportCountOf(edges, 'gate-g0')).toBe(4);
    expect(supportCountOf(edges, 'gate-g1', 'evidences')).toBe(1);
    expect(supportCountOf(edges, 'nope', 'evidences')).toBe(0);
  });

  it('**支撑越多 ⇒ 线越粗**（单调不减）', () => {
    const widths = [0, 1, 2, 3, 4, 8].map((n) => supportWidthOf(n));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!, `支撑 ${String(i)} 的宽度应 ≥ 支撑 ${String(i - 1)}`).toBeGreaterThanOrEqual(widths[i - 1]!);
    }
    expect(supportWidthOf(8), '枢纽门禁应最粗').toBeGreaterThan(supportWidthOf(1));
  });
});
