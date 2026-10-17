/**
 * G-C3 tech-debt 消费队列 + G-C5 跨项目历史回写 —— cycle-16 新接线的行为级测试。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTechDebt, markTechDebtConsumed } from '../../src/host/evolution/techDebtQueue.ts';
import {
  appendCrossProjectHistory,
  readCrossProjectHistory,
} from '../../src/host/crossProjectHistory.ts';
import type { TechDebtEntry } from '../../src/host/evolution/patchEngine.ts';

function tempCycles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-gc35-'));
  return join(dir, '.cycles');
}

function sampleEntry(id: string, resolved = false): TechDebtEntry {
  return {
    id,
    dimension: 'E4',
    severity: 'high',
    description: `sample ${id}`,
    proposedAction: 'proposal text',
    createdAt: new Date().toISOString(),
    resolved,
  };
}

describe('techDebtQueue（G-C3 消费侧）', () => {
  it('空/不存在目录 → 空清单（不伪造）', () => {
    const cycles = tempCycles();
    const listing = listTechDebt(cycles);
    expect(listing.open).toEqual([]);
    expect(listing.resolved).toEqual([]);
    expect(listing.skipped).toEqual([]);
  });

  it('单体与数组两种落盘形态都被读出；open/resolved 正确分流', () => {
    const cycles = tempCycles();
    const tdDir = join(cycles, 'tech-debt');
    mkdirSync(tdDir, { recursive: true });
    writeFileSync(join(tdDir, 'debt-a.json'), JSON.stringify(sampleEntry('debt-a')), 'utf-8');
    writeFileSync(
      join(tdDir, 'fix-loop-1.json'),
      JSON.stringify([sampleEntry('debt-b'), sampleEntry('debt-c', true)]),
      'utf-8',
    );
    const listing = listTechDebt(cycles);
    expect(listing.open.map((o) => o.entry.id).sort()).toEqual(['debt-a', 'debt-b']);
    expect(listing.resolved.map((o) => o.entry.id)).toEqual(['debt-c']);
    expect(listing.skipped).toEqual([]);
  });

  it('自由形态提案（self-bootstrap round 文件）如实跳过并给原因，不吞不猜', () => {
    const cycles = tempCycles();
    const tdDir = join(cycles, 'tech-debt');
    mkdirSync(tdDir, { recursive: true });
    writeFileSync(
      join(tdDir, 'self-bootstrap-round-1.json'),
      JSON.stringify({ round: 1, evalScore: 80, source: 'self-bootstrap' }),
      'utf-8',
    );
    const listing = listTechDebt(cycles);
    expect(listing.open).toEqual([]);
    expect(listing.skipped.length).toBe(1);
    expect(listing.skipped[0]?.reason).toContain('not a TechDebtEntry');
  });

  it('markTechDebtConsumed：标记 + consumedAt/consumedBy 审计字段 + 幂等重标', () => {
    const cycles = tempCycles();
    const tdDir = join(cycles, 'tech-debt');
    mkdirSync(tdDir, { recursive: true });
    writeFileSync(join(tdDir, 'debt-a.json'), JSON.stringify(sampleEntry('debt-a')), 'utf-8');
    writeFileSync(
      join(tdDir, 'fix-loop-1.json'),
      JSON.stringify([sampleEntry('debt-b')]),
      'utf-8',
    );

    const r1 = markTechDebtConsumed(cycles, ['debt-a', 'debt-b'], 'human-review');
    expect(r1.marked).toBe(2);
    expect(r1.notFound).toEqual([]);
    expect(r1.errors).toEqual([]);

    // 落盘形态：单体文件写回单体（不包成数组）
    const a = JSON.parse(readFileSync(join(tdDir, 'debt-a.json'), 'utf-8')) as TechDebtEntry;
    expect(a.resolved).toBe(true);
    expect(a.consumedBy).toBe('human-review');
    expect(typeof a.consumedAt).toBe('string');
    // 数组文件写回数组
    const arr = JSON.parse(readFileSync(join(tdDir, 'fix-loop-1.json'), 'utf-8')) as TechDebtEntry[];
    expect(arr[0]?.resolved).toBe(true);

    // 幂等：已消费的重标 = 成功不重复计数
    const r2 = markTechDebtConsumed(cycles, ['debt-a'], 'human-review');
    expect(r2.marked).toBe(0);
    expect(r2.notFound).toEqual([]);
  });

  it('markTechDebtConsumed：未知 id 进 notFound（响亮，不静默）', () => {
    const cycles = tempCycles();
    mkdirSync(join(cycles, 'tech-debt'), { recursive: true });
    const r = markTechDebtConsumed(cycles, ['debt-none'], 'x');
    expect(r.marked).toBe(0);
    expect(r.notFound).toEqual(['debt-none']);
  });
});

describe('crossProjectHistory（G-C5 回写）', () => {
  it('追加 → 读回一致；与自举 history 并列不混入', () => {
    const cycles = tempCycles();
    mkdirSync(cycles, { recursive: true });
    const r = appendCrossProjectHistory(cycles, {
      timestamp: '2026-10-18T00:00:00.000Z',
      kind: 'evaluate',
      workspace: 'D:/proj/target',
      evalScore: 82,
      gateVerdict: null,
    });
    expect(r.ok).toBe(true);
    const history = readCrossProjectHistory(cycles);
    expect(history.length).toBe(1);
    expect(history[0]?.workspace).toBe('D:/proj/target');
    expect(history[0]?.evalScore).toBe(82);
    // 状态文件仍是合法 BootstrapState（loadBootstrapState 可读回）
    const state = JSON.parse(readFileSync(join(cycles, 'self-bootstrap.json'), 'utf-8')) as {
      status: string; round: number; history: unknown[]; crossProjectHistory: unknown[];
    };
    expect(state.history).toEqual([]);
    expect(state.crossProjectHistory.length).toBe(1);
  });

  it('滚动保留最近 50 条', () => {
    const cycles = tempCycles();
    mkdirSync(cycles, { recursive: true });
    for (let i = 0; i < 55; i++) {
      const r = appendCrossProjectHistory(cycles, {
        timestamp: `2026-10-18T00:00:${String(i).padStart(2, '0')}.000Z`,
        kind: 'evaluate',
        workspace: `D:/proj/${i}`,
        evalScore: i,
        gateVerdict: null,
      });
      expect(r.ok).toBe(true);
    }
    const history = readCrossProjectHistory(cycles);
    expect(history.length).toBe(50);
    expect(history[0]?.workspace).toBe('D:/proj/5');
    expect(history[49]?.workspace).toBe('D:/proj/54');
  });
});
