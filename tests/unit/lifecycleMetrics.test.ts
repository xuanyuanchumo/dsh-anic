/**
 * 生命周期指标的**投影 + 渲染**契约（cycle-90）。
 *
 * ## 为什么钉这些
 *
 * 1. **不可判定 ≠ 0**：服务端给 `{ available:false, reason, detail }`，
 *    面板必须**原样显示 detail**，绝不显示 0。
 * 2. **归属覆盖常驻**：孤儿比例必须显示 —— 否则读者会把「只统计了 3%」
 *    当成「统计了全部」。
 * 3. **截断徽标常驻**：窗口截断时「近期优于历史」可能是假象。
 * 4. **灵敏度必须说**：run 级 3σ 需连续 ~30 次失败才触发 ——
 *    读者若不知道，会把「没报警」读成「没问题」。
 */
import { describe, expect, it } from 'vitest';
import { buildLifecycleMetrics } from '../../src/host/runtime/lifecycleMetrics.ts';
import { truncationInfo } from '../../src/host/runtime/statVerdict.ts';
import type { FlowRecord } from '../../src/host/runtime/flowTracker.ts';
import {
  ewmaSigmaFloor,
  failureSensitivity,
  humanizeMs,
  isAvailable,
  isLifecycleMetrics,
  unavailableReason,
} from '../../src/client/features/flows/lifecycleTypes.ts';
import { renderLifecycleMetrics } from '../../src/client/features/flows/renderLifecycleMetrics.ts';

/** 造 flow 记录。 */
function rec(over: Partial<FlowRecord> = {}): FlowRecord {
  return {
    flowId: 'f-1', script: 'gate-check', workspace: 'D:/w', args: [],
    status: 'DONE', startedAt: '2026-10-30T00:00:00.000Z',
    durationMs: 1000, exitCode: 0,
    attribution: { at: '2026-10-30T00:00:00.000Z', source: 'workflow-state' },
    ...over,
  };
}

/** 收集树中的全部文本。 */
function textsOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textsOf).join(' ');
  const el = node as { props?: Record<string, unknown> };
  if (el.props === undefined) return '';
  return textsOf(el.props['children']);
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

describe('buildLifecycleMetrics：投影层', () => {
  it('**窗口信息随读数一起返回**（截断可观测）', () => {
    const flows = [rec()];
    const view = buildLifecycleMetrics(flows, [], truncationInfo({ flows, counter: flows.length }));
    expect(view.window.retained).toBe(1);
    expect(view.window.truncated).toBe(false);
    expect(view.window.truncationWarning).toBeNull();
  });

  it('**已截断 ⇒ 截断告警随读数返回**', () => {
    const flows = [rec()];
    const view = buildLifecycleMetrics(flows, [], truncationInfo({ flows, counter: 50 }));
    expect(view.window.truncated).toBe(true);
    expect(view.window.truncationWarning).not.toBeNull();
    expect(view.window.evicted).toBe(49);
  });

  it('**归属覆盖如实给出**（孤儿计入，不回填）', () => {
    const flows = [
      rec({ flowId: 'a' }),
      rec({ flowId: 'b', attribution: { at: 'x', source: 'none' } }),
      rec({ flowId: 'c', attribution: { at: 'x', source: 'none' } }),
    ];
    const view = buildLifecycleMetrics(flows, [], truncationInfo({ flows, counter: flows.length }));
    expect(view.attribution.attributed).toBe(1);
    expect(view.attribution.orphans).toBe(2);
    expect(view.attribution.coverage).toBeCloseTo(1 / 3, 4);
    expect(view.attribution.note).toContain('2');
  });

  it('**不可判定原样透出**（不转 0）', () => {
    const flows = [rec()];
    const view = buildLifecycleMetrics(flows, [], truncationInfo({ flows, counter: flows.length }));
    // 样本不足 ⇒ available=false + reason + detail。
    expect(view.gatePassRate.available).toBe(false);
    expect(view.gatePassRate.reason).toBeTruthy();
    expect(view.gatePassRate.detail).toBeTruthy();
  });

  it('**耗时读数在样本足够时可用**', () => {
    const flows = Array.from({ length: 30 }, (_, i) => rec({ flowId: `f-${String(i)}`, durationMs: 100 + i }));
    const view = buildLifecycleMetrics(flows, [], truncationInfo({ flows, counter: flows.length }));
    expect(view.duration.available).toBe(true);
    if (view.duration.available && view.duration.value) {
      expect(view.duration.value.n).toBe(30);
      expect(typeof view.duration.value.p50).toBe('number');
    }
  });

  it('**无数据 ⇒ 各模型都不可判定**（不返回 0）', () => {
    const view = buildLifecycleMetrics([], [], truncationInfo({ flows: [], counter: 0 }));
    expect(view.gatePassRate.available).toBe(false);
    expect(view.gateRepairTime.available).toBe(false);
    expect(view.duration.available).toBe(false);
    expect(view.inequality.available).toBe(false);
  });
});

describe('客户端派生函数', () => {
  it('isLifecycleMetrics：接受有 window/attribution 的对象', () => {
    expect(isLifecycleMetrics({ window: {} })).toBe(true);
    expect(isLifecycleMetrics({ attribution: {} })).toBe(true);
    expect(isLifecycleMetrics({})).toBe(false);
    expect(isLifecycleMetrics(null)).toBe(false);
  });

  it('**unavailableReason：给出可显示的原因**（不显示 undefined）', () => {
    expect(unavailableReason({ available: false, reason: 'insufficient-data', detail: 'n=7 < 20' })).toBe('n=7 < 20');
    expect(unavailableReason({ available: false, reason: 'insufficient-data' })).toBe('insufficient-data');
    expect(unavailableReason({ available: true, value: {} })).toBeNull();
    expect(unavailableReason(undefined)).toBeNull();
  });

  it('**humanizeMs：三档**（ms / s / min / h）', () => {
    expect(humanizeMs(500)).toBe('500ms');
    expect(humanizeMs(1500)).toBe('1.5s');
    expect(humanizeMs(233641)).toBe('3.9min');
    expect(humanizeMs(7.3 * 3600 * 1000)).toBe('7.3h');
    expect(humanizeMs(null)).toBeNull();
    expect(humanizeMs(undefined)).toBeNull();
  });

  it('**failureSensitivity：run 级口径下 3σ 触不到 ⇒ null**（实测：LCL=−0.5048 ≤ 0）', () => {
    // run 级 n_i=1 ⇒ σ_p=0.4235 ⇒ 3σ 半宽 1.27 ⇒ LCL = p̄−3σ = −0.5048 ≤ 0
    // ⇒ 比例不可能低于它 ⇒ **3σ 判据在本口径下永不触发**。
    // 返回 null 而不是编一个「需要 30 次」的数字（那个数字是我早期误解）。
    expect(failureSensitivity(0.765766)).toBeNull();
  });

  it('**ewmaSigmaFloor：σ 数地板 ≈ 1.81**（连续失败再多也到不了 3σ）', () => {
    const floor = ewmaSigmaFloor(0.765766);
    expect(floor).not.toBeNull();
    expect(floor as number).toBeCloseTo(1.81, 1);
    // 地板 < 3 ⇒ 3σ 判据不可达（这是「该判据在本口径下钝」的形式化表达）。
    expect(floor as number).toBeLessThan(3);
  });

  it('**failureSensitivity：p̄ 接近 1 时 LCL>0 ⇒ 给出次数**', () => {
    // p̄=0.95 ⇒ σ_p=0.218 ⇒ 3σ 半宽 0.654 ⇒ LCL=0.296>0 ⇒ 可判定。
    const k = failureSensitivity(0.95);
    expect(k).not.toBeNull();
    expect(k as number).toBeGreaterThan(0);
  });

  it('**failureSensitivity：p̄∈{0,1} ⇒ null**（退化时无意义）', () => {
    expect(failureSensitivity(0)).toBeNull();
    expect(failureSensitivity(1)).toBeNull();
    expect(failureSensitivity(null)).toBeNull();
  });
});

describe('renderLifecycleMetrics：渲染', () => {
  it('null ⇒ 不渲染', () => {
    expect(renderLifecycleMetrics(null)).toBeNull();
  });

  it('**有读数 ⇒ 渲染且带可断言锚点**', () => {
    const el = renderLifecycleMetrics({
      window: { everWritten: 105, retained: 105, evicted: 0, truncated: false, windowSpanMs: 1000 },
      attribution: { attributed: 3, orphans: 101, coverage: 0.0288, note: 'x' },
      gateRepairTime: { available: true, value: { n: 34, events: 34, censored: 0, medianMs: 233641, medianCi95Ms: [112884, 26393819], degenerateCi: false } },
      gatePassRate: { available: true, value: { n: 111, pHat: 0.765766, centerLine: 0.765766, series: [], limits: [], violations: [], lastOutOfControlIndex: -1, degenerate: false } },
      duration: { available: true, value: { n: 105, p50: 1071, p95Type7: 111027.6, p95NearestRank: 112033, min: 1, max: 12350605, mean: 22254.53 } },
      inequality: { available: true, value: { n: 105, gini: 0.8349, giniLog: 0.1995, shape: 'long-tail' } },
    });
    expect(el).not.toBeNull();
    expect(nodesWith(el, 'data-anic-lifecycle')).toHaveLength(1);
    const metrics = nodesWith(el, 'data-anic-lifecycle-metric').map(
      (n) => (n as { props: Record<string, unknown> }).props['data-anic-lifecycle-metric'],
    );
    // 生存/控制图的读数块被拆到 renderLifecycleModels.ts（各自包一层 div），
    // 但度量行仍带同一组锚点 ⇒ 断言按锚点集合判定，不依赖 DOM 层级。
    expect(metrics).toContain('survival');
    expect(metrics).toContain('episodes');
    expect(metrics).toContain('passRate');
    expect(metrics).toContain('p50');
    expect(metrics).toContain('gini');
  });

  it('**不可判定 ⇒ 显示「不可判定」行，绝不显示 0**', () => {
    const el = renderLifecycleMetrics({
      window: { everWritten: 0, retained: 0, evicted: 0, truncated: false },
      attribution: { attributed: 0, orphans: 0, coverage: 0 },
      gateRepairTime: { available: false, reason: 'insufficient-data', detail: '样本不足（n=3 < 20）' },
    });
    expect(el).not.toBeNull();
    const unavailable = nodesWith(el, 'data-anic-lifecycle-unavailable');
    expect(unavailable.length).toBeGreaterThan(0);
    // 文本里必须出现服务端给的 detail。
    expect(textsOf(el)).toContain('样本不足');
  });

  it('**截断 ⇒ 显示截断徽标**', () => {
    const el = renderLifecycleMetrics({
      window: { everWritten: 50, retained: 1, evicted: 49, truncated: true, truncationWarning: '⚠ 数据窗口已截断' },
      attribution: { attributed: 1, orphans: 0, coverage: 1 },
    });
    expect(nodesWith(el, 'data-anic-lifecycle-truncated')).toHaveLength(1);
    expect(textsOf(el)).toContain('截断');
  });

  it('**灵敏度提示出现**（读者必须知道「没报警」≠「没问题」）', () => {
    const el = renderLifecycleMetrics({
      window: { everWritten: 111, retained: 111, evicted: 0, truncated: false },
      attribution: { attributed: 111, orphans: 0, coverage: 1 },
      gatePassRate: { available: true, value: { n: 111, pHat: 0.765766, series: [], limits: [], violations: [], lastOutOfControlIndex: -1, degenerate: false } },
    });
    expect(nodesWith(el, 'data-anic-lifecycle-sensitivity')).toHaveLength(1);
  });

  it('**长尾形态 ⇒ 显示形态结论**', () => {
    const el = renderLifecycleMetrics({
      window: { everWritten: 105, retained: 105, evicted: 0, truncated: false },
      attribution: { attributed: 105, orphans: 0, coverage: 1 },
      inequality: { available: true, value: { n: 105, gini: 0.8349, giniLog: 0.1995, shape: 'long-tail' } },
    });
    const shape = nodesWith(el, 'data-anic-lifecycle-shape');
    expect(shape).toHaveLength(1);
    expect((shape[0] as { props: Record<string, unknown> }).props['data-anic-lifecycle-shape']).toBe('long-tail');
  });
});
