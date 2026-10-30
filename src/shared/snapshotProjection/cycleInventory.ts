/**
 * 循环目录的**结构化枚举**（cycle-83）：活跃区 `.cycles/cycles/` 与归档区 `.cycles/archive/`。
 *
 * ## 为什么归档区必须与活跃区**并列**枚举
 *
 * 旧快照只读 `cycles/`，于是归档后目录消失 ⇒ 那一轮在图上直接蒸发。用户要的是
 * 「避免过度产物影响判断」，不是「看不见历史」——**归档即丢失是另一种缺陷形态**。
 * 读侧同时认两个目录，是「归档 ≠ 丢失」这条承诺的实现起点。
 *
 * ## 为什么身份只从目录名取（INV-21）
 *
 * `cycle-N` 目录名是本仓唯一的结构化轮次身份。文档正文里的「本轮是 cycle-12」是
 * 自由文本，实测会出现"一句话提到多轮"的歧义（M0-④：按文本归属造出 3 组假乱序）。
 * 所以本模块**只**用目录名 + 目录 mtime，绝不解析任何文档内容。
 *
 * ## 为什么清单与体积统计也在这一层
 *
 * 快照（读侧投影）与归档路由（写侧 inventory）都需要"活跃/归档清单 + 体积"。
 * 两处各写一份目录遍历，迟早会在"空目录算不算""非 cycle-N 目录跳不跳"上分叉
 * ——本仓 G-SINGLE 纪律要求同一语义只有一个实现。
 *
 * ## 纪律
 *
 * 只读、不抛（不存在/无权限 ⇒ 空数组 + 无 archivedAt）。未 init 的项目必须得到
 * 可用的空枚举，而不是一个异常——宿主路由对未 init 项目必须可用。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleFact } from './projectionWindow.ts';

/** 目录是否真实存在（不存在/无权限 → false，不抛）。 */
export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** `cycle-N` 目录名清单（数值序；不存在 ⇒ 空数组）。 */
export function listCycleNames(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^cycle-\d+$/.test(n) && isDirectory(join(dir, n)))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}

/**
 * 递归体积统计（文件数 + 字节数）。
 *
 * 不可读条目**跳过而不是计 0**：并发清理（另一个进程刚删了临时文件）不是归档发现，
 * 但也绝不能把它记成"这个目录是空的"——那会让推进率/体积读数凭空变化。
 */
export function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else { files += 1; bytes += st.size; }
      } catch { /* 消失/不可读条目：跳过 */ }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * 枚举目录下的 `cycle-N`（数值序）。
 *
 * `withDate`：归档区用它取目录 mtime 作为归档日期。活跃区不需要日期（活跃轮的
 * 时间语义是"正在进行"，用 mtime 当日期会与"最后改过文件"混淆）。
 */
export function listCycleFacts(dir: string, opts: { withDate?: boolean } = {}): CycleFact[] {
  return listCycleNames(dir).map((name) => {
    const num = Number(name.slice(6));
    if (opts.withDate !== true) return { name, num };
    let archivedAt: string | undefined;
    try { archivedAt = statSync(join(dir, name)).mtime.toISOString().substring(0, 10); } catch { /* 无 mtime → 不伪造日期 */ }
    return archivedAt !== undefined ? { name, num, archivedAt } : { name, num };
  });
}
