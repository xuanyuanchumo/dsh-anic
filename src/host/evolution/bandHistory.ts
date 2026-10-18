/**
 * band-history.json 双 schema 归一化与读取（cycle-21 从 bandDetector.ts 拆出，
 * T3 ≤250 行一域一文件：检测算法留在 bandDetector.ts，历史 schema 域在此）。
 *
 * 两代 schema 共存是生产事实：
 * - 代码质量带（技能 band-detector.mjs:251-260 写入，真实主流形状）：
 *   {timestamp,totalScore,avgScore,fileCount,overBudgetCount}
 * - 自主带（插件 runBandDetection 写入）：BandEntry{cycle,score,timestamp,band}
 *
 * cycle-20 真机事故：orgStatus 盲 map(e=>e.score) 对质量带历史产出
 * [null,null]——仪表带火花线拿不到数据；classifyBand 0.7/0.5 阈值对
 * avgScore（复杂度分量纲）套用还会误报 alarm。本模块的归一化读取修复之。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 架构注记（Q5）：本模块是 evolution 域的 schema 基座——bandDetector.ts
// （检测算法）单向依赖本文件，本文件不依赖任何同域模块。此前曾在两者间
// re-export 算法函数造成 eval-runner Q5 环检测 FAIL（bandDetector ↔
// bandHistory 双向 import）；类型 BandStatus/BandEntry 因此下沉到本文件。

/** 性能带状态（自主带分数 0-1 量纲的三档分类）。 */
export type BandStatus = 'normal' | 'warn' | 'alarm';

/** 自主带历史 entry（插件 runBandDetection 写入的形状）。 */
export interface BandEntry {
  cycle: number;
  score: number;
  timestamp: string;
  band: BandStatus;
}

/** 代码质量带历史 entry（技能 band-detector.mjs:251-257 写入的真实形状）。 */
export interface QualityBandEntry {
  timestamp: string;
  totalScore: number;
  avgScore: number;
  fileCount: number;
  overBudgetCount: number;
}

/** band-history.json 的规范路径（相对 workspace 根）。 */
export const BAND_HISTORY_PATH = join('.cycles', 'band-history.json');

/**
 * entry → 分数（优先 score 自主带，否则 avgScore 质量带）。
 * 双缺/非有限值 → null（不伪造 0 分）。
 */
function entryScore(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const rec = e as Record<string, unknown>;
  const score = rec['score'];
  if (typeof score === 'number' && Number.isFinite(score)) return score;
  const avg = rec['avgScore'];
  if (typeof avg === 'number' && Number.isFinite(avg)) return avg;
  return null;
}

/** 判断 entry 是否为自主带形状（BandEntry 有 cycle+band 字段）。 */
function isAutonomyEntry(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const rec = e as Record<string, unknown>;
  return typeof rec['band'] === 'string' && typeof rec['cycle'] === 'number';
}

/** 归一化历史 → 自主带 entry 序列（只保留 BandEntry 形状）。 */
export function autonomyEntries(history: unknown[]): BandEntry[] {
  return history.filter(isAutonomyEntry) as BandEntry[];
}

/** 读原始历史数组（损坏/非数组/缺失 → 空数组，fail-safe）。 */
export function loadRawHistory(workspaceRoot: string): unknown[] {
  const p = join(workspaceRoot, BAND_HISTORY_PATH);
  if (!existsSync(p)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** band-history → 自主带 entry 序列（BandEntry 消费面，如 runBandDetection 续编）。 */
export function loadBandHistory(workspaceRoot: string): BandEntry[] {
  return autonomyEntries(loadRawHistory(workspaceRoot));
}

/**
 * band-history → 分数序列 + 量纲标记（orgStatus 的 trend/WE/火花线消费面）。
 *
 * 量纲感知：自主带 entry（score，0-1 量纲，classifyBand 的 0.7/0.5 阈值只对
 * 它有意义）与质量带 entry（avgScore，复杂度分量纲）不混算。自主带存在 →
 * 只用自主带分数；自主带为空 → 质量带 avgScore 仍可看趋势形状（WE 规则是
 * 量纲无关的统计形状检测），但调用方不得用质量带分数判 band。
 */
export function loadHistoryScores(workspaceRoot: string): { scores: number[]; source: 'autonomy' | 'quality' | 'none' } {
  const history = loadRawHistory(workspaceRoot);
  const autonomy = autonomyEntries(history);
  if (autonomy.length > 0) {
    const scores = autonomy.map((e) => e.score).filter((s) => Number.isFinite(s));
    if (scores.length > 0) return { scores, source: 'autonomy' };
  }
  const quality = history.map(entryScore).filter((s): s is number => s !== null);
  return { scores: quality, source: quality.length > 0 ? 'quality' : 'none' };
}
