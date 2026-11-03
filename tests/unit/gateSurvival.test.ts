/**
 * Kaplan-Meier 生存分析契约（cycle-90）。
 *
 * ## 钉死的判据
 *
 * 1. **同刻聚合**：同一时刻的多个事件算**一步**（不是多步）。
 * 2. **中位数**：首个 `S(t) ≤ 0.5` 的时刻；未达到 ⇒ null。
 * 3. **Greenwood 分母为 0** ⇒ CI 退化标 `degenerateCi`，**绝不 NaN**。
 * 4. **n < 20** ⇒ `insufficient-data`（不返回数字）。
 * 5. **右删失必须支持**（当前数据 0 条，但代码要能处理 —— G2 通过率仅 0.63）。
 *
 * 手算向量（研究阶段算好）：4 样本 ⇒ median=20，S 序列 0.75/0.50/0.50/0，
 * greenwood 0.083333/0.25。
 */
import { describe, expect, it } from 'vitest';
import { failEpisodes, kaplanMeier } from '../../src/host/runtime/gateSurvival.ts';

/** 造样本。 */
function s(durationMs: number, event = true): { durationMs: number; event: boolean } {
  return { durationMs, event };
}

describe('kaplanMeier：基本估计', () => {
  it('**手算向量：4 样本 ⇒ median=20，S 序列 0.75/0.50/0.50/0**', () => {
    // 样本：t=10 事件、t=20 事件、t=30 删失、t=40 事件
    const r = kaplanMeier([s(10), s(20), s(30, false), s(40)], 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.n).toBe(4);
    expect(r.value.events).toBe(3);
    expect(r.value.censored).toBe(1);
    expect(r.value.steps.map((x) => x.survival)).toEqual([0.75, 0.5, 0.5, 0]);
    expect(r.value.medianMs).toBe(20);
  });

  it('**Greenwood 方差：0.083333 / 0.25**（手算向量 —— 文献口径是方差）', () => {
    const r = kaplanMeier([s(10), s(20), s(30, false), s(40)], 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 手算：step1 n=4,d=1 ⇒ 1/(4×3)=0.083333；step2 累积 += 1/(3×2)=0.166667 ⇒ 0.25
    const variance = r.value.steps.map((x) => x.greenwoodVariance);
    expect(variance[0]).toBeCloseTo(0.0833333333, 8);
    expect(variance[1]).toBeCloseTo(0.25, 8);
    // 标准误 = √方差（CI 用它）。
    const se = r.value.steps.map((x) => x.greenwoodSe);
    expect(se[0]).toBeCloseTo(Math.sqrt(0.0833333333), 8);
    expect(se[1]).toBeCloseTo(0.5, 8);
  });

  it('**同刻多事件算一步**（不是多步）', () => {
    // 4 个样本，t=10 时 2 个事件 ⇒ S(10) = 1 − 2/4 = 0.5（一步）
    const r = kaplanMeier([s(10), s(10), s(20), s(30, false)], 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps.length).toBe(3);
    expect(r.value.steps[0]?.survival).toBe(0.5);
    expect(r.value.steps[0]?.d).toBe(2);
    expect(r.value.steps[0]?.atRisk).toBe(4);
  });

  it('**中位数取首个 S(t) ≤ 0.5 的时刻**（不是下一个）', () => {
    const r = kaplanMeier([s(10), s(10), s(20), s(30, false)], 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.medianMs).toBe(10);
  });

  it('**生存率未降到 0.5 ⇒ 中位数 null**（不是 0）', () => {
    const r = kaplanMeier([s(10, false), s(20, false), s(30, false), s(40, false)], 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.medianMs).toBeNull();
      expect(r.value.censored).toBe(4);
      expect(r.value.events).toBe(0);
    }
  });
});

describe('kaplanMeier：样本量门槛与数值稳定性', () => {
  it('**n < 20 ⇒ insufficient-data**（默认门槛）', () => {
    const r = kaplanMeier([s(1), s(2)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('insufficient-data');
      expect(r.detail).toContain('n=2');
      expect(r.detail).toContain('20');
    }
  });

  it('**n === 1：中位数数学上存在，但 CI 必然退化**', () => {
    // 单事件 ⇒ S(5) = 0 ≤ 0.5 ⇒ 中位数 = 5（这是**数学事实**，不是编造）。
    // 但 n_j === d_j ⇒ Greenwood 分母 0 ⇒ CI 不可估 ⇒ degenerateCi=true。
    const r = kaplanMeier([s(5)], 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.medianMs).toBe(5);
    expect(r.value.degenerateCi).toBe(true);
    expect(r.value.medianCi95Ms).toBeNull();
  });

  it('**n_j === d_j ⇒ CI 退化标记，且无 NaN**', () => {
    // 2 个样本都在 t=10 发生事件 ⇒ 第二步 n=2,d=2 ⇒ Greenwood 分母 0
    const r = kaplanMeier([s(10), s(10)], 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degenerateCi).toBe(true);
    expect(r.value.medianCi95Ms).toBeNull();
    // 所有读数都是有限数（无 NaN / Infinity）。
    for (const step of r.value.steps) {
      expect(Number.isFinite(step.survival)).toBe(true);
      expect(Number.isFinite(step.greenwoodSe)).toBe(true);
    }
  });

  it('**空样本 ⇒ insufficient-data**', () => {
    const r = kaplanMeier([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-data');
  });

  it('**负值时长 ⇒ 拒绝**（不静默）', () => {
    const r = kaplanMeier([s(-1), s(1)], 1);
    expect(r.ok).toBe(false);
  });

  it('**非有限时长 ⇒ 拒绝**', () => {
    const r = kaplanMeier([s(Number.NaN), s(1)], 1);
    expect(r.ok).toBe(false);
  });

  it('**中位数 CI：Brookmeyer-Crowley 点态反演**（真实账本数据 → 统计性质断言）', () => {
    // cycle-97 根修：旧断言写死 cycle-96 时代的中位数 233641ms——但数据源是
    // **活账本**（.cycles/gates/ledger.json，append-only 哈希链），每轮门禁
    // PASS/FAIL 记录都会改变 episode 分布 ⇒ 写死数值的测试随账本演化恒红
    // （本轮归档重启后 G1/G2 FAIL 记录入账 → 中位数 233641 → 288592 即复现）。
    // 真实数据测试的正确断言形态是**统计性质**而非具体数值：
    //   ① 样本量门槛（<20 跳过——独立于账本状态）；
    //   ② 计算收敛（ok:true，无 NaN/Inf）；
    //   ③ CI 包住中位数且非退化（反演逻辑正确性的数学不变量）；
    //   ④ 中位数为正（修复时长语义）。
    // 数值精度的回归防线由本文件其它用例承担（合成数据 + 手算基线）。
    const fs = require('node:fs');
    const path = require('node:path');
    const ledgerPath = path.join(process.cwd(), '.cycles', 'gates', 'ledger.json');
    if (!fs.existsSync(ledgerPath)) return; // 场地上无账本 ⇒ 跳过（不假装通过）
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { entries: unknown[] };
    const entries = ledger.entries as ReadonlyArray<{ gate?: string; result?: string; timestamp?: string }>;
    const samples = failEpisodes(entries);
    if (samples.length < 20) return;
    const r = kaplanMeier(samples);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ① 收敛且数值有限（kaplanMeier 内部已保证，这里显式钉死）
    expect(Number.isFinite(r.value.medianMs)).toBe(true);
    expect(r.value.degenerateCi).toBe(false);
    expect(r.value.medianCi95Ms).not.toBeNull();
    // ② CI 必须包住中位数（Brookmeyer-Crowley 反演正确性的不变量）
    const ci = r.value.medianCi95Ms as [number, number];
    expect(ci[0]).toBeLessThanOrEqual(r.value.medianMs as number);
    expect(ci[1]).toBeGreaterThanOrEqual(r.value.medianMs as number);
    // ③ 修复时长语义：中位数为正且 CI 为正（时长不可能为负）
    expect(r.value.medianMs as number).toBeGreaterThan(0);
    expect(ci[0]).toBeGreaterThan(0);
  });

  it('**全样本读数无 NaN / Infinity**（数值稳定性总检）', () => {
    const samples = Array.from({ length: 40 }, (_, i) => s(i * 100, i % 3 !== 0));
    const r = kaplanMeier(samples, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const step of r.value.steps) {
      expect(Number.isFinite(step.survival)).toBe(true);
      expect(Number.isFinite(step.greenwoodSe)).toBe(true);
      expect(step.survival).toBeGreaterThanOrEqual(0);
      expect(step.survival).toBeLessThanOrEqual(1);
    }
    if (r.value.medianCi95Ms !== null) {
      for (const v of r.value.medianCi95Ms) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('failEpisodes：从账本切「FAIL → PASS」修复时长', () => {
  it('**FAIL 后 PASS ⇒ 一条 event 样本**', () => {
    const entries = [
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:00:00.000Z' },
      { gate: 'G2', result: 'PASS', timestamp: '2026-10-30T00:01:00.000Z' },
    ];
    const s2 = failEpisodes(entries);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.durationMs).toBe(60000);
    expect(s2[0]?.event).toBe(true);
  });

  it('**FAIL 后无 PASS ⇒ 右删失**（event=false）', () => {
    const entries = [
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:00:00.000Z' },
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:01:00.000Z' },
    ];
    const s2 = failEpisodes(entries);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.event).toBe(false);
  });

  it('**连续 FAIL 保留最早起点**（修一次要修到底）', () => {
    const entries = [
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:00:00.000Z' },
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:01:00.000Z' },
      { gate: 'G2', result: 'PASS', timestamp: '2026-10-30T00:03:00.000Z' },
    ];
    const s2 = failEpisodes(entries);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.durationMs).toBe(180000); // 从最早 FAIL 起算
  });

  it('**PASS 不开 episode**（只测「修复耗时」）', () => {
    const entries = [
      { gate: 'G2', result: 'PASS', timestamp: '2026-10-30T00:00:00.000Z' },
      { gate: 'G2', result: 'PASS', timestamp: '2026-10-30T00:01:00.000Z' },
    ];
    expect(failEpisodes(entries)).toHaveLength(0);
  });

  it('**逐门独立切分**（不把不同门串成一条假时间线）', () => {
    const entries = [
      { gate: 'G0', result: 'FAIL', timestamp: '2026-10-30T00:00:00.000Z' },
      { gate: 'G1', result: 'PASS', timestamp: '2026-10-30T00:00:30.000Z' },
      { gate: 'G0', result: 'PASS', timestamp: '2026-10-30T00:02:00.000Z' },
    ];
    const s2 = failEpisodes(entries);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.durationMs).toBe(120000);
  });

  it('**无序输入被正确排序**（账本本是有序的，但函数不假设）', () => {
    const entries = [
      { gate: 'G2', result: 'PASS', timestamp: '2026-10-30T00:01:00.000Z' },
      { gate: 'G2', result: 'FAIL', timestamp: '2026-10-30T00:00:00.000Z' },
    ];
    const s2 = failEpisodes(entries);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.durationMs).toBe(60000);
  });
});
