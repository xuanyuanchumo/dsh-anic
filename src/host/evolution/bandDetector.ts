/**
 * 性能带检测（原生实现，替代技能 band-detector.mjs）。
 * 分析评估分数序列，检测性能退化带（normal/warn/alarm）+ Western Electric 模式规则。
 *
 * R3 阶段 3：补齐技能 band-detector.mjs:117-203 的 8 条 Western Electric
 * 控制图规则（此前插件侧只有两阈值分类，模式检测整族缺失）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BandStatus = 'normal' | 'warn' | 'alarm';

export interface BandEntry {
  cycle: number;
  score: number;
  timestamp: string;
  band: BandStatus;
}

/** WE 规则违例（字段与技能 band-detector.mjs 违例对象逐字同形）。 */
export interface WeViolation {
  rule: number;
  index: number;
  value: number;
  desc: string;
}

export interface BandResult {
  current: BandStatus;
  trend: 'improving' | 'stable' | 'degrading';
  entries: BandEntry[];
  threshold: { warn: number; alarm: number };
  /** Western Electric 模式违例（空数组 = 无模式异常）。 */
  weViolations: WeViolation[];
}

const DEFAULT_THRESHOLDS = { warn: 0.7, alarm: 0.5 };
const BAND_HISTORY_PATH = join('.cycles', 'band-history.json');

export function classifyBand(score: number, thresholds = DEFAULT_THRESHOLDS): BandStatus {
  if (score >= thresholds.warn) return 'normal';
  if (score >= thresholds.alarm) return 'warn';
  return 'alarm';
}

export function detectTrend(scores: number[]): 'improving' | 'stable' | 'degrading' {
  if (scores.length < 2) return 'stable';
  const recent = scores.slice(-3);
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgPrev = scores.slice(0, -1).slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, scores.length - 1);
  const delta = avgRecent - avgPrev;
  if (delta > 0.05) return 'improving';
  if (delta < -0.05) return 'degrading';
  return 'stable';
}

/** 均值/标准差（技能 band-detector.mjs:110-115 同式）。 */
export function bandStats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Western Electric 8 规则（逐字移植技能 band-detector.mjs:117-203）。
 * 规则集为技能自定变体：1=单点 3σ 外；2=2/3 点同侧 2σ 外；3=4/5 点同侧 1σ 外；
 * 4=连续 8 点同侧；5=连续 6 点单调；6=连续 14 点交替；7=连续 15 点 1σ 内；
 * 8=连续 8 点 1σ 外。stdDev=0 或空序列 → 无违例（技能同款短路）。
 */
export function applyWesternElectricRules(dataPoints: number[], mean: number, stdDev: number): WeViolation[] {
  const violations: WeViolation[] = [];
  if (stdDev === 0 || dataPoints.length === 0) return violations;

  const sigma1 = mean + stdDev;
  const sigma1Low = mean - stdDev;
  const sigma2 = mean + 2 * stdDev;
  const sigma2Low = mean - 2 * stdDev;
  const sigma3 = mean + 3 * stdDev;
  const sigma3Low = mean - 3 * stdDev;

  for (let i = 0; i < dataPoints.length; i++) {
    const v = dataPoints[i]!;
    if (v > sigma3 || v < sigma3Low) {
      violations.push({ rule: 1, index: i, value: v, desc: '单点超出 3σ 控制带' });
    }
  }

  for (let i = 2; i < dataPoints.length; i++) {
    const recent3 = [dataPoints[i - 2]!, dataPoints[i - 1]!, dataPoints[i]!];
    const above2 = recent3.filter((v) => v > sigma2).length;
    const below2 = recent3.filter((v) => v < sigma2Low).length;
    if (above2 >= 2 || below2 >= 2) {
      violations.push({ rule: 2, index: i, value: dataPoints[i]!, desc: '连续 2/3 点在同侧 2σ 外' });
    }
  }

  for (let i = 4; i < dataPoints.length; i++) {
    const recent5 = dataPoints.slice(i - 4, i + 1);
    const above1 = recent5.filter((v) => v > sigma1).length;
    const below1 = recent5.filter((v) => v < sigma1Low).length;
    if (above1 >= 4 || below1 >= 4) {
      violations.push({ rule: 3, index: i, value: dataPoints[i]!, desc: '连续 4/5 点在同侧 1σ 外' });
    }
  }

  for (let i = 7; i < dataPoints.length; i++) {
    const recent8 = dataPoints.slice(i - 7, i + 1);
    if (recent8.every((v) => v > mean) || recent8.every((v) => v < mean)) {
      violations.push({ rule: 4, index: i, value: dataPoints[i]!, desc: '连续 8 点在中心线同侧' });
    }
  }

  for (let i = 5; i < dataPoints.length; i++) {
    const recent6 = dataPoints.slice(i - 5, i + 1);
    let increasing = true;
    let decreasing = true;
    for (let j = 1; j < recent6.length; j++) {
      if (recent6[j]! <= recent6[j - 1]!) increasing = false;
      if (recent6[j]! >= recent6[j - 1]!) decreasing = false;
    }
    if (increasing || decreasing) {
      violations.push({ rule: 5, index: i, value: dataPoints[i]!, desc: '连续 6 点持续递增或递减' });
    }
  }

  for (let i = 13; i < dataPoints.length; i++) {
    const recent14 = dataPoints.slice(i - 13, i + 1);
    let alternating = true;
    for (let j = 1; j < recent14.length; j++) {
      if ((recent14[j]! > mean) === (recent14[j - 1]! > mean)) {
        alternating = false;
        break;
      }
    }
    if (alternating) {
      violations.push({ rule: 6, index: i, value: dataPoints[i]!, desc: '连续 14 点交替上下' });
    }
  }

  for (let i = 14; i < dataPoints.length; i++) {
    const recent15 = dataPoints.slice(i - 14, i + 1);
    if (recent15.every((v) => Math.abs(v - mean) < stdDev)) {
      violations.push({ rule: 7, index: i, value: dataPoints[i]!, desc: '连续 15 点在 1σ 内（变异过小）' });
    }
  }

  for (let i = 7; i < dataPoints.length; i++) {
    const recent8 = dataPoints.slice(i - 7, i + 1);
    if (recent8.every((v) => Math.abs(v - mean) > stdDev)) {
      violations.push({ rule: 8, index: i, value: dataPoints[i]!, desc: '连续 8 点在 1σ 外（变异过大）' });
    }
  }

  return violations;
}

/** 对分数序列跑 WE 规则（先算均值/σ 再套规则）。 */
export function detectWeViolations(scores: number[]): WeViolation[] {
  const { mean, stdDev } = bandStats(scores);
  return applyWesternElectricRules(scores, mean, stdDev);
}

export function runBandDetection(workspaceRoot: string, currentScore: number): BandResult {
  const historyPath = join(workspaceRoot, BAND_HISTORY_PATH);
  let entries: BandEntry[] = [];
  if (existsSync(historyPath)) {
    try { entries = JSON.parse(readFileSync(historyPath, 'utf-8')); } catch { entries = []; }
  }
  const band = classifyBand(currentScore);
  const entry: BandEntry = {
    cycle: entries.length + 1,
    score: currentScore,
    timestamp: new Date().toISOString(),
    band,
  };
  entries.push(entry);
  // 持久化（原子写简化版）
  try { writeFileSync(historyPath, JSON.stringify(entries, null, 2)); } catch { /* best effort */ }
  return {
    current: band,
    trend: detectTrend(entries.map((e) => e.score)),
    entries: entries.slice(-20),
    threshold: DEFAULT_THRESHOLDS,
    weViolations: detectWeViolations(entries.map((e) => e.score)),
  };
}

export function loadBandHistory(workspaceRoot: string): BandEntry[] {
  const p = join(workspaceRoot, BAND_HISTORY_PATH);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}
