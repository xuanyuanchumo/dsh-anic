/**
 * **目录 rename 的瞬时重试**契约（cycle-91）。
 *
 * ## 为什么钉这个（本轮实测缺陷）
 *
 * `atomicWriteFileSync` 早有瞬时重试（cycle-13 抖动加固），但**目录级 rename
 * 没有** ⇒ 三处归档路径在 Windows 上会被杀软/搜索索引器短暂持句柄而 EPERM。
 *
 * **实测反例**（cycle-91 收口，真机）：
 * ```
 * anic_flows_archive --cycle 90
 * → Error: EPERM: operation not permitted,
 *     rename 'D:\...\cycles\cycle-90' -> 'D:\...\archive\cycle-90'
 * ```
 * ⇒ **归档功能在真机上不可用**。
 *
 * ## 为什么不"忽略 EPERM"
 *
 * 归档是**移动**（不是复制）⇒ 失败意味着循环目录留在原地而 archive 下没有它
 * ⇒ manifest 说归档了、实际没归档 ⇒ **半完成状态比抛错更糟**（撒谎）。
 * ⇒ 必须**重试到成功或抛出真实错误**。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeRenameSync, isTransientRenameError } from '../../src/shared/fs-safe.ts';

describe('cycle-91：safeRenameSync（目录移动的瞬时重试）', () => {
  it('瞬时错误类判定：EPERM/EACCES/ENOTEMPTY/EEXIST 是瞬时的，其余不是', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']) {
      expect(isTransientRenameError(code), `${code} 应判为瞬时`).toBe(true);
    }
    for (const code of ['ENOENT', 'EXDEV', 'EACCES2', undefined, '']) {
      if (code === 'EACCES2') continue;
      expect(isTransientRenameError(code), `${String(code)} 不应判为瞬时`).toBe(false);
    }
  });

  it('**目录 rename 成功**（基本形态）', () => {
    const root = mkdtempSync(join(tmpdir(), 'anic-rename-'));
    try {
      const src = join(root, 'from');
      const dst = join(root, 'to');
      mkdirSync(src);
      writeFileSync(join(src, 'a.txt'), 'x');
      safeRenameSync(src, dst);
      expect(existsSync(src), '源应已消失').toBe(false);
      expect(existsSync(join(dst, 'a.txt')), '目标应含内容').toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**文件 rename 成功**（与原子写同款语义）', () => {
    const root = mkdtempSync(join(tmpdir(), 'anic-rename-'));
    try {
      const src = join(root, 'a.txt');
      const dst = join(root, 'b.txt');
      writeFileSync(src, 'x');
      safeRenameSync(src, dst);
      expect(existsSync(src)).toBe(false);
      expect(existsSync(dst)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**非瞬时错误立即抛**（不做无谓重试）', () => {
    const root = mkdtempSync(join(tmpdir(), 'anic-rename-'));
    try {
      // 源不存在 ⇒ ENOENT（非瞬时）⇒ 必须**立即**抛，不能被吞成"成功"。
      expect(() => safeRenameSync(join(root, 'nope'), join(root, 'dst'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**三处归档路径都不用裸 renameSync**（源码守卫：目录 rename 被环境禁止）', () => {
    const files = [
      'src/host/flows/archiveEngine.ts',
      'src/host/runtime/artifactArchiveBaseline.ts',
      'src/host/runtime/artifactArchiveRestore.ts',
    ];
    for (const rel of files) {
      const src = join(process.cwd(), rel);
      const text = require('node:fs').readFileSync(src, 'utf8') as string;
      // 去掉注释行后再找裸 renameSync（注释里提到 renameSync 是允许的）。
      const code = text.split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n');
      expect(code, `${rel} 仍用裸 renameSync（应改用 safeRenameSync）`).not.toMatch(/\brenameSync\s*\(/);
    }
  });
});
