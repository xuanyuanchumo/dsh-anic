/**
 * 自主级变更审计账契约（cycle-77 T4-A）。
 *
 * 被守卫缺陷：自主级变更此前只有自由文本 incident / 一句 API reason，
 * 机器可读账本 0 条记录（`docs/anic/spike/evolution-replay-simulation.md` 实证：
 * incidents 声称 2 次 L4→L3，ledger 0 条）。本套件钉四件事：
 *   1. 读写闭环（原子写 + 回读逐字一致）；
 *   2. 坏 JSON **响亮**报错（不得静默吞成 []，那会让审计面假绿）；
 *   3. 坏账拒绝覆盖写（销毁既有审计线索比报错更糟）；
 *   4. 有界保留（超限 FIFO 裁剪并如实返回 dropped）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTONOMY_HISTORY_FILE,
  MAX_HISTORY_ENTRIES,
  areAdjacentBands,
  appendHistory,
  historyPath,
  readHistory,
  summarizeHistory,
  validateHistory,
  type AutonomyHistoryEntry,
} from '../../src/host/evolution/autonomyHistory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-autonomy-history');
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ } });

let seq = 0;
/** 独立临时 .cycles 目录（每个用例互不干扰）。 */
function freshCycles(): string {
  const dir = join(TMP, `cycles-${String(++seq)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 合法条目工厂（相邻档 + 递增时间）。 */
function entry(from: string, to: string, at = '2026-10-25T10:00:00.000Z'): AutonomyHistoryEntry {
  return {
    from,
    to,
    at,
    actor: 'test',
    reason: 'unit test',
    authorization: 'system',
    evidence: {
      trust: { avg: 80, gates: { G0: 97, G1: 85 } },
      breakers: [],
      gates: { G0: 'PASS', G1: 'FAIL' },
      recommendedBand: 'L3',
    },
  };
}

describe('读写闭环', () => {
  it('缺失文件 → 空账且无错误（首次运行是合法初始态）', () => {
    const r = readHistory(freshCycles());
    expect(r).toEqual({ entries: [], error: null });
  });

  it('append 后回读逐字一致（含 evidence 结构）', () => {
    const cycles = freshCycles();
    const e = entry('L2', 'L3');
    const res = appendHistory(cycles, e);
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.dropped).toBe(0);
    expect(existsSync(join(cycles, AUTONOMY_HISTORY_FILE))).toBe(true);
    const back = readHistory(cycles);
    expect(back.error).toBeNull();
    expect(back.entries).toHaveLength(1);
    expect(back.entries[0]).toEqual(e);
  });

  it('多条按时间序追加，path 指向 .cycles/autonomy-history.json', () => {
    const cycles = freshCycles();
    appendHistory(cycles, entry('L2', 'L3', '2026-10-25T10:00:00.000Z'));
    const second = appendHistory(cycles, entry('L3', 'L4', '2026-10-25T11:00:00.000Z'));
    expect(second.ok).toBe(true);
    expect(second.path).toBe(historyPath(cycles));
    expect(readHistory(cycles).entries.map((x) => x.to)).toEqual(['L3', 'L4']);
  });
});

describe('容错与响亮失败（不静默吞）', () => {
  it('坏 JSON → error 非空 + entries 为空（不是假绿的空账）', () => {
    const cycles = freshCycles();
    writeFileSync(join(cycles, AUTONOMY_HISTORY_FILE), '{not json', 'utf-8');
    const r = readHistory(cycles);
    expect(r.entries).toEqual([]);
    expect(r.error).toContain('not valid JSON');
  });

  it('顶层非数组 → error 点名形状', () => {
    const cycles = freshCycles();
    writeFileSync(join(cycles, AUTONOMY_HISTORY_FILE), '{"from":"L2"}', 'utf-8');
    expect(readHistory(cycles).error).toContain('not a JSON array');
  });

  it('坏账上 append 拒绝覆盖写，原文逐字保留（审计线索不能被抹）', () => {
    const cycles = freshCycles();
    const path = join(cycles, AUTONOMY_HISTORY_FILE);
    writeFileSync(path, '{"broken": ', 'utf-8');
    const res = appendHistory(cycles, entry('L2', 'L3'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not valid JSON');
    expect(readFileSync(path, 'utf-8')).toBe('{"broken": ');
  });

  it('非法条目被 appendHistory 拒收（不写盘）', () => {
    const cycles = freshCycles();
    const res = appendHistory(cycles, entry('L1', 'L3')); // 跳档
    expect(res.ok).toBe(false);
    expect(res.error).toContain('adjacent');
    expect(existsSync(join(cycles, AUTONOMY_HISTORY_FILE))).toBe(false);
  });
});

describe('validateHistory：必填 / 相邻 / 时间序单调', () => {
  it('合法账 → 无问题', () => {
    expect(validateHistory([entry('L2', 'L3'), entry('L3', 'L4', '2026-10-25T11:00:00.000Z')])).toEqual([]);
  });

  it('缺字段 / 非法级别 / 授权枚举 → 逐条点名', () => {
    const bad = { ...entry('L2', 'L3'), reason: '', authorization: 'robot' } as unknown as AutonomyHistoryEntry;
    const issues = validateHistory([bad]);
    expect(issues.join('\n')).toContain('reason');
    expect(issues.join('\n')).toContain('authorization');
    const noEvidence = { from: 'L2', to: 'L3', at: 'x', actor: 'a', reason: 'r' } as unknown as AutonomyHistoryEntry;
    expect(validateHistory([noEvidence]).join('\n')).toContain('evidence is required');
  });

  it('跳档（不相邻）与时间倒退都判红', () => {
    expect(validateHistory([entry('L1', 'L3')]).join('\n')).toContain('adjacent');
    const backwards = validateHistory([
      entry('L2', 'L3', '2026-10-25T11:00:00.000Z'),
      entry('L3', 'L4', '2026-10-25T10:00:00.000Z'),
    ]);
    expect(backwards.join('\n')).toContain('time order violated');
  });

  it('areAdjacentBands 口径：单步才相邻，同档/跨档/非法值都不是', () => {
    expect(areAdjacentBands('L2', 'L3')).toBe(true);
    expect(areAdjacentBands('L4', 'L3')).toBe(true); // 方向无关
    expect(areAdjacentBands('L3', 'L3')).toBe(false);
    expect(areAdjacentBands('L2', 'L4')).toBe(false);
    expect(areAdjacentBands('L9', 'L3')).toBe(false);
  });
});

describe('有界保留（如实返回裁剪事实）', () => {
  it(`超过 ${String(MAX_HISTORY_ENTRIES)} 条时 FIFO 裁掉最旧，dropped 如实上报`, () => {
    const cycles = freshCycles();
    const total = MAX_HISTORY_ENTRIES + 3;
    let last = { ok: true, dropped: 0, count: 0 } as { ok: boolean; dropped: number; count: number };
    for (let i = 0; i < total; i++) {
      // 交替方向保持相邻；时间递增保证单调
      const from = i % 2 === 0 ? 'L2' : 'L3';
      const to = from === 'L2' ? 'L3' : 'L2';
      const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      last = appendHistory(cycles, entry(from, to, at));
    }
    expect(last.ok).toBe(true);
    expect(last.count).toBe(MAX_HISTORY_ENTRIES);
    // dropped 是**本次**追加裁掉的条数（每次超限裁 1），不是累计值
    expect(last.dropped).toBe(1);
    const back = readHistory(cycles);
    expect(back.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    // 保留的是**最近**的，最旧 3 条已被裁掉
    expect(back.entries[0]?.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 3)).toISOString());
    expect(validateHistory(back.entries)).toEqual([]); // 裁剪不破坏单调性
  });
});

describe('摘要投影（org-status 只暴露最近 5 条）', () => {
  it('取末 5 条且只含摘要字段（不灌整份 evidence）', () => {
    const entries = [1, 2, 3, 4, 5, 6].map((n) =>
      entry('L2', 'L3', `2026-10-2${String(n)}T10:00:00.000Z`));
    const summary = summarizeHistory(entries, 5);
    expect(summary).toHaveLength(5);
    expect(summary[0]?.at).toBe(entries[1]?.at);
    expect(Object.keys(summary[0] ?? {}).sort()).toEqual(['actor', 'at', 'authorization', 'from', 'reason', 'to']);
  });

  it('空账 → 空数组（不伪造占位行）', () => {
    expect(summarizeHistory([], 5)).toEqual([]);
  });

  it('cycle-78：trustExemption 必须随摘要投影（否则 UI 豁免分支永远看不见真账）', () => {
    const withExemption: AutonomyHistoryEntry = {
      ...entry('L3', 'L4', '2026-10-25T04:57:07.923Z'),
      authorization: 'human',
      trustExemption: { avg: 84, threshold: 85 },
    };
    const summary = summarizeHistory([entry('L2', 'L3', '2026-10-25T04:57:07.894Z'), withExemption], 5);
    expect(summary[0]?.trustExemption).toBeUndefined();
    expect(summary[1]?.trustExemption).toEqual({ avg: 84, threshold: 85 });
    // 反向自检：无豁免的记录不得凭空长出该字段（字段存在性 = 事实存在性）
    expect(Object.keys(summary[0] ?? {})).not.toContain('trustExemption');
  });
});
