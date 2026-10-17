/**
 * fs-safe 单元测试（F-T1 cycle-13 抖动加固）。
 *
 * 背景：cycle-12 全量跑中 flowTracker 滚动淘汰用例（205 次连续原子写）偶现
 * 一次失败、单跑无法复现。根因理论：Windows rename 覆盖既有文件时杀软/
 * 索引器短暂持有句柄 → 瞬时 EPERM。加固 = 瞬时错误重试 + 非瞬时立即抛。
 *
 * 覆盖：
 * - isTransientRenameError 瞬时错误码真值表（EPERM/EACCES/ENOTEMPTY/EEXIST）
 * - rename-over-existing 主路径（覆盖写成功——抖动场景的正常面）
 * - 写后无 .tmp 残留
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync, isTransientRenameError, safeReadFileSync } from '../../src/shared/fs-safe.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fs-safe-test-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('isTransientRenameError（瞬时错误码真值表）', () => {
  it('瞬时类：EPERM / EACCES / ENOTEMPTY / EEXIST → 重试', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']) {
      expect(isTransientRenameError(code), code).toBe(true);
    }
  });

  it('非瞬时类：立即抛出不重试（ENOENT 路径不存在 / EISDIR 目录 / undefined）', () => {
    expect(isTransientRenameError('ENOENT')).toBe(false);
    expect(isTransientRenameError('EISDIR')).toBe(false);
    expect(isTransientRenameError(undefined)).toBe(false);
  });
});

describe('atomicWriteFileSync', () => {
  it('新文件写入 + 读回一致', () => {
    const file = join(tempDir, 'state.json');
    atomicWriteFileSync(file, '{"a":1}');
    expect(readFileSync(file, 'utf-8')).toBe('{"a":1}');
  });

  it('rename-over-existing 主路径：连续覆盖写全部成功且内容为最后一次（F-T1 抖动场景的正常面）', () => {
    const file = join(tempDir, 'tracker.json');
    // 高写密度：模拟滚动淘汰用例的连续原子写形态（205 次量级压到 60 次保持用例轻量）
    for (let i = 1; i <= 60; i++) {
      atomicWriteFileSync(file, JSON.stringify({ counter: i }));
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      expect(parsed.counter).toBe(i);
    }
  });

  it('写后无 .tmp 残留', () => {
    const file = join(tempDir, 'state.json');
    atomicWriteFileSync(file, 'one');
    atomicWriteFileSync(file, 'two');
    const leftovers = readdirSync(tempDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('safeReadFileSync', () => {
  it('不存在返回 fallback；存在返回内容', () => {
    expect(safeReadFileSync(join(tempDir, 'absent.txt'))).toBe('');
    expect(safeReadFileSync(join(tempDir, 'absent.txt'), 'fb')).toBe('fb');
    const file = join(tempDir, 'present.txt');
    atomicWriteFileSync(file, 'hello');
    expect(safeReadFileSync(file)).toBe('hello');
    expect(existsSync(file)).toBe(true);
  });
});
