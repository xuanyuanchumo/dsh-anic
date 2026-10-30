/**
 * 耗时统计契约（cycle-90）—— 分位数双口径 + Gini 双尺度。
 *
 * ## 为什么钉这些口径
 *
 * 1. **P95 的两种算法差 26%**（实测 gate-check n=35：Type7=3162.20 vs 最近秩=3984）——
 *    只报一个会误导 SLA 判断。两者都报，读者自选。
 * 2. **Gini 的两个尺度差 4 倍**（实测全部 104 条：原尺度 0.8334 vs log 0.2002）——
 *    只报原尺度会误判为「整体不均衡」，只报 log 会掩盖「尾部确实很重」。
 * 3. **样本量门槛**：P50 ≥ 30、P95 ≥ 100、Gini ≥ 20 —— 门槛不足时**不返回数字**。
 *
 * 手算向量（研究阶段算好，直接钉）：
 * - `quantiles([10,20,30,40])` ⇒ p50=25、p95 type7=38.5、nearestRank=40
 * - `gini([1,2,3,4])` = 0.333333
 */
import { describe, expect, it } from 'vitest';
import {
  durationQuantiles,
  giniCoefficient,
  giniLogScale,
  giniReadout,
  quantileNearestRank,
  quantileType7,
} from '../../src/host/runtime/durationStats.ts';

describe('quantileType7：线性插值分位数', () => {
  it('**手算向量：quantiles([10,20,30,40]) ⇒ p50=25**', () => {
    expect(quantileType7([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it('**手算向量：p95 type7 = 38.5**', () => {
    expect(quantileType7([10, 20, 30, 40], 0.95)).toBe(38.5);
  });

  it('单样本 ⇒ 自身', () => {
    expect(quantileType7([7], 0.5)).toBe(7);
    expect(quantileType7([7], 0.95)).toBe(7);
  });

  it('空样本 ⇒ null（不是 0）', () => {
    expect(quantileType7([], 0.5)).toBeNull();
  });

  it('p=0 ⇒ 最小值；p=1 ⇒ 最大值', () => {
    expect(quantileType7([10, 20, 30, 40], 0)).toBe(10);
    expect(quantileType7([10, 20, 30, 40], 1)).toBe(40);
  });
});

describe('quantileNearestRank：SLA 口径分位数', () => {
  it('**手算向量：nearestRank p95 = 40**', () => {
    expect(quantileNearestRank([10, 20, 30, 40], 0.95)).toBe(40);
  });

  it('n=35 时与 Type 7 的差异可达 26%（实测口径差）', () => {
    // 构造 n=35 的样本，验证两口径给出**不同**的值（这正是要暴露的差异）。
    const vals = Array.from({ length: 35 }, (_, i) => (i + 1) * 100);
    const t7 = quantileType7(vals, 0.95);
    const nr = quantileNearestRank(vals, 0.95);
    expect(t7).not.toBeNull();
    expect(nr).not.toBeNull();
    expect(t7).not.toBe(nr);
    // 最近秩总是落在**实测值**上（SLA 承诺的是实测值）。
    expect(vals).toContain(nr as number);
  });

  it('空样本 ⇒ null', () => {
    expect(quantileNearestRank([], 0.95)).toBeNull();
  });
});

describe('durationQuantiles：双口径读数', () => {
  it('双口径 + 边界 + 均值一次给全', () => {
    const r = durationQuantiles([10, 20, 30, 40]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.n).toBe(4);
    expect(r.value.p50).toBe(25);
    expect(r.value.p95Type7).toBe(38.5);
    expect(r.value.p95NearestRank).toBe(40);
    expect(r.value.min).toBe(10);
    expect(r.value.max).toBe(40);
    expect(r.value.mean).toBe(25);
  });

  it('**不修改入参**（纯函数纪律）', () => {
    const input = [30, 10, 20];
    const before = input.join('|');
    durationQuantiles(input);
    expect(input.join('|')).toBe(before);
  });

  it('**负值 ⇒ not-applicable**（耗时不可能为负）', () => {
    const r = durationQuantiles([10, -5, 20]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-applicable');
  });

  it('空样本 ⇒ insufficient-data', () => {
    const r = durationQuantiles([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-data');
  });
});

describe('giniCoefficient：双尺度', () => {
  it('**手算向量：gini([1,2,3,4]) = 0.333333**', () => {
    expect(giniCoefficient([1, 2, 3, 4])).toBeCloseTo(1 / 3, 10);
  });

  it('**全同值 ⇒ 0**（完美均衡，不是 NaN）', () => {
    expect(giniCoefficient([5, 5, 5, 5])).toBe(0);
  });

  it('**全 0 ⇒ 0**（不是 NaN）', () => {
    expect(giniCoefficient([0, 0, 0])).toBe(0);
  });

  it('**单样本 ⇒ null**（分母含 n−1，不可判定）', () => {
    expect(giniCoefficient([1])).toBeNull();
    expect(giniCoefficient([])).toBeNull();
  });

  it('**极端不均衡 ⇒ 接近 1**', () => {
    const g = giniCoefficient([0, 0, 0, 0, 100]);
    expect(g).not.toBeNull();
    expect(g as number).toBeGreaterThan(0.8);
  });

  it('**对数尺度明显小于原尺度 ⇒ 长尾形态**（实测 0.8334 vs 0.2002）', () => {
    // 构造「大多数很快 + 少数很慢」的长尾样本。
    const tail = [...Array.from({ length: 30 }, () => 100), 10000, 20000, 50000];
    const g = giniCoefficient(tail);
    const gl = giniLogScale(tail);
    expect(g).not.toBeNull();
    expect(gl).not.toBeNull();
    expect(gl as number).toBeLessThan(g as number);
  });
});

describe('giniReadout：形态判读', () => {
  it('**长尾样本 ⇒ shape = long-tail**', () => {
    const tail = [...Array.from({ length: 30 }, () => 100), 10000, 20000, 50000];
    const r = giniReadout(tail);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.shape).toBe('long-tail');
  });

  it('**均衡样本 ⇒ shape = balanced**（两个 G 都极小 ⇒ 不该判长尾）', () => {
    const even = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = giniReadout(even);
    expect(r.ok).toBe(true);
    // 回归钉：原尺度 G=0.045、log G=0.0095（比值 0.21 看似「长尾」），
    // 但**两个值都极小** ⇒ 判 balanced。绝对量门槛的作用就在这里。
    if (r.ok) {
      expect(r.value.gini).toBeLessThan(0.3);
      expect(r.value.shape).toBe('balanced');
    }
  });

  it('**完全相同的样本 ⇒ balanced 且 G=0**', () => {
    const r = giniReadout(Array.from({ length: 30 }, () => 100));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.gini).toBe(0);
      expect(r.value.shape).toBe('balanced');
    }
  });

  it('**样本不足 ⇒ insufficient-data**（门槛 n≥20）', () => {
    const r = giniReadout([1, 2, 3]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-data');
  });

  it('**双尺度同时给出**（读者需要两个数才能判形态）', () => {
    const r = giniReadout(Array.from({ length: 30 }, () => 100));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.value.gini).toBe('number');
      expect(typeof r.value.giniLog).toBe('number');
    }
  });
});
