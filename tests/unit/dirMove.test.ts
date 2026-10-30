/**
 * **目录移动**契约（cycle-91）—— 逐文件移动 + 删除源目录。
 *
 * ## 为什么不用 `renameSync`（本轮实测的环境约束）
 *
 * | 测试 | 结果 |
 * |---|---|
 * | 仓库内**文件** rename | ✅ OK |
 * | 仓库内**目录** rename（新建空目录） | ❌ **EPERM** |
 * | 系统临时目录**目录** rename | ❌ **EPERM** |
 *
 * ⇒ **本机（Windows + DSH 沙箱）禁止目录 rename**，且**在任何位置都如此**
 * ⇒ 不是"杀软短暂持句柄"（那会随时间释放）⇒ 瞬时重试修不了 ⇒ 必须换动作。
 *
 * ## 三条核心纪律
 *
 * 1. **幂等**：目标已存在的同名文件 ⇒ **跳过不覆盖**（重跑可续做）；
 * 2. **部分失败如实报告**：搬不动的条目计数 + 原因，**不假装成功**；
 * 3. **源必须消失**：移动后源目录非空 ⇒ `ok=false`（归档的语义是"移动"，
 *    只复制不删 ⇒ 活跃面没变小 ⇒ 归档目的落空）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveDirectory, moveDirectoryContents, countFilesRecursive, isDirectoryEmpty } from '../../src/host/runtime/dirMove.ts';

let root = '';
const mk = (): string => {
  root = mkdtempSync(join(tmpdir(), 'anic-dirmove-'));
  return root;
};

describe('cycle-91：moveDirectory（逐文件移动）', () => {
  it('**基本移动**：源消失、目标含全部内容', () => {
    const r = mk();
    try {
      const src = join(r, 'from');
      const dst = join(r, 'to');
      mkdirSync(join(src, 'sub'), { recursive: true });
      writeFileSync(join(src, 'a.txt'), 'A');
      writeFileSync(join(src, 'sub', 'b.txt'), 'B');
      const res = moveDirectory(src, dst);
      expect(res.ok, res.reason ?? '').toBe(true);
      expect(existsSync(src), '源目录应已删除（移动语义）').toBe(false);
      expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A');
      expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('B');
      expect(res.moved).toBe(2);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it('**目标已存在 ⇒ 拒绝**（不混批，不覆盖历史）', () => {
    const r = mk();
    try {
      const src = join(r, 'from');
      const dst = join(r, 'to');
      mkdirSync(src); mkdirSync(dst);
      writeFileSync(join(src, 'a.txt'), 'A');
      const res = moveDirectory(src, dst);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('已存在');
      // 源保持不动（失败不改源）。
      expect(existsSync(join(src, 'a.txt')), '失败时源必须完好').toBe(true);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it('**幂等**：目标已有同名文件 ⇒ 跳过（不覆盖）+ 计数', () => {
    const r = mk();
    try {
      const src = join(r, 'from');
      const dst = join(r, 'to');
      mkdirSync(src); mkdirSync(dst);
      writeFileSync(join(src, 'a.txt'), 'NEW');
      writeFileSync(join(dst, 'a.txt'), 'OLD');
      const res = moveDirectoryContents(src, dst);
      expect(res.skipped, '同名文件应被跳过').toBe(1);
      expect(res.moved).toBe(0);
      // 已有内容**不被覆盖**（覆盖会销毁历史）。
      expect(readFileSync(join(dst, 'a.txt'), 'utf8'), '目标内容不得被覆盖').toBe('OLD');
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it('**部分移动后重跑可续做**（幂等收敛）', () => {
    const r = mk();
    try {
      const src = join(r, 'from');
      const dst = join(r, 'to');
      mkdirSync(src); mkdirSync(dst);
      writeFileSync(join(src, 'a.txt'), 'A');
      writeFileSync(join(src, 'b.txt'), 'B');
      // 第一次：目标已有 a.txt ⇒ a 被跳过，b 被搬走。
      writeFileSync(join(dst, 'a.txt'), 'OLD');
      const first = moveDirectoryContents(src, dst);
      expect(first.moved).toBe(1);
      expect(first.skipped).toBe(1);
      // 第二次：a 仍被跳过（内容已不同名？不——同名 ⇒ 跳过），b 不在源了。
      const second = moveDirectoryContents(src, dst);
      expect(second.moved, '第二次不应再搬 b').toBe(0);
      expect(second.skipped).toBe(1);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it('**源不存在 ⇒ 如实失败**（不假装成功）', () => {
    const r = mk();
    try {
      const res = moveDirectory(join(r, 'nope'), join(r, 'to'));
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('源目录不存在');
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it('辅助函数：空目录判定 + 递归文件计数', () => {
    const r = mk();
    try {
      const d = join(r, 'x');
      mkdirSync(join(d, 'sub'), { recursive: true });
      expect(isDirectoryEmpty(d)).toBe(false);
      writeFileSync(join(d, 'sub', 'f.txt'), 'x');
      expect(countFilesRecursive(d)).toBe(1);
      expect(isDirectoryEmpty(join(r, 'nonexistent')), '不存在的目录视为空').toBe(true);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});
