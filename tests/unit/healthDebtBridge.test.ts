/**
 * cycle-55 T-5501：健康建议 → tech-debt 提案落盘桥测试。
 *
 * 覆盖：severity 映射 / entry 形状 / 首次落盘 / 同日幂等（written/skipped
 * 分开计数）/ 跨日新提案（恶化可追踪）/ 空建议零落盘 / 损坏既有文件重建
 * 语义 / 与 listTechDebt 的互操作（落盘的提案能被队列读面消费——合流
 * 的端到端验证）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapSeverity, suggestionToEntry, persistHealthSuggestionsAsDebt } from '../../src/host/evolution/healthDebtBridge.ts';
import { listTechDebt } from '../../src/host/evolution/techDebtQueue.ts';
import type { ImprovementSuggestion } from '../../src/host/runtime/continuousLearning.ts';

function sugg(overrides: Partial<ImprovementSuggestion> = {}): ImprovementSuggestion {
  return {
    id: 'sugg-gate-check-critical',
    severity: 'critical',
    script: 'gate-check',
    description: 'gate-check 近期成功率 57%，低于阈值 70%',
    action: '检查最近失败批次的失败模式并修复根因',
    ...overrides,
  };
}

const NOW = '2026-10-21T14:30:00.000Z';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-healthdebt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('cycle-55 T-5501 healthDebtBridge 纯函数', () => {
  it('severity 映射：critical→critical / warn→medium / info→low', () => {
    expect(mapSeverity('critical')).toBe('critical');
    expect(mapSeverity('warn')).toBe('medium');
    expect(mapSeverity('info')).toBe('low');
  });

  it('suggestionToEntry：TechDebtEntry 完整形状（id 带日期/dimension 带 skill: 前缀）', () => {
    const e = suggestionToEntry(sugg(), NOW);
    expect(e).toEqual({
      id: 'health-sugg-gate-check-critical-2026-10-21',
      dimension: 'skill:gate-check',
      severity: 'critical',
      description: 'gate-check 近期成功率 57%，低于阈值 70%',
      proposedAction: '检查最近失败批次的失败模式并修复根因',
      createdAt: NOW,
      resolved: false,
    });
  });
});

describe('cycle-55 T-5501 persistHealthSuggestionsAsDebt 落盘语义', () => {
  it('空建议零落盘（file=null）', () => {
    const r = persistHealthSuggestionsAsDebt(dir, [], NOW);
    expect(r).toEqual({ written: 0, skipped: 0, file: null });
    expect(existsSync(join(dir, 'tech-debt'))).toBe(false);
  });

  it('首次落盘：health-<date>.json 数组形态', () => {
    const r = persistHealthSuggestionsAsDebt(dir, [sugg(), sugg({ id: 'sugg-qv', severity: 'warn', script: 'quick-validate' })], NOW);
    expect(r.written).toBe(2);
    expect(r.file).toBe('health-2026-10-21.json');
    const raw = JSON.parse(readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf-8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(2);
    expect(raw[0].id).toBe('health-sugg-gate-check-critical-2026-10-21');
  });

  it('同日幂等：重复调用 written=0 skipped=全量，文件字节不变', () => {
    persistHealthSuggestionsAsDebt(dir, [sugg()], NOW);
    const before = readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf-8');
    const r = persistHealthSuggestionsAsDebt(dir, [sugg()], NOW);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
    const after = readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('跨日新提案：同 id 不同日期产新文件（恶化可追踪）', () => {
    persistHealthSuggestionsAsDebt(dir, [sugg()], NOW);
    const r2 = persistHealthSuggestionsAsDebt(dir, [sugg()], '2026-10-22T09:00:00.000Z');
    expect(r2.written).toBe(1);
    expect(r2.file).toBe('health-2026-10-22.json');
    expect(existsSync(join(dir, 'tech-debt', 'health-2026-10-22.json'))).toBe(true);
  });

  it('损坏既有文件按空集重建（不抛不吞）', () => {
    const td = join(dir, 'tech-debt');
    require('node:fs').mkdirSync(td, { recursive: true });
    writeFileSync(join(td, 'health-2026-10-21.json'), '{corrupted', 'utf-8');
    const r = persistHealthSuggestionsAsDebt(dir, [sugg()], NOW);
    expect(r.written).toBe(1);
    const raw = JSON.parse(readFileSync(join(td, 'health-2026-10-21.json'), 'utf-8'));
    expect(raw).toHaveLength(1);
  });

  it('端到端互操作：落盘的提案被 listTechDebt 读面消费为 open 条目（合流验证）', () => {
    persistHealthSuggestionsAsDebt(dir, [sugg({ severity: 'warn', script: 'workflow-state' })], NOW);
    const listing = listTechDebt(dir);
    expect(listing.open).toHaveLength(1);
    expect(listing.open[0].entry.dimension).toBe('skill:workflow-state');
    expect(listing.open[0].entry.severity).toBe('medium');
    expect(listing.skipped).toHaveLength(0);
  });
});
