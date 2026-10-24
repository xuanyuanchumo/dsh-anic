/**
 * 闭环体检**文本原语**（cycle-76：从 scanPrimitives 下沉，破 import 环）。
 *
 * ## 为什么要下沉
 *
 * cycle-76 引入倒排索引（`evidenceIndex.ts`）后出现**运行时 import 环**：
 *   `scanPrimitives` → `evidenceIndex`（取 evidenceFor）
 *   `evidenceIndex` → `scanPrimitives`（取 stripComments）
 * 被 `skillConvergenceContract` 的 importGraph 守卫**真实抓到**（Q5 架构约束：
 * 无运行时环）。破环的标准手法是把**最底层、无依赖**的能力下沉——本文件只含
 * 「字符级文本处理」，不依赖任何其他模块。
 *
 * 判定口径不变：`stripComments` 保留换行 ⇒ 行号与磁盘一致（证据锚点依赖此性质）。
 */

const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);

/** 三种引号字符（供 RegExp 构造使用——正则字面量里的引号会让 stripComments 失衡）。 */
export function quoteClasses(): string {
  return SQ + DQ + BACKTICK;
}

/** 去注释但保留换行（行号必须与磁盘一致；与 panelLayoutContract 同款实现）。 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inStr: string | null = null;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; i += 1; continue; }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    if (inStr !== null) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i += 2; continue; }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i += 2; continue; }
    if (c === SQ || c === DQ || c === BACKTICK) { inStr = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}
