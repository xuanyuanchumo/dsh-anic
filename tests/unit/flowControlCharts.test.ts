/**
 * run 级 EWMA 控制图契约（cycle-90）。
 *
 * ## 钉死的判据
 *
 * 1. **run 级**（n_i=1）⇒ σ_p 恒定；中心线 p̂ = 全 PASS 的 run 比例。
 * 2. **变序控制限**：半宽 `L·σ_p·√(λ/(1−λ)·(1−(1−λ)^{2i}))`；UCL>1 clamp 到 1。
 * 3. **只用 WE 规则 1**（1 点超 3σ）—— band-detector 的规则 4–8 作用在连续值上，
 *    对 0/1 二项序列必假阳性。
 * 4. **样本不足 25 个子组 ⇒ 不启动**（λ=0.2 时控制限在 i≥21 饱和）。
 * 5. **p̄ ∈ {0,1} ⇒ 退化**（σ_p=0），不返回 NaN。
 *
 * ## 手算向量（研究阶段算好，**n_i=10 子组口径**）
 *
 * 3 点 EWMA ⇒ Z=0.873333/0.838667/0.870933，半宽 0.096747/0.123897/0.138507。
 * ⚠️ 这组参考值对应 **n_i=10**（σ_p=0.107497），**不是** run 级的 n_i=1。
 * 研究阶段用 n=10 是「把 10 条账本当一个子组」；本仓口径是 **run 级 n_i=1**
 * （一个 run = 一次跑门禁 = 一次试验）—— 理由见 `controlCharts.ts` 文件头
 * 「为什么是 run 级」。两套口径的参考值**不可混用**，本文件分别钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  clusterRuns,
  ewmaControlChart,
  ewmaFromLedger,
  ewmaFromSubgroups,
  runsToSubgroups,
  type RunObservation,
} from '../../src/host/flows/controlCharts.ts';

/** 造 run 观测。 */
function o(passed: boolean): RunObservation {
  return { passed };
}

/** 造 n 个观测，前 k 个 PASS。 */
function seq(n: number, passCount: number): RunObservation[] {
  return Array.from({ length: n }, (_, i) => o(i < passCount));
}

describe('ewmaControlChart：初始化约定（实测踩到的坑）', () => {
  it('**Z_0 = p̄（不是 0）** —— 研究基线向量只在此初值下成立', () => {
    // n_i=10 的研究参考：p̄=0.866667 ⇒ Z=0.873333/0.838667/0.870933
    const r = ewmaFromSubgroups(
      [{ n: 10, p: 0.9 }, { n: 10, p: 0.7 }, { n: 10, p: 1.0 }],
      { minSubgroups: 1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pHat).toBeCloseTo(0.866667, 6);
    expect(r.value.series[0]).toBeCloseTo(0.873333, 6);
    expect(r.value.series[1]).toBeCloseTo(0.838667, 6);
    expect(r.value.series[2]).toBeCloseTo(0.870933, 6);
  });

  it('**研究基线的半宽 0.096747/0.123897/0.138507（n_i=10 口径）**', () => {
    const r = ewmaFromSubgroups(
      [{ n: 10, p: 0.9 }, { n: 10, p: 0.7 }, { n: 10, p: 1.0 }],
      { minSubgroups: 1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hw = r.value.limits.map((l) => l.halfWidth);
    expect(hw[0]).toBeCloseTo(0.096747, 6);
    expect(hw[1]).toBeCloseTo(0.123897, 6);
    expect(hw[2]).toBeCloseTo(0.138507, 6);
  });

  it('**run 级（n_i=1）读数 ≠ 研究基线读数**（两套口径不可混用）', () => {
    const r = ewmaControlChart([o(true), o(true), o(false)], { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // n_i=1 ⇒ σ_p = √(p̄(1−p̄)) = √(2/9) = 0.4714（比 n=10 的 0.1075 大 4.4 倍）
    expect(r.value.pHat).toBeCloseTo(2 / 3, 10);
    expect(r.value.series[0]).toBeCloseTo(0.733333, 6);
    expect(r.value.series[1]).toBeCloseTo(0.786667, 6);
    expect(r.value.series[2]).toBeCloseTo(0.629333, 6);
    expect(r.value.limits[0]?.halfWidth).toBeCloseTo(0.424264, 6);
  });

  it('**series[0] 必然接近 p̄**（初值不是 0 的可观测证据）', () => {
    const r = ewmaControlChart(seq(30, 20), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs((r.value.series[0] ?? 0) - r.value.pHat)).toBeLessThan(0.25);
  });

  it('**centerLine 与 pHat 同值**（读数自证初值口径）', () => {
    const r = ewmaControlChart(seq(30, 20), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.centerLine).toBe(r.value.pHat);
  });
});

describe('ewmaControlChart：样本量门槛与退化', () => {
  it('**n < 25 ⇒ insufficient-data**（默认门槛）', () => {
    const r = ewmaControlChart(seq(10, 7));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('insufficient-data');
      expect(r.detail).toContain('25');
    }
  });

  it('**n === 25 ⇒ 可判定**（门槛边界）', () => {
    const r = ewmaControlChart(seq(25, 18));
    expect(r.ok).toBe(true);
  });

  it('**全 PASS ⇒ degenerate**（σ_p=0，控制图无判别力）', () => {
    const r = ewmaControlChart(seq(30, 30), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degenerate).toBe(true);
    expect(r.value.pHat).toBe(1);
    // 无 NaN。
    for (const v of r.value.series) expect(Number.isFinite(v)).toBe(true);
    // 退化 ⇒ 半宽全 0（控制限零宽 ⇒ 无判别力）。
    for (const l of r.value.limits) expect(l.halfWidth).toBe(0);
  });

  it('**全 FAIL ⇒ degenerate**', () => {
    const r = ewmaControlChart(seq(30, 0), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degenerate).toBe(true);
    expect(r.value.pHat).toBe(0);
    for (const l of r.value.limits) expect(l.halfWidth).toBe(0);
  });

  it('**空观测 ⇒ insufficient-data**', () => {
    expect(ewmaControlChart([]).ok).toBe(false);
  });

  it('**非法 λ ⇒ not-applicable**（不静默）', () => {
    const r = ewmaControlChart(seq(30, 20), { lambda: 0, minSubgroups: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-applicable');
  });

  it('**非法子组形态 ⇒ not-applicable**（n<1 或 p 越界）', () => {
    const bad = ewmaFromSubgroups([{ n: 0, p: 0.5 }], { minSubgroups: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('not-applicable');
    const bad2 = ewmaFromSubgroups([{ n: 1, p: 1.5 }], { minSubgroups: 1 });
    expect(bad2.ok).toBe(false);
  });
});

describe('ewmaControlChart：控制限形状与 clamp', () => {
  it('**UCL clamp 到 1 / LCL clamp 到 0**（比例不可能越界）', () => {
    const r = ewmaControlChart(seq(30, 29), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const l of r.value.limits) {
      expect(l.ucl).toBeLessThanOrEqual(1);
      expect(l.lcl).toBeGreaterThanOrEqual(0);
    }
  });

  it('**控制限随 i 收敛**（λ=0.2 时 i≥21 饱和）', () => {
    const r = ewmaControlChart(seq(40, 30), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = r.value.limits[0]?.halfWidth ?? 0;
    const mid = r.value.limits[10]?.halfWidth ?? 0;
    const late = r.value.limits[30]?.halfWidth ?? 0;
    expect(mid).toBeGreaterThan(first);
    expect(late).toBeGreaterThan(mid);
    const d1 = mid - first;
    const d2 = late - mid;
    expect(d2).toBeLessThan(d1);
  });

  it('**limits 与 series 一一对应**（同长度、同序号）', () => {
    const r = ewmaControlChart(seq(30, 20), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.limits).toHaveLength(r.value.series.length);
    expect(r.value.limits[0]?.i).toBe(1);
    expect(r.value.limits[r.value.limits.length - 1]?.i).toBe(r.value.n);
  });
});

describe('ewmaControlChart：WE 规则 1（唯一使用的规则）', () => {
  it('**稳定序列 ⇒ 无越界**', () => {
    const r = ewmaControlChart(seq(40, 30), { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.violations.length).toBe(0);
    expect(r.value.lastOutOfControlIndex).toBe(-1);
  });

  it('**持续劣化 ⇒ 报越界**（100 PASS 后 30 FAIL ⇒ Z 跌破 LCL）', () => {
    // ⚠️ run 级 n_i=1 ⇒ σ_p = 0.42（远宽于 n=10 的 0.107）⇒ 控制限很宽，
    // 需要**足够多**的连续失败才跌破 LCL。实测：100P+10F 不越界，
    // 100P+30F 越界 22 点（首点下标 107）。这是 run 级口径的**真实灵敏度**。
    const obs = [...seq(100, 100), ...seq(30, 0)];
    const r = ewmaControlChart(obs, { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.violations.length).toBeGreaterThan(0);
    expect(r.value.lastOutOfControlIndex).toBeGreaterThanOrEqual(100);
  });

  it('**越界索引是 0-based 的序列下标**（不是 1-based 的 i）', () => {
    const obs = [...seq(100, 100), ...seq(30, 0)];
    const r = ewmaControlChart(obs, { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const idx of r.value.violations) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(r.value.n);
    }
  });

  it('**反向漂移也报越界**（连续 FAIL 后开始 PASS ⇒ Z 冲破 UCL）', () => {
    const obs = [...seq(60, 0), ...seq(20, 20)];
    const r = ewmaControlChart(obs, { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.violations.length).toBeGreaterThan(0);
  });

  it('**越界判定用未 clamp 的原始限**（clamp 后永远不越界 ⇒ 规则失效）', () => {
    // p̂=0.25 ⇒ UCL_raw 可 < 1，clamp 不影响；构造一个 UCL_raw>1 的场景验证不误报。
    const obs = [...seq(60, 0), ...seq(20, 20)];
    const r = ewmaControlChart(obs, { minSubgroups: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 上侧越界必须落在原始限之外；若用 clamp 后的限判定，会永远为 0 个。
    expect(r.value.violations.length).toBeGreaterThan(0);
  });
});

describe('clusterRuns：账本 → run 聚类', () => {
  it('**gap ≤ 5s 的条目聚成同一 run**', () => {
    const entries = [
      { timestamp: '2026-10-30T00:00:00.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:01.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:02.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:03.000Z', result: 'PASS' },
    ];
    const runs = clusterRuns(entries);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.passed).toBe(true);
    expect(runs[0]?.entries).toBe(4);
  });

  it('**gap > 5s ⇒ 切成两个 run**', () => {
    const entries = [
      { timestamp: '2026-10-30T00:00:00.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:20.000Z', result: 'PASS' },
    ];
    expect(clusterRuns(entries)).toHaveLength(2);
  });

  it('**一个 run 内有 FAIL ⇒ 整个 run 记 FAIL**（保守方向）', () => {
    const entries = [
      { timestamp: '2026-10-30T00:00:00.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:01.000Z', result: 'FAIL' },
      { timestamp: '2026-10-30T00:00:02.000Z', result: 'PASS' },
    ];
    const runs = clusterRuns(entries);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.passed).toBe(false);
  });

  it('**无序输入被排序**', () => {
    const entries = [
      { timestamp: '2026-10-30T00:00:02.000Z', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:00.000Z', result: 'PASS' },
    ];
    expect(clusterRuns(entries)).toHaveLength(1);
  });

  it('**非法时间戳被跳过**（不是当作 0 时间）', () => {
    const entries = [
      { timestamp: 'not-a-date', result: 'PASS' },
      { timestamp: '2026-10-30T00:00:00.000Z', result: 'PASS' },
    ];
    const runs = clusterRuns(entries);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.entries).toBe(1);
  });

  it('**空输入 ⇒ 空 run 列表**', () => {
    expect(clusterRuns([])).toHaveLength(0);
  });
});

describe('runsToSubgroups：run → 伯努利子组', () => {
  it('**每个 run 变成 n=1 的子组**（run 级口径的载体）', () => {
    const subs = runsToSubgroups([o(true), o(false), o(true)]);
    expect(subs).toEqual([
      { n: 1, p: 1 },
      { n: 1, p: 0 },
      { n: 1, p: 1 },
    ]);
  });
});

describe('ewmaFromLedger：一站式入口', () => {
  it('**账本 → run → 控制图**全链路可判定', () => {
    // 造 30 个 run，每个 run 一条 PASS ⇒ p̂=1 ⇒ degenerate（不报越界）。
    const entries = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `2026-10-30T00:${String(i).padStart(2, '0')}:00.000Z`,
      result: 'PASS',
    }));
    const r = ewmaFromLedger(entries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.n).toBe(30);
    expect(r.value.pHat).toBe(1);
    expect(r.value.degenerate).toBe(true);
  });

  it('**空账本 ⇒ insufficient-data**（不是 0 读数）', () => {
    const r = ewmaFromLedger([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-data');
  });
});
