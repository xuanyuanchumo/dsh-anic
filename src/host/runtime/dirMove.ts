/**
 * **目录移动**的稳健实现（cycle-91）—— 逐文件移动 + 删除源目录。
 *
 * ## 为什么不用 `renameSync`（本轮实测的环境约束）
 *
 * **实测反例**（cycle-91 收口，真机）：
 * ```
 * anic_flows_archive --cycle 90
 * → Error: EPERM: operation not permitted,
 *     rename 'D:\...\cycles\cycle-90' -> 'D:\...\archive\cycle-90'
 * ```
 *
 * 进一步隔离测出的**真正根因**（不是瞬时锁！）：
 *
 * | 测试 | 结果 |
 * |---|---|
 * | 仓库内**文件** rename | ✅ OK |
 * | 仓库内**目录** rename（新建空目录） | ❌ **EPERM** |
 * | 系统临时目录**目录** rename | ❌ **EPERM** |
 *
 * ⇒ **本机（Windows + DSH 沙箱）禁止目录 rename**，且**在任何位置都如此**
 * ⇒ 这不是"杀软短暂持句柄"（那会随时间释放），而是**环境层面的禁止**。
 *
 * ⇒ `safeRenameSync` 的**瞬时重试**修不了它（重试 4 次全失败）。
 * ⇒ 归档必须**换一种搬运动作**。
 *
 * ## 为什么「逐文件移动 + 删除源目录」是正确的
 *
 * 1. **文件 rename 是允许的**（实测）⇒ 逐文件移动走的是**被允许的原语**；
 * 2. **目录删除**（`rmdirSync`）也是允许的（实测）⇒ 移动完能清掉源；
 * 3. **幂等性**：若中途失败，已移动的文件在目标侧 ⇒ 重跑会跳过已存在的
 *    同名文件（见 `moveDirectoryContents`）⇒ **可重入**。
 *
 * ## 原子性边界（诚实说明）
 *
 * 逐文件移动**不是**原子的：中途崩溃会留下「部分在源、部分在目标」的状态。
 * 本模块用**可重入 + 如实报告**处理：
 * - 移动前：目标侧若已存在同名文件 ⇒ **跳过并计数**（不覆盖）；
 * - 移动后：源目录**空则删除**（非空则保留并如实报告"残留 N 个"）。
 *
 * ⇒ 恢复动作：重跑同一归档命令即可（幂等）。
 *
 * ## 为什么归档**不能**退化为「复制 + 不删源」
 *
 * 归档的语义是「**移动**」（释放活跃面、避免同名冲突）。只复制不删 ⇒
 * 活跃面**没变小** ⇒ 归档目的落空 ⇒ `GET /anic/flows/status` 的活跃计数仍是错的。
 */
import { existsSync, mkdirSync, renameSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 目录移动的结果。 */
export interface MoveDirResult {
  /** 是否**完全**成功（源目录已删除）。 */
  ok: boolean;
  /** 已移动的文件数。 */
  moved: number;
  /** 因目标已存在而跳过的文件数。 */
  skipped: number;
  /** 源目录残留的文件数（>0 ⇒ `ok=false`）。 */
  remaining: number;
  /** 人类可读的原因（`ok=false` 时必填）。 */
  reason?: string;
}

/**
 * 把 `src` 的**内容**移动到 `dst`（`dst` 会被创建）。
 *
 * ## 逐项语义
 *
 * - 目标已存在的同名文件 ⇒ **跳过**（不覆盖）⇒ 幂等；
 * - 目标已存在的同名**目录** ⇒ **递归合并**（继续搬里面的文件）；
 * - 源里的文件移动失败 ⇒ **记录并继续**（不中断整批）⇒ 尽可能多搬。
 *
 * @param src 源目录
 * @param dst 目标目录
 */
export function moveDirectoryContents(src: string, dst: string): MoveDirResult {
  let moved = 0;
  let skipped = 0;
  const failures: string[] = [];

  if (!existsSync(src)) {
    return { ok: true, moved: 0, skipped: 0, remaining: 0 };
  }
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = moveDirectoryContents(from, to);
        moved += sub.moved;
        skipped += sub.skipped;
        // 子目录搬空后删除它（空目录 rename 也不被允许，但 rmdir 可以）。
        if (sub.remaining === 0 && existsSync(from)) {
          try { rmdirSync(from); } catch { /* 非空则留给上层报告 */ }
        }
        continue;
      }
      if (existsSync(to)) {
        // 幂等：目标已有同名文件 ⇒ 跳过（不覆盖已有内容）。
        skipped++;
        continue;
      }
      renameSync(from, to);
      moved++;
    } catch (e) {
      failures.push(`${entry.name}: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`);
    }
  }

  // 源目录空 ⇒ 删除它（归档的"移动"语义要求源消失）。
  let remaining = 0;
  try {
    remaining = readdirSync(src).length;
    if (remaining === 0) {
      try {
        rmdirSync(src);
      } catch {
        remaining = readdirSync(src).length;
      }
    }
  } catch {
    remaining = 0;
  }

  if (failures.length > 0) {
    return {
      ok: false,
      moved,
      skipped,
      remaining,
      reason: `部分文件移动失败：${failures.slice(0, 5).join(', ')}${failures.length > 5 ? ` …共 ${String(failures.length)} 项` : ''}`,
    };
  }
  if (remaining > 0) {
    return {
      ok: false,
      moved,
      skipped,
      remaining,
      reason: `源目录残留 ${String(remaining)} 个条目（可能被占用）——重跑本命令可幂等续做`,
    };
  }
  return { ok: true, moved, skipped, remaining: 0 };
}

/**
 * 把 `src` **整个目录**移动到 `dst`（`dst` 是目标目录名）。
 *
 * 与 `moveDirectoryContents` 的区别：这里 `dst` 是**最终位置**
 * （`dst` 本身不存在时创建它，然后把 `src` 的内容搬进去）。
 *
 * @param src 源目录（必须存在）
 * @param dst 目标目录（**必须不存在** —— 已存在时由调用方拒绝，避免混批）
 */
export function moveDirectory(src: string, dst: string): MoveDirResult {
  if (!existsSync(src)) {
    return { ok: false, moved: 0, skipped: 0, remaining: 0, reason: `源目录不存在：${src}` };
  }
  if (existsSync(dst)) {
    return { ok: false, moved: 0, skipped: 0, remaining: 0, reason: `目标已存在：${dst}` };
  }
  mkdirSync(dst, { recursive: true });
  return moveDirectoryContents(src, dst);
}

/** 目录是否**空**（用于判断能否删除源）。 */
export function isDirectoryEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** 目录内文件总数（递归）。 */
export function countFilesRecursive(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    if (!statSync(dir).isDirectory()) return 1;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      n += e.isDirectory() ? countFilesRecursive(p) : 1;
    }
  } catch { /* 不可读 ⇒ 当作 0 */ }
  return n;
}

/**
 * ## cycle-95 删除 `copyFileSafe()`（为什么删，而不是接线）
 *
 * 任务书原本建议「`copyFileSafe` 是原子移动原语 → 接线」。**实测证据否掉了这个前提**：
 *
 * ① **本文件头注已经明确裁定它不该被用**——「为什么归档**不能**退化为
 *    『复制 + 不删源』：归档的语义是移动（释放活跃面、避免同名冲突）。只复制不删
 *    ⇒ 活跃面没变小 ⇒ `GET /anic/flows/status` 的活跃计数仍是错的」。
 *    而这个函数的注释恰是「供『复制而不删』的降级路径使用」——**语义与本书裁决相反**。
 * ② 它不是"原子"原语：函数体就是 `copyFileSync(from, to)` 的一行转发，
 *    没有任何临时名/rename/滚动校验，连 `moveDirectoryContents` 的 try/catch
 *    与失败计数都没有。把它称作原子移动原语是**注释在撒谎**。
 * ③ 全仓去注释后零消费（含 tests/ 与 scripts/），三个真实复制点
 *    （`skillIntegrity.ts`、`skillInvoker.ts`）各自直接调 `fs.copyFileSync`。
 *
 * ⇒ 接线它等于**复活本文件刚刚明确拒绝的降级设计**，并把一行转发包装成
 * "原语"让人误以为有保障。删除；真需要复制语义时用 `copyFileSync` 并在调用点
 * 写明为何要"复制而不删"（那是调用方的业务裁决，不是本模块的默认）。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 */
