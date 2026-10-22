/**
 * cycle-71 T-7131 调用流量化（运行状态量化）纯函数直测。
 *
 * 用户要求「运行状态…白盒透明化**量化**」。四个函数共用一条**样本门槛**：
 * 只取 status !== 'in-flight' 且 durationMs 为合法正数的条目——运行中调用的
 * 时长是「已进行」量纲，与终态耗时混在一个分位数里是把两种量纲掺进同一个
 * 数字。分位数用最近秩法（返回的必定是某个真实样本值，不插值发明中间值）。
 */
import { describe, it, expect } from 'vitest';
import { p50Of, p95Of, maxOf, errorCodeHistogram } from '../../src/client/features/live/invocationQuant.ts';
import type { InvocationJson } from '../../src/client/features/live/renderInvocationsTypes.ts';

function inv(over: Partial<InvocationJson>): InvocationJson {
  return { callId: 'c', name: 'anic_evaluate', argumentsPreview: '{}', startedAt: 1, status: 'done', ...over };
}

describe('调用流量化：p50 / p95 / max（最近秩，样本门槛）', () => {
  const samples = [inv({ durationMs: 10 }), inv({ durationMs: 20 }), inv({ durationMs: 30 }), inv({ durationMs: 40 })];

  it('P95 取最近秩（真实样本值，非插值）——长尾量化', () => {
    expect(p95Of(samples)).toBe(40);
    expect(p50Of(samples)).toBe(20);
    expect(maxOf(samples)).toBe(40);
  });

  it('in-flight 不参与（「已进行」与「终态耗时」是两种量纲，不混算）', () => {
    const mixed = [inv({ durationMs: 100 }), inv({ status: 'in-flight', durationMs: 9999 })];
    expect(maxOf(mixed)).toBe(100);   // 运行中的 durationMs 若被计入会得 9999
    expect(p50Of(mixed)).toBe(100);
  });

  it('durationMs 非法（缺失/0/负/非有限）→ 不入样本', () => {
    const dirty = [inv({}), inv({ durationMs: 0 }), inv({ durationMs: -5 }), inv({ durationMs: Number.NaN }), inv({ durationMs: 77 })];
    expect(maxOf(dirty)).toBe(77);
    expect(p50Of(dirty)).toBe(77);
  });

  it('空样本 / 全非法 → null（不伪造 0ms）', () => {
    expect(p50Of([])).toBeNull();
    expect(p95Of([])).toBeNull();
    expect(maxOf([])).toBeNull();
    expect(p95Of([inv({ status: 'in-flight', durationMs: 5 })])).toBeNull();
    expect(maxOf([inv({})])).toBeNull();
  });

  it('error 态算已完成（有终态时长的条目同权参与）', () => {
    const withErr = [inv({ durationMs: 10, status: 'done' }), inv({ durationMs: 500, status: 'error' })];
    expect(maxOf(withErr)).toBe(500);
  });

  it('单样本：P50 = P95 = max = 该样本值（小样本不自造中间值）', () => {
    const one = [inv({ durationMs: 42 })];
    expect(p50Of(one)).toBe(42);
    expect(p95Of(one)).toBe(42);
    expect(maxOf(one)).toBe(42);
  });
});

describe('调用流量化：错误码直方图', () => {
  it('按次数降序、同次数按码字典序（快照式排序，渲染层零重排）', () => {
    const h = errorCodeHistogram([
      inv({ status: 'error', error: { name: 'E', code: 'G1' } }),
      inv({ status: 'error', error: { name: 'E', code: 'G2' } }),
      inv({ status: 'error', error: { name: 'E', code: 'G1' } }),
      inv({ status: 'error', error: { name: 'E', code: 'A1' } }),
    ]);
    expect(h).toEqual([{ code: 'G1', count: 2 }, { code: 'A1', count: 1 }, { code: 'G2', count: 1 }]);
  });

  it('非 error 条目 / 无 code / 空 code 不计入；无错误 → []', () => {
    expect(errorCodeHistogram([inv({ status: 'done' }), inv({ status: 'in-flight' })])).toEqual([]);
    expect(errorCodeHistogram([inv({ status: 'error' })])).toEqual([]);            // 无 error 对象
    expect(errorCodeHistogram([inv({ status: 'error', error: { name: 'E', code: '' } })])).toEqual([]);
  });

  it('error 但 code 非字符串（异常形状）→ 跳过（不把 undefined 洗成 "undefined"）', () => {
    const weird = inv({ status: 'error', error: { name: 'E', code: undefined as unknown as string } });
    expect(errorCodeHistogram([weird])).toEqual([]);
  });
});
