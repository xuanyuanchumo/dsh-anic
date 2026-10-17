/**
 * bandDetector Western Electric 8 规则契约（R3 阶段 3）。
 *
 * 逐字移植技能 band-detector.mjs:117-203 的模式检测族。每条规则用最小
 * 构造序列触发 + 反例不触发；边界（stdDev=0 / 空序列）与技能同款短路。
 */
import { describe, expect, it } from 'vitest';
import {
  bandStats, applyWesternElectricRules, detectWeViolations, classifyBand, detectTrend,
} from '../../src/host/evolution/bandDetector.ts';

/** 以 0 为均值、1 为 σ 的规则序列构造辅助。 */
function seq(n: number, fill: (i: number) => number): number[] {
  return Array.from({ length: n }, (_, i) => fill(i));
}

describe('bandStats', () => {
  it('均值/标准差（总体方差）', () => {
    expect(bandStats([])).toEqual({ mean: 0, stdDev: 0 });
    const { mean, stdDev } = bandStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBe(5);
    expect(stdDev).toBe(2);
  });
  it('全等序列 → stdDev 0', () => {
    expect(bandStats([3, 3, 3]).stdDev).toBe(0);
  });
});

describe('applyWesternElectricRules（技能逐字移植）', () => {
  it('stdDev=0 或空序列 → 零违例（技能同款短路）', () => {
    expect(applyWesternElectricRules([1, 1, 1], 1, 0)).toEqual([]);
    expect(applyWesternElectricRules([], 0, 1)).toEqual([]);
  });

  it('规则 1：单点超出 3σ', () => {
    const data = seq(10, () => 0).concat([3.5]); // 均值≈0.32,σ≈1.05 — 直接构造 0 均值 1σ 更稳
    const mean0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    const { mean, stdDev } = bandStats(mean0);
    const v = applyWesternElectricRules(mean0, mean, stdDev);
    expect(v.some((x) => x.rule === 1)).toBe(true);
    expect(data.length).toBe(11);
  });

  it('规则 2：2/3 点同侧 2σ 外', () => {
    // 均值 0 σ 1：连续两点 2.5 在 +2σ 外，第三点回中
    const data = [0, 0, 0, 0, 0, 0, 2.5, 2.5, 0, 0, 0, 0];
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 2)).toBe(true);
  });

  it('规则 3：4/5 点同侧 1σ 外', () => {
    const data = [0, 0, 0, 0, 0, 0, 1.5, 1.5, 1.5, 1.5, 0, 0, 0, 0];
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 3)).toBe(true);
  });

  it('规则 4：连续 8 点中心线同侧', () => {
    const data = [1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1];
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 4)).toBe(true);
  });

  it('规则 5：连续 6 点单调递增', () => {
    const data = [0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 0, 0];
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 5)).toBe(true);
  });

  it('规则 6：连续 14 点交替（相对均值交替）', () => {
    // 严格 +1/-1 交替且窗口恰好 14 点
    const alt = Array.from({ length: 22 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const { mean, stdDev } = bandStats(alt);
    const v = applyWesternElectricRules(alt, mean, stdDev);
    expect(v.some((x) => x.rule === 6)).toBe(true);
  });

  it('规则 7：连续 15 点在 1σ 内（变异过小）', () => {
    const data = Array.from({ length: 30 }, (_, i) => (i < 15 ? (i % 2 === 0 ? 5 : -5) : (i % 2 === 0 ? 0.1 : -0.1)));
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 7)).toBe(true);
  });

  it('规则 8：连续 8 点在 1σ 外（变异过大）', () => {
    // 大幅交替使 σ 巨大 → 前段小值连续 8 点落在 1σ 外
    const data = Array.from({ length: 24 }, (_, i) => (i < 8 ? 0 : (i % 2 === 0 ? 100 : -100)));
    const { mean, stdDev } = bandStats(data);
    const v = applyWesternElectricRules(data, mean, stdDev);
    expect(v.some((x) => x.rule === 8)).toBe(true);
  });

  it('平稳序列（正弦小幅波动）无任何违例', () => {
    const data = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.3);
    const { mean, stdDev } = bandStats(data);
    expect(applyWesternElectricRules(data, mean, stdDev)).toEqual([]);
  });

  it('违例对象字段与技能逐字同形（rule/index/value/desc 中文）', () => {
    const mean0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    const { mean, stdDev } = bandStats(mean0);
    const v = applyWesternElectricRules(mean0, mean, stdDev);
    const r1 = v.find((x) => x.rule === 1)!;
    expect(r1.index).toBe(10);
    expect(r1.value).toBe(4);
    expect(r1.desc).toBe('单点超出 3σ 控制带');
  });
});

describe('detectWeViolations（序列封装）', () => {
  it('先算统计量再套规则', () => {
    expect(detectWeViolations([])).toEqual([]);
    expect(detectWeViolations([5, 5, 5])).toEqual([]);
  });
  it('与 applyWesternElectricRules(bandStats) 全等', () => {
    const data = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 2.5, 2.5];
    const { mean, stdDev } = bandStats(data);
    expect(detectWeViolations(data)).toEqual(applyWesternElectricRules(data, mean, stdDev));
  });
});

describe('既有两阈值分类（回归不受 WE 移植影响）', () => {
  it('classifyBand 三带', () => {
    expect(classifyBand(0.9)).toBe('normal');
    expect(classifyBand(0.6)).toBe('warn');
    expect(classifyBand(0.3)).toBe('alarm');
  });
  it('detectTrend 三态', () => {
    expect(detectTrend([0.5, 0.6, 0.7, 0.8, 0.85])).toBe('improving');
    expect(detectTrend([0.9, 0.8, 0.7, 0.6, 0.55])).toBe('degrading');
    expect(detectTrend([0.7, 0.7, 0.7])).toBe('stable');
  });
});
