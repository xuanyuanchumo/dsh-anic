/**
 * 归档还原 + 限定候选归档（cycle-87 · O-86-03）单测。
 *
 * ## 为什么这些用例值得写
 *
 * cycle-86 的事故里，"还原"是靠现场手写脚本完成的——那条路径没有幂等、没有审计、
 * 也没同步 manifest。本文件的每个用例都对着**当时踩到的具体风险**：
 *   ① 目标已在活跃区时重复执行 → 必须 no-op（不能 EEXIST 崩）；
 *   ② 还原后 manifest 还留着条目 → 库存会出现"两边都有"（比"都没有"更误导）；
 *   ③ 归档区没有该轮 → 必须能与"没搬过"区分（`missing`）；
 *   ④ 账本必须零变动（INV-9）——`unchanged` 由实际比对得出，不是写死。
 *
 * 全部在**临时工作区**上跑（`mkdtempSync`），绝不碰真实 `.cycles`——这条纪律本身
 * 就是 cycle-86 事故（写入型探针跑在真实工作区上）的直接产物。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveBaseline } from '../../src/host/runtime/artifactArchiveBaseline.ts';
import {
  RESTORE_LOG_FILE, manifestWithout, readRestoreLog, restoreArchivedCycle,
} from '../../src/host/runtime/artifactArchiveRestore.ts';

const CLEAN: string[] = [];
afterEach((): void => {
  while (CLEAN.length > 0) {
    const d = CLEAN.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

/** 建一个临时 `.cycles`：含账本 + 若干轮（complete / empty-task-list 两种形态）。 */
function fixture(spec: { complete: string[]; empty?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-restore-'));
  CLEAN.push(root);
  const cyclesDir = join(root, '.cycles');
  mkdirSync(join(cyclesDir, 'cycles'), { recursive: true });
  mkdirSync(join(cyclesDir, 'gates'), { recursive: true });
  writeFileSync(join(cyclesDir, 'gates', 'ledger.json'), JSON.stringify({
    entries: [{ gate: 'G0', result: 'PASS' }],
    chainHead: 'deadbeef',
  }));
  const taskTable = (status: string): string =>
    '# 任务清单\n\n| 任务 | 归属层 | 关联用例 ID | 文档变更项 | 依赖 | 状态 |\n|---|---|---|---|---|---|\n'
    + `| 干点活 | Host | case-1 | - | - | ${status} |\n`;
  for (const name of spec.complete) {
    mkdirSync(join(cyclesDir, 'cycles', name), { recursive: true });
    writeFileSync(join(cyclesDir, 'cycles', name, '任务清单.md'), taskTable('完成'));
  }
  for (const name of spec.empty ?? []) {
    mkdirSync(join(cyclesDir, 'cycles', name), { recursive: true });
    writeFileSync(join(cyclesDir, 'cycles', name, '任务清单.md'), '# 任务清单\n\n空的。\n');
  }
  return cyclesDir;
}

describe('archiveBaseline.names：限定候选，未选中的轮必须点名保留', () => {
  it('只归档被点名的轮；其余以 not-selected 留下（不静默消失）', () => {
    const dir = fixture({ complete: ['cycle-1', 'cycle-2'], empty: ['cycle-3'] });
    const r = archiveBaseline(dir, { names: ['cycle-1'], dryRun: false, actor: 't' });
    expect(r.archived).toEqual(['cycle-1']);
    expect(existsSync(join(dir, 'cycles', 'cycle-2'))).toBe(true);
    const kept = new Map(r.kept.map((k) => [k.name, k.reason]));
    expect(kept.get('cycle-2')).toBe('not-selected');
    expect(kept.get('cycle-3')).toBe('not-selected');
  });

  it('includeIncomplete + names：只封存指定脏目录，**不**顺带搬走可完成轮', () => {
    const dir = fixture({ complete: ['cycle-5'], empty: ['cycle-1'] });
    const r = archiveBaseline(dir, { names: ['cycle-1'], includeIncomplete: true, actor: 't' });
    expect(r.archived).toEqual(['cycle-1']);
    expect(existsSync(join(dir, 'cycles', 'cycle-5'))).toBe(true); // 未被扫进去
  });

  it('请求了不存在的轮 → 如实告警（不是静默忽略）', () => {
    const dir = fixture({ complete: ['cycle-1'] });
    const r = archiveBaseline(dir, { names: ['cycle-999'], dryRun: true });
    expect(r.warnings.join(' ')).toContain('cycle-999');
  });
});

describe('restoreArchivedCycle：幂等 / 审计 / manifest 同步 / 账本零变动', () => {
  let dir: string;
  beforeEach(() => {
    dir = fixture({ complete: ['cycle-1', 'cycle-2'] });
    archiveBaseline(dir, { names: ['cycle-1'], actor: 'test:archive' });
  });

  it('还原成功：目录回迁 + manifest 去条目 + 日志留痕 + 账本 unchanged', () => {
    const before = JSON.parse(readFileSync(join(dir, 'archive', 'manifest.json'), 'utf8')) as { cycles: Array<{ name: string }> };
    expect(before.cycles.map((c) => c.name)).toContain('cycle-1');

    const r = restoreArchivedCycle(dir, 'cycle-1', { actor: 'test:restore', reason: 'accidental archive' });
    expect(r.ok).toBe(true);
    expect(r.restored).toBe('cycle-1');
    expect(existsSync(join(dir, 'cycles', 'cycle-1'))).toBe(true);
    expect(existsSync(join(dir, 'archive', 'cycle-1'))).toBe(false);

    const after = JSON.parse(readFileSync(join(dir, 'archive', 'manifest.json'), 'utf8')) as { cycles: Array<{ name: string }> };
    expect(after.cycles.map((c) => c.name)).not.toContain('cycle-1');

    const log = readRestoreLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]?.name).toBe('cycle-1');
    expect(log[0]?.actor).toBe('test:restore');
    expect(log[0]?.reason).toBe('accidental archive');

    expect(r.ledger?.unchanged).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('幂等：再还原一次 → alreadyActive no-op（不抛、不重复写日志）', () => {
    restoreArchivedCycle(dir, 'cycle-1', { actor: 't' });
    const again = restoreArchivedCycle(dir, 'cycle-1', { actor: 't' });
    expect(again.ok).toBe(true);
    expect(again.alreadyActive).toBe(true);
    expect(again.restored).toBeNull();
    expect(readRestoreLog(dir)).toHaveLength(1); // 没有第二条日志
    expect(existsSync(join(dir, 'cycles', 'cycle-1'))).toBe(true);
  });

  it('归档区没有该轮 → missing=true（与"没搬过"可区分）', () => {
    const r = restoreArchivedCycle(dir, 'cycle-2', { actor: 't' }); // cycle-2 一直在活跃区
    expect(r.missing).toBe(false);
    expect(r.alreadyActive).toBe(true);

    const r2 = restoreArchivedCycle(dir, 'cycle-99', { actor: 't' });
    expect(r2.ok).toBe(false);
    expect(r2.missing).toBe(true);
  });

  it('dryRun：只报告不写盘（目录、manifest、日志都不动）', () => {
    const r = restoreArchivedCycle(dir, 'cycle-1', { dryRun: true, actor: 't' });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.restored).toBe('cycle-1');
    expect(existsSync(join(dir, 'archive', 'cycle-1'))).toBe(true); // 仍在归档区
    expect(existsSync(join(dir, 'cycles', 'cycle-1'))).toBe(false);
    expect(readRestoreLog(dir)).toHaveLength(0);
  });

  it('安全：非法名字（路径遍历/任意目录）一律拒绝，且零写入', () => {
    for (const bad of ['../etc', 'cycle-1/../cycle-2', '  ', 'CYCLE-1', '.', 'cycle-']) {
      const r = restoreArchivedCycle(dir, bad, { actor: 't' });
      expect(r.ok, `bad name ${JSON.stringify(bad)} 不应成功`).toBe(false);
      expect(r.warnings.join(' ')).toContain('invalid cycle name');
    }
    expect(readRestoreLog(dir)).toHaveLength(0);
  });

  it('manifestWithout：只删同名条目，其余保持数值序（不做整体重建）', () => {
    const m = {
      archivedAt: 'X', totalBytes: 0,
      cycles: [
        { name: 'cycle-1', num: 1, files: 1, archivedFrom: 'cycles/cycle-1', archivedAt: 'X' },
        { name: 'cycle-2', num: 2, files: 1, archivedFrom: 'cycles/cycle-2', archivedAt: 'X' },
      ],
    };
    expect(manifestWithout(m, 'cycle-1')?.cycles.map((c) => c.name)).toEqual(['cycle-2']);
    expect(manifestWithout(null, 'cycle-1')).toBeNull();
  });

  it('日志文件是追加式 JSON 数组（人工可读，不覆盖历史）', () => {
    restoreArchivedCycle(dir, 'cycle-1', { actor: 'a1' });
    archiveBaseline(dir, { names: ['cycle-1'], actor: 'test:re-archive' });
    restoreArchivedCycle(dir, 'cycle-1', { actor: 'a2' });
    const raw = JSON.parse(readFileSync(join(dir, 'archive', RESTORE_LOG_FILE), 'utf8')) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    expect(readRestoreLog(dir).map((e) => e.actor)).toEqual(['a1', 'a2']);
  });
});
