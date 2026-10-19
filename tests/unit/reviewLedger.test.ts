/**
 * 评审结论账本 + 结论时效（G5，cycle-38）。
 *
 * 这一层的存在理由：本仓此前只有**流程投影**的时效检测（flows/persistence.ts
 * 的 isProjectionStale），评审结论没有时效概念——一次 approve 在证据被换掉之后
 * 依然躺在账本里，看上去与刚做出时一模一样。本测试钉死判据是**内容指纹**而不是
 * 时间戳：同证据 → fresh，换证据 → stale，没结论 → none。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync as write } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendReviewRecord,
  findLatestReview,
  loadReviewRecords,
  reviewFreshness,
  reviewLedgerPath,
  MAX_REVIEW_RECORDS,
  REVIEW_LEDGER_FILE,
  type ReviewRecord,
} from '../../src/host/llm/reviewLedger.ts';

function tempCycles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-review-ledger-'));
  return join(dir, '.cycles');
}

function record(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    gate: 'intent',
    role: 'planner',
    verdict: 'approve',
    tier: 'tier-1-heuristic',
    evidenceDigest: 'aaaaaaaaaaaaaaaa',
    evidenceIds: ['e1'],
    provider: 'none',
    model: 'none',
    timestamp: '2026-10-18T00:00:00.000Z',
    ...over,
  };
}

describe('reviewLedger · 读侧诚实形态', () => {
  it('缺失目录/缺失文件 → 空数组（不 throw、不伪造）', () => {
    expect(loadReviewRecords(tempCycles())).toEqual([]);
  });

  it('损坏 JSON → 空数组（账本是观测工件，损坏不能连累评审）', () => {
    const cycles = tempCycles();
    mkdirSync(join(cycles, 'reviews'), { recursive: true });
    write(join(cycles, REVIEW_LEDGER_FILE), '{ not json', 'utf-8');
    expect(loadReviewRecords(cycles)).toEqual([]);
  });

  it('形状不对的条目被逐条剔除，合法条目保留（绝不部分采信坏数据）', () => {
    const cycles = tempCycles();
    mkdirSync(join(cycles, 'reviews'), { recursive: true });
    write(
      join(cycles, REVIEW_LEDGER_FILE),
      JSON.stringify([
        record(),
        { gate: 'intent' }, // 缺字段
        { ...record(), verdict: 'maybe' }, // verdict 非三值
        { ...record(), evidenceIds: 'e1' }, // 不是数组
        record({ gate: 'spec' }),
      ]),
      'utf-8',
    );
    const got = loadReviewRecords(cycles);
    expect(got.map((r) => r.gate)).toEqual(['intent', 'spec']);
  });

  it('包裹形态 {records:[...]} 与裸数组形态都能读（兼容两代落盘）', () => {
    const cycles = tempCycles();
    mkdirSync(join(cycles, 'reviews'), { recursive: true });
    write(join(cycles, REVIEW_LEDGER_FILE), JSON.stringify({ records: [record()] }), 'utf-8');
    expect(loadReviewRecords(cycles)).toHaveLength(1);
    write(join(cycles, REVIEW_LEDGER_FILE), JSON.stringify([record(), record()]), 'utf-8');
    expect(loadReviewRecords(cycles)).toHaveLength(2);
  });

  it('账本路径固定为 .cycles/reviews/ledger.json', () => {
    const cycles = join('X:', 'proj', '.cycles');
    expect(reviewLedgerPath(cycles)).toBe(join(cycles, 'reviews', 'ledger.json'));
    expect(REVIEW_LEDGER_FILE).toBe('reviews/ledger.json');
  });
});

describe('reviewLedger · 写入与滚动窗口', () => {
  it('追加 → 读回一致（含全部审计字段）', () => {
    const cycles = tempCycles();
    const r = appendReviewRecord(cycles, record());
    expect(r.ok).toBe(true);
    const got = loadReviewRecords(cycles);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(record());
  });

  it('目录不存在时自动创建（首次评审不需要预热目录）', () => {
    const cycles = tempCycles();
    expect(appendReviewRecord(cycles, record()).ok).toBe(true);
    expect(loadReviewRecords(cycles)).toHaveLength(1);
  });

  it('滚动保留最近 MAX_REVIEW_RECORDS 条（旧结论丢弃而非无限增长）', () => {
    const cycles = tempCycles();
    const total = MAX_REVIEW_RECORDS + 5;
    for (let i = 0; i < total; i++) {
      const r = appendReviewRecord(cycles, record({ evidenceIds: [`e${String(i)}`] }));
      expect(r.ok).toBe(true);
    }
    const got = loadReviewRecords(cycles);
    expect(got).toHaveLength(MAX_REVIEW_RECORDS);
    expect(got[0]?.evidenceIds).toEqual(['e5']);
    expect(got[got.length - 1]?.evidenceIds).toEqual([`e${String(total - 1)}`]);
  });
});

describe('reviewLedger · 时效判定（确定性字符串比较，零模型）', () => {
  it('无历史结论 → none', () => {
    expect(reviewFreshness(null, 'aaaaaaaaaaaaaaaa')).toBe('none');
  });

  it('同一指纹 → fresh', () => {
    expect(reviewFreshness(record(), 'aaaaaaaaaaaaaaaa')).toBe('fresh');
  });

  it('指纹变化 → stale（证据换了，历史结论不再代表当前输入）', () => {
    expect(reviewFreshness(record(), 'bbbbbbbbbbbbbbbb')).toBe('stale');
  });

  it('stale 与时间戳无关：更晚的旧指纹仍是 stale', () => {
    const later = record({ timestamp: '2030-01-01T00:00:00.000Z' });
    expect(reviewFreshness(later, 'bbbbbbbbbbbbbbbb')).toBe('stale');
  });
});

describe('reviewLedger · findLatestReview 取最近一条', () => {
  it('同门同角色取最后一条（不是第一条）', () => {
    const records = [
      record({ evidenceDigest: 'old0000000000000' }),
      record({ gate: 'spec' }),
      record({ evidenceDigest: 'new0000000000000' }),
    ];
    const latest = findLatestReview(records, 'intent', 'planner');
    expect(latest?.evidenceDigest).toBe('new0000000000000');
  });

  it('门/角色不匹配 → null（不返回「差不多」的条目）', () => {
    expect(findLatestReview([record()], 'release', 'planner')).toBeNull();
    expect(findLatestReview([record()], 'intent', 'reviewer')).toBeNull();
    expect(findLatestReview([], 'intent', 'planner')).toBeNull();
  });
});
