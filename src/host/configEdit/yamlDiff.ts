/**
 * 行级 diff（cycle-82）—— 配置 patch 的**预览证据**。
 *
 * ## 为什么自己写而不是引 diff 库
 *
 * ① 零运行时依赖纪律；② 需要的是「行级、确定、可断言」的最小实现，不是
 * 字符级高亮。配置文件百来行，O(n²) 的 LCS 完全够用，而且实现短到能被
 * 逐行读懂——正是本仓「可测即可维护」的取向。
 *
 * ## 为什么这是验收判据的一部分
 *
 * docs/anic/21 §3.2 的判据是机械的：**差异行数 = 改动字段数**。改一个标量
 * 应当只产生 1 删 + 1 增（两行）；如果差异行数多于字段数，说明手术刀切到了
 * 别的行（重排、缩进漂移、吃掉了空行）——那就不是「手术式 patch」了。
 * dryRun 的预览与真写的回读用的是同一个 planPatch，所以预览不是装饰。
 */
import { splitLines } from './yamlText.ts';

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
  /** 在 before / after 中的 1 起行号（对应侧为 null）。 */
  beforeLine: number | null;
  afterLine: number | null;
}

/** 行级 LCS diff（同输入同输出；不做上下文折叠——调用方按 kind 过滤）。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as number[];
    const below = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      const down = below[j] as number;
      row[j] = a[i] === b[j] ? down + 1 : Math.max(down, below[j + 1] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string, beforeLine: i + 1, afterLine: j + 1 });
      i += 1; j += 1; continue;
    }
    const down = (lcs[i + 1] as number[])[j] as number;
    const right = (lcs[i] as number[])[j + 1] as number;
    if (down >= right) {
      out.push({ kind: 'remove', text: a[i] as string, beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] as string, beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) { out.push({ kind: 'remove', text: a[i] as string, beforeLine: i + 1, afterLine: null }); i += 1; }
  while (j < m) { out.push({ kind: 'add', text: b[j] as string, beforeLine: null, afterLine: j + 1 }); j += 1; }
  return out;
}

/** 差异摘要：changed = 删+增（「差异行数 = 改动字段数」的机器判据）。 */
export function diffStats(before: string, after: string): { changed: number; added: number; removed: number } {
  const d = lineDiff(before, after);
  const added = d.filter((x) => x.kind === 'add').length;
  const removed = d.filter((x) => x.kind === 'remove').length;
  return { changed: added + removed, added, removed };
}
