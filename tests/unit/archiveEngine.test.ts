/**
 * archiveEngine 契约（R3 阶段 3 后半）—— 技能 archive-cycle.mjs 逐字语义。
 *
 * 承重断言：
 *  - isCycleComplete 与 G1 共用 parseTaskRows（同解析器消灭分叉）
 *  - 拒绝路径（不存在/有未完成任务/已归档）零文件系统写入
 *  - 账本文件在归档前后逐字节不变（INV-9 只追加）
 *  - clean 只删归档目录（archive/ 下的），active 循环永不触碰
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isCycleComplete, listCycleInventory, archiveOneCycle, cleanOldArchives, runArchiveAction,
} from '../../src/host/flows/archiveEngine.ts';

let root: string;

function seedCycle(name: string, tasks: string): void {
  const dir = join(root, '.cycles', 'cycles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '任务清单.md'), tasks);
}

const DONE_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 完成 |';
const PENDING_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 待办 |';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-archive-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isCycleComplete（与 G1 共用解析器）', () => {
  it('全完成任务 → complete', () => {
    seedCycle('cycle-1', DONE_TASKS);
    expect(isCycleComplete(root, 'cycle-1')).toBe(true);
  });
  it('有待办 → incomplete（拒绝归档的判据）', () => {
    seedCycle('cycle-1', PENDING_TASKS);
    expect(isCycleComplete(root, 'cycle-1')).toBe(false);
  });
  it('目录缺失 / 清单缺失 → false', () => {
    seedCycle('cycle-1', '');
    rmSync(join(root, '.cycles', 'cycles', 'cycle-1', '任务清单.md'));
    expect(isCycleComplete(root, 'cycle-1')).toBe(false);
    expect(isCycleComplete(root, 'cycle-404')).toBe(false);
  });
  it('清单里的图例行「待办 → 进行中 → 完成」不算任务行（v1.8.3 自陷修复）', () => {
    // init-cycle 模板自带图例，旧实现整文件 includes('待办') 恒判 in-progress
    seedCycle('cycle-1', `状态流转：待办 → 进行中 → 完成\n\n${DONE_TASKS}`);
    expect(isCycleComplete(root, 'cycle-1')).toBe(true);
  });
});

describe('archiveOneCycle（技能 cmdArchive 逐字语义）', () => {
  it('成功归档：移动目录 + 消息含路径与 INV-9 声明', () => {
    seedCycle('cycle-1', DONE_TASKS);
    const r = archiveOneCycle(root, 1);
    expect(r.ok).toBe(true);
    expect(r.affected).toEqual(['cycle-1']);
    expect(r.message).toContain('Archived cycle-1 to');
    expect(r.message).toContain('ledger untouched');
    expect(existsSync(join(root, '.cycles', 'archive', 'cycle-1'))).toBe(true);
    expect(existsSync(join(root, '.cycles', 'cycles', 'cycle-1'))).toBe(false);
  });
  it('不存在 → 拒绝（消息逐字）+ 零写入', () => {
    const r = archiveOneCycle(root, 99);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Cycle cycle-99 not found.');
    expect(existsSync(join(root, '.cycles', 'archive'))).toBe(false);
  });
  it('有未完成任务 → 拒绝（消息逐字）+ 目录不动', () => {
    seedCycle('cycle-2', PENDING_TASKS);
    const r = archiveOneCycle(root, 2);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Cycle cycle-2 has pending tasks. Complete all tasks before archiving.');
    expect(existsSync(join(root, '.cycles', 'cycles', 'cycle-2'))).toBe(true);
  });
  it('已归档 → not found（技能同款：源目录已移走，先撞 not-found 分支）', () => {
    seedCycle('cycle-3', DONE_TASKS);
    expect(archiveOneCycle(root, 3).ok).toBe(true);
    // 技能 archiveCycle 的检查顺序：先 existsSync(源) 再 existsSync(归档目标)。
    // 归档后源目录已不存在 → 重跑报 not found（与技能行为一致，不美化）。
    const again = archiveOneCycle(root, 3);
    expect(again.ok).toBe(false);
    expect(again.message).toBe('Cycle cycle-3 not found.');
  });
  it('already archived 分支：源目录与归档目标同时存在（异常双目录态）', () => {
    seedCycle('cycle-3', DONE_TASKS);
    mkdirSync(join(root, '.cycles', 'archive', 'cycle-3'), { recursive: true });
    const r = archiveOneCycle(root, 3);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Cycle cycle-3 already archived.');
  });
  it('账本文件归档前后逐字节不变（INV-9 只追加哈希链）', () => {
    seedCycle('cycle-4', DONE_TASKS);
    const ledgerBefore = JSON.stringify({ entries: [{ gate: 'G0', result: 'PASS' }] });
    mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
    const ledgerPath = join(root, '.cycles', 'gates', 'ledger.json');
    writeFileSync(ledgerPath, ledgerBefore);
    archiveOneCycle(root, 4);
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(ledgerBefore);
  });
});

describe('cleanOldArchives（技能 cmdClean 逐字语义）', () => {
  function seedArchived(name: string): void {
    const dir = join(root, '.cycles', 'archive', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), '{}');
  }
  it('无归档目录 → No archive directory.', () => {
    const r = cleanOldArchives(root);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('No archive directory.');
  });
  it('数量不超 keep → 全保留', () => {
    seedArchived('cycle-1');
    seedArchived('cycle-2');
    const r = cleanOldArchives(root, 5);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Only 2 archived cycles, keeping all (limit: 5).');
    expect(readdirSync(join(root, '.cycles', 'archive'))).toHaveLength(2);
  });
  it('超出 keep → 删旧留新（数值序：cycle-10 > cycle-9）', () => {
    for (const n of [1, 2, 9, 10]) seedArchived(`cycle-${n}`);
    const r = cleanOldArchives(root, 2);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Cleaned 2 old archive(s), keeping 2.');
    expect(r.affected).toEqual(['cycle-1', 'cycle-2']);
    const left = readdirSync(join(root, '.cycles', 'archive'));
    expect(left).toContain('cycle-9');
    expect(left).toContain('cycle-10');
    expect(left).not.toContain('cycle-1');
  });
  it('clean 永不触碰 active 循环', () => {
    seedCycle('cycle-1', PENDING_TASKS);
    for (const n of [2, 3, 4, 5, 6, 7]) seedArchived(`cycle-${n}`);
    cleanOldArchives(root, 2);
    expect(existsSync(join(root, '.cycles', 'cycles', 'cycle-1'))).toBe(true);
  });
});

describe('listCycleInventory / runArchiveAction', () => {
  it('清单：active 带 complete 标注 + archived 带日期', () => {
    seedCycle('cycle-1', DONE_TASKS);
    seedCycle('cycle-2', PENDING_TASKS);
    const dir = join(root, '.cycles', 'archive', 'cycle-0');
    mkdirSync(dir, { recursive: true });
    const inv = listCycleInventory(root);
    expect(inv.active.map((a) => [a.name, a.complete])).toEqual([['cycle-1', true], ['cycle-2', false]]);
    expect(inv.archived).toHaveLength(1);
    expect(inv.archived[0]!.name).toBe('cycle-0');
    expect(inv.archived[0]!.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('runArchiveAction list 分派返回清单', () => {
    const r = runArchiveAction(root, { kind: 'list' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('list');
    expect(r.inventory).toBeDefined();
  });
});
