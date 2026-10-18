/**
 * band-history 双 schema 收敛契约（cycle-21）。
 *
 * 真实生产形状（.cycles/band-history.json）由技能 band-detector.mjs:251-260
 * 写入，是**代码质量带**：{timestamp,totalScore,avgScore,fileCount,overBudgetCount}。
 * 插件 BandEntry{cycle,score,timestamp,band} 是**自主带**形状（runBandDetection
 * 续写）。cycle-20 真机发现：orgStatus 盲 map(e=>e.score) 产出 [null,null]，
 * 仪表带火花线拿不到数据；classifyBand 0.7/0.5 阈值对 avgScore（复杂度分
 * 量纲）套用还会误报 alarm。
 *
 * 本套件钉死三件事：
 * 1. loadBandHistory 只返回自主带形状 entry（BandEntry 消费面契约不变）；
 * 2. loadHistoryScores 量纲感知三态（autonomy 优先 / quality 兜底 / none）；
 * 3. orgStatus 对质量带工作区 band.current='normal' 不误报（回归测试）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBandHistory, loadHistoryScores } from '../../src/host/evolution/bandHistory.ts';
import { runBandDetection } from '../../src/host/evolution/bandDetector.ts';
import { runOrgStatus } from '../../src/host/evolution/orgStatus.ts';

const TMP = join(tmpdir(), `anic-bandschema-${Date.now()}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, '.cycles'), { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** 质量带历史（技能 band-detector.mjs 写入的真实形状，38 条生产数据同构）。 */
function writeQualityHistory(avgScores: number[]): void {
  writeFileSync(
    join(TMP, '.cycles', 'band-history.json'),
    JSON.stringify(avgScores.map((avgScore, i) => ({
      timestamp: `2026-10-01T00:0${i}:00.000Z`,
      totalScore: Math.round(avgScore * 100),
      avgScore,
      fileCount: 100,
      overBudgetCount: 0,
    }))),
    'utf-8',
  );
}

/** 自主带历史（插件 runBandDetection 写入的 BandEntry 形状）。 */
function writeAutonomyHistory(scores: number[]): void {
  writeFileSync(
    join(TMP, '.cycles', 'band-history.json'),
    JSON.stringify(scores.map((score, i) => ({ cycle: i + 1, score, timestamp: '2026-01-01', band: 'warn' }))),
    'utf-8',
  );
}

describe('loadBandHistory（只回自主带形状）', () => {
  it('纯质量带文件 → 空数组（BandEntry 消费面不被质量带污染）', () => {
    writeQualityHistory([18.7, 18.8, 18.9]);
    expect(loadBandHistory(TMP)).toEqual([]);
  });

  it('混合文件 → 只保留自主带 entry（两代 schema 共存不炸）', () => {
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([
        { timestamp: 't', totalScore: 100, avgScore: 18.5, fileCount: 10, overBudgetCount: 0 },
        { cycle: 1, score: 0.8, timestamp: 't', band: 'normal' },
        { timestamp: 't2', totalScore: 110, avgScore: 18.6, fileCount: 11, overBudgetCount: 0 },
        { cycle: 2, score: 0.6, timestamp: 't2', band: 'warn' },
      ]),
      'utf-8',
    );
    const entries = loadBandHistory(TMP);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.cycle).toBe(1);
    expect(entries[1]?.score).toBe(0.6);
  });

  it('损坏 JSON / 非数组 / 缺失 → fail-safe 空数组', () => {
    writeFileSync(join(TMP, '.cycles', 'band-history.json'), '[broken', 'utf-8');
    expect(loadBandHistory(TMP)).toEqual([]);
    writeFileSync(join(TMP, '.cycles', 'band-history.json'), '{"a":1}', 'utf-8');
    expect(loadBandHistory(TMP)).toEqual([]);
    rmSync(join(TMP, '.cycles', 'band-history.json'), { force: true });
    expect(loadBandHistory(TMP)).toEqual([]);
  });
});

describe('loadHistoryScores（量纲感知三态）', () => {
  it('纯质量带 → source=quality，scores=avgScore 序列（趋势形状仍可用）', () => {
    writeQualityHistory([19.3, 18.9, 18.8, 17.8]);
    const r = loadHistoryScores(TMP);
    expect(r.source).toBe('quality');
    expect(r.scores).toEqual([19.3, 18.9, 18.8, 17.8]);
  });

  it('纯自主带 → source=autonomy，scores=score 序列（阈值语义正确）', () => {
    writeAutonomyHistory([0.5, 0.7, 0.9]);
    const r = loadHistoryScores(TMP);
    expect(r.source).toBe('autonomy');
    expect(r.scores).toEqual([0.5, 0.7, 0.9]);
  });

  it('混合 → autonomy 优先（质量带不混入自主带序列）', () => {
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([
        { timestamp: 't', totalScore: 100, avgScore: 18.5, fileCount: 10, overBudgetCount: 0 },
        { cycle: 1, score: 0.8, timestamp: 't', band: 'normal' },
        { timestamp: 't2', totalScore: 110, avgScore: 18.6, fileCount: 11, overBudgetCount: 0 },
      ]),
      'utf-8',
    );
    const r = loadHistoryScores(TMP);
    expect(r.source).toBe('autonomy');
    expect(r.scores).toEqual([0.8]);
  });

  it('损坏/非数组/空文件 → source=none，scores=[]（不伪造）', () => {
    writeFileSync(join(TMP, '.cycles', 'band-history.json'), '[broken', 'utf-8');
    expect(loadHistoryScores(TMP)).toEqual({ scores: [], source: 'none' });
    writeFileSync(join(TMP, '.cycles', 'band-history.json'), '"nope"', 'utf-8');
    expect(loadHistoryScores(TMP)).toEqual({ scores: [], source: 'none' });
    writeFileSync(join(TMP, '.cycles', 'band-history.json'), '[]', 'utf-8');
    expect(loadHistoryScores(TMP)).toEqual({ scores: [], source: 'none' });
  });

  it('score 非有限的自主带 entry 被剔除（NaN/Infinity 不入序列）', () => {
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([
        { cycle: 1, score: 0.8, timestamp: 't', band: 'normal' },
        { cycle: 2, score: 'oops', timestamp: 't', band: 'warn' },
      ]),
      'utf-8',
    );
    const r = loadHistoryScores(TMP);
    expect(r.scores).toEqual([0.8]);
  });
});

describe('orgStatus 双 schema 集成（cycle-20 真机回归）', () => {
  it('质量带工作区 → band.current=normal 不误报 alarm（avgScore≈18 套 0.5 阈值必炸的回归）', () => {
    writeQualityHistory([18.7, 18.8, 18.9, 18.7]);
    const result = runOrgStatus(TMP, {});
    expect(result.band.current).toBe('normal');
  });

  it('质量带工作区 → recent 仍携带分数序列（趋势/火花线形状可看，量纲是复杂度分）', () => {
    writeQualityHistory([19.3, 18.9, 18.8]);
    const result = runOrgStatus(TMP, {});
    expect(result.band.recent).toEqual([19.3, 18.9, 18.8]);
  });

  it('质量带趋势可用：avgScore 单调下滑 → degrading（复杂度持续恶化是真实信号）', () => {
    writeQualityHistory([19.5, 19.4, 19.3, 19.2, 19.1, 19.0, 18.9, 18.8]);
    const result = runOrgStatus(TMP, {});
    expect(result.band.trend).toBe('degrading');
  });

  it('自主带工作区 → 阈值分类生效（末条 0.9 → normal，末条 0.3 → alarm）', () => {
    writeAutonomyHistory([0.5, 0.6, 0.9]);
    expect(runOrgStatus(TMP, {}).band.current).toBe('normal');
    writeAutonomyHistory([0.9, 0.5, 0.3]);
    expect(runOrgStatus(TMP, {}).band.current).toBe('alarm');
  });
});

describe('runBandDetection 写侧收敛（追加保留混合 schema，统计只取自主带）', () => {
  it('在质量带历史上运行 → 质量带 entry 原样保留（不摧毁技能写入的历史）', () => {
    writeQualityHistory([18.7, 18.8, 18.9]);
    const result = runBandDetection(TMP, 0.8);
    expect(result.entries).toHaveLength(1); // 只有本条新增
    expect(result.entries[0]?.cycle).toBe(1); // 自主带序列从 1 起编（非 4）
    // 文件侧：38→3 条质量带 + 1 条新自主带，全部保留
    const raw = JSON.parse(readFileSync(join(TMP, '.cycles', 'band-history.json'), 'utf-8')) as unknown[];
    expect(raw).toHaveLength(4);
    expect(raw[0]).toHaveProperty('avgScore');
    expect(raw[3]).toHaveProperty('band');
  });

  it('混合历史上追加 → cycle 基于自主带子序列编号，不与质量带数量耦合', () => {
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([
        { timestamp: 't', totalScore: 100, avgScore: 18.5, fileCount: 10, overBudgetCount: 0 },
        { cycle: 1, score: 0.8, timestamp: 't', band: 'normal' },
        { timestamp: 't2', totalScore: 110, avgScore: 18.6, fileCount: 11, overBudgetCount: 0 },
      ]),
      'utf-8',
    );
    const result = runBandDetection(TMP, 0.6);
    expect(result.entries.at(-1)?.cycle).toBe(2); // 1 条既有自主带 + 本条
    const raw = JSON.parse(readFileSync(join(TMP, '.cycles', 'band-history.json'), 'utf-8')) as unknown[];
    expect(raw).toHaveLength(4); // 全量保留 + 追加
  });

  it('纯自主带历史 → 续编行为与旧行一致（cycle 递增/trend 用全量自主分数）', () => {
    writeAutonomyHistory([0.5, 0.6, 0.7, 0.8]);
    const result = runBandDetection(TMP, 0.9);
    expect(result.entries.at(-1)?.cycle).toBe(5);
    expect(result.trend).toBe('improving');
    expect(result.current).toBe('normal');
  });
});
