/**
 * 债务复核事实读面单测（cycle-108 · doc 26 §3 B1）。
 *
 * 关键纪律（全部有断言）：
 *  - 维度裁决行按**最后一条**取值（后写覆盖先写，报告可能被增量追加）；
 *  - 只扫**活跃面** `cycles/`，归档报告不得当本轮判据；
 *  - 读不到报告/账本损坏 ⇒ 空事实（后果是 unverifiable，不是 PASS）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDimensionVerdicts, readDebtFacts } from '../../src/host/evolution/debtFacts.ts';

const REPORT = [
  '# 项目评估报告',
  '| 维度 | 名称 | 裁决 | 证据 |',
  '| --- | --- | --- | --- |',
  '| E3 | 测试覆盖 | FAIL | stale row |',
  '| E4 | 代码质量 | FAIL | round 2 老结论 |',
  '| Q7 | 代码与工程 | PASS | ok |',
  // 同一维度的**后写**行才是当前结论（增量报告会重写裁定）
  '| E4 | 代码质量 | PASS | now green |',
  '| Q8 | 评审与验收 | SKIP | 不可评估 |',
].join('\n');

describe('parseDimensionVerdicts', () => {
  it('解析 16 维度行，同维度取最后一条', () => {
    const v = parseDimensionVerdicts(REPORT);
    expect(v['E4']).toBe('PASS'); // 后写覆盖
    expect(v['E3']).toBe('FAIL');
    expect(v['Q7']).toBe('PASS');
    expect(v['Q8']).toBe('SKIP');
  });

  it('非裁决行 / 小写 / 非维度标识不误收', () => {
    const v = parseDimensionVerdicts('| X9 | 别的 | PASS | x |\n| E4 | 代码质量 | pass | x |\n| E5 |');
    expect(v['X9']).toBeUndefined();
    expect(v['E4']).toBeUndefined();
  });
});

describe('readDebtFacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anic-debtfacts-'));
  });
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  function seed(cycle: string | null, gates: string[]): void {
    const base = join(dir, 'cycles');
    mkdirSync(base, { recursive: true });
    if (cycle !== null) {
      mkdirSync(join(base, cycle), { recursive: true });
      writeFileSync(join(base, cycle, '项目评估报告.md'), REPORT);
    }
    if (gates.length > 0) {
      mkdirSync(join(dir, 'gates'), { recursive: true });
      writeFileSync(join(dir, 'gates', 'ledger.json'), JSON.stringify(
        gates.map((g, i) => ({ gate: g, result: 'PASS', detail: 'x', timestamp: `2026-11-06T00:00:0${String(i)}Z` })),
      ));
    }
  }

  it('取**最新**活跃循环的报告；证据含路径 + sha256 摘要', () => {
    seed('cycle-105', ['G0', 'G1', 'G2', 'G3']);
    mkdirSync(join(dir, 'cycles', 'cycle-107'), { recursive: true });
    writeFileSync(join(dir, 'cycles', 'cycle-107', '项目评估报告.md'), '| E4 | 代码质量 | PASS | new |');
    const f = readDebtFacts(dir);
    expect(f.cycle).toBe('cycle-107');
    expect(f.reportPath).toBe('.cycles/cycles/cycle-107/项目评估报告.md');
    expect(f.digest).toHaveLength(8);
    expect(f.dimensions['E4']).toBe('PASS');
    expect(f.gatesAllPass).toBe(true);
  });

  it('归档报告不得当本轮判据（只扫活跃面）', () => {
    mkdirSync(join(dir, 'archive', 'cycle-104'), { recursive: true });
    writeFileSync(join(dir, 'archive', 'cycle-104', '项目评估报告.md'), REPORT);
    const f = readDebtFacts(dir);
    expect(f.cycle).toBeNull();
    expect(f.dimensions).toEqual({});
    expect(f.gatesAllPass).toBe(false);
  });

  it('门缺口 / 账本损坏 ⇒ gatesAllPass=false（不假绿）', () => {
    seed('cycle-108', ['G0', 'G1', 'G2']);
    expect(readDebtFacts(dir).gatesAllPass).toBe(false);
    writeFileSync(join(dir, 'gates', 'ledger.json'), '{ not json');
    const f = readDebtFacts(dir);
    expect(f.gates).toEqual({});
    expect(f.gatesAllPass).toBe(false);
  });

  it('同门多次裁决取最后一次', () => {
    mkdirSync(join(dir, 'gates'), { recursive: true });
    writeFileSync(join(dir, 'gates', 'ledger.json'), JSON.stringify([
      { gate: 'G0', result: 'FAIL' },
      { gate: 'G0', result: 'PASS' },
    ]));
    expect(readDebtFacts(dir).gates['G0']).toBe('PASS');
  });
});