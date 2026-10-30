/**
 * 统计判据与截断检测契约（cycle-90）。
 *
 * ## 为什么需要这一层
 *
 * 统计读数有**三种**状态，不是两种：
 *
 * ```
 * 有数据且可判定 → ok
 * 有数据但样本不足 → insufficient-data   ← 最容易被伪装成 ok 的那一种
 * 数据形态不适用 → not-applicable        ← 模型选择错误，不是数据问题
 * ```
 *
 * 把后两者混进 `ok`（给一个数）是**统计上的撒谎**；混进 `0` 是**数值上的撒谎**
 * （0 是个合法的读数）。
 *
 * ## 截断检测（本仓特有）
 *
 * `flow-tracker.json` 容量上限 200 条、**滚动淘汰最旧的**。一旦淘汰，保留窗口
 * 就**偏向近期** ⇒「近期表现优于历史」可能是**假象**。
 * 实测当前 `flows.length === counter === 105` ⇒ **尚未淘汰过一条**，
 * 但上限仍在，每 95 次调用就会触发第一次淘汰 ⇒ **必须**实现检测。
 */
import { describe, expect, it } from 'vitest';
import {
  insufficient,
  notApplicable,
  ok,
  requireSamples,
  truncationInfo,
  truncationWarning,
  valueOf,
  type Verdict,
} from '../../src/host/runtime/statVerdict.ts';

describe('Verdict：三种状态互斥且可区分', () => {
  it('ok 分支携带值', () => {
    const v = ok(42);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toBe(42);
  });

  it('**insufficient-data 与 not-applicable 是不同状态**（处置动作不同）', () => {
    const a = insufficient<number>('样本不足');
    const b = notApplicable<number>('模型不适用');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.reason).toBe('insufficient-data');
      expect(b.reason).toBe('not-applicable');
      expect(a.reason).not.toBe(b.reason);
    }
  });

  it('**失败分支必带 detail**（不能只说「失败了」）', () => {
    const v = insufficient<number>('n=7 < 20');
    if (!v.ok) {
      expect(v.detail).toBe('n=7 < 20');
      expect(v.detail.length).toBeGreaterThan(0);
    }
  });

  it('valueOf：ok → 值；失败 → null', () => {
    expect(valueOf(ok(1))).toBe(1);
    expect(valueOf(insufficient<number>('x'))).toBeNull();
  });

  it('**Verdict<T> 可用于任意 T**（泛型正确）', () => {
    const s: Verdict<string> = ok('x');
    const n: Verdict<number> = insufficient('y');
    expect(s.ok).toBe(true);
    expect(n.ok).toBe(false);
  });
});

describe('requireSamples：样本量门槛', () => {
  it('**n >= 门槛 ⇒ null**（放行）', () => {
    expect(requireSamples(20, 20, 'x')).toBeNull();
    expect(requireSamples(25, 20, 'x')).toBeNull();
  });

  it('**n < 门槛 ⇒ insufficient-data 且 detail 含 n 与门槛**', () => {
    const v = requireSamples(7, 20, 'Gini 需足够样本');
    expect(v).not.toBeNull();
    if (v !== null && !v.ok) {
      expect(v.reason).toBe('insufficient-data');
      expect(v.detail).toContain('n=7');
      expect(v.detail).toContain('20');
      expect(v.detail).toContain('Gini');
    }
  });

  it('**门槛边界：n = 门槛 - 1 ⇒ 拦；n = 门槛 ⇒ 放行**', () => {
    expect(requireSamples(29, 30, 'x')).not.toBeNull();
    expect(requireSamples(30, 30, 'x')).toBeNull();
  });
});

describe('truncationInfo：滚动淘汰检测', () => {
  it('**未淘汰 ⇒ truncated=false，evicted=0**', () => {
    const info = truncationInfo({ flows: [], counter: 0 });
    expect(info.everWritten).toBe(0);
    expect(info.retained).toBe(0);
    expect(info.evicted).toBe(0);
    expect(info.truncated).toBe(false);
  });

  it('**已淘汰 ⇒ evicted>0 且 truncated=true**', () => {
    const flows = [{ flowId: 'f', script: 's', workspace: 'w', args: [], status: 'DONE' as const, startedAt: '2026-10-30T00:00:00.000Z' }];
    const info = truncationInfo({ flows, counter: 10 });
    expect(info.everWritten).toBe(10);
    expect(info.retained).toBe(1);
    expect(info.evicted).toBe(9);
    expect(info.truncated).toBe(true);
  });

  it('**everWritten 取 counter 与 flows.length 的较大者**（counter 可能落后）', () => {
    const info = truncationInfo({ flows: [], counter: 5 });
    expect(info.everWritten).toBe(5);
    expect(info.evicted).toBe(5);
  });

  it('**窗口跨度：≥2 条时给出**（毫秒）', () => {
    const flows = [
      { flowId: 'a', script: 's', workspace: 'w', args: [], status: 'DONE' as const, startedAt: '2026-10-30T00:00:00.000Z' },
      { flowId: 'b', script: 's', workspace: 'w', args: [], status: 'DONE' as const, startedAt: '2026-10-30T01:00:00.000Z' },
    ];
    const info = truncationInfo({ flows, counter: 2 });
    expect(info.windowSpanMs).toBe(3600000);
  });

  it('**单条 ⇒ 窗口跨度 null**（跨不了窗口，不是 0）', () => {
    const flows = [{ flowId: 'a', script: 's', workspace: 'w', args: [], status: 'DONE' as const, startedAt: '2026-10-30T00:00:00.000Z' }];
    expect(truncationInfo({ flows, counter: 1 }).windowSpanMs).toBeNull();
  });
});

describe('truncationWarning：跨窗口读数的告警', () => {
  it('**未截断 ⇒ null**（不制造噪音）', () => {
    expect(truncationWarning(truncationInfo({ flows: [], counter: 0 }))).toBeNull();
  });

  it('**已截断 ⇒ 一句可直接显示的话，含丢弃条数**', () => {
    // 保留 1 条、共写过 10 条 ⇒ 淘汰 9 条。
    const flows = [{ flowId: 'f', script: 's', workspace: 'w', args: [], status: 'DONE' as const, startedAt: '2026-10-30T00:00:00.000Z' }];
    const info = truncationInfo({ flows, counter: 10 });
    expect(info.evicted).toBe(9);
    const w = truncationWarning(info);
    expect(w).not.toBeNull();
    expect(w).toContain('9');
    expect(w).toContain('截断');
  });

  it('**告警文本说明偏差方向**（近期偏向近期）', () => {
    const w = truncationWarning(truncationInfo({ flows: [], counter: 10 }));
    expect(w).toContain('近期');
  });
});
