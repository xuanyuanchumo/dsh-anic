/**
 * 路由族**扫描原语**（cycle-75：从 assetClosure.ts 拆出，满足单文件 ≤250 行 T3）。
 *
 * 本文件只放「怎么从文本里认出真注册点」的机械部件：行号计算、路径字面量正则、
 * 常量表、括号配平。族语义（三态判定、消费面、幽灵）留在 assetClosure.ts。
 *
 * 拆分理由：cycle-75 为修一个**实测缺陷**给形态 A 加了括号配平（见 balancedBraces
 * 头注），assetClosure.ts 因此越 250 行。原语与语义分离后两处都不再逼近上限。
 */
import { quoteClasses } from './scanPrimitives.ts';

/** 三种引号字符（经 RegExp 构造——引号字面量会让去注释状态机失衡）。 */
export const SQ = String.fromCharCode(39);
export const DQ = String.fromCharCode(34);
export const BACKTICK = String.fromCharCode(96);

/** 路由族扫描域：路由文件 + snapshotRoute（其余 Route.ts 由 routes/ 覆盖）。 */
export const ROUTE_FILE = /^src\/host\/(routes\/[A-Za-z0-9_]+\.ts|snapshotRoute\.ts)$/;

/** 非路由帮手（被 ROUTE_FILE 匹配但只提供共享工具，不注册端点）。 */
export const NON_ROUTE_HELPERS = new Set(['src/host/routes/routeContext.ts']);

/** 索引 → 行号（1 起）：去注释文本保留换行，故行号与磁盘一致。 */
export function lineAt(text: string, idx: number): number {
  let n = 1;
  const end = Math.min(idx, text.length);
  for (let i = 0; i < end; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/** 路径字面量正则（三种引号）。 */
export function pathLiteralRe(): RegExp {
  const q = quoteClasses();
  return new RegExp('[' + q + '](/anic/[A-Za-z0-9_/.-]+)[' + q + ']');
}

/** 同文件内 `const IDENT = '<literal>'` 常量表（path: IDENT 形态回溯用）。 */
export function constTable(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = quoteClasses();
  const re = new RegExp('const\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*[' + q + '](/anic/[A-Za-z0-9_/.-]+)[' + q + ']', 'g');
  for (const m of text.matchAll(re)) if (m[1] && m[2]) out.set(m[1], m[2]);
  return out;
}

/**
 * 从 `{` 起括号配平取出对象字面量正文（cycle-75 实测缺陷修复）。
 *
 * **为什么必须配平而不是固定窗口**（T5 变异测试 M5 抓到的真实缺陷）：
 * 上一版用「`register({` 起 600 字窗口 + `handler:` 截断」定位 path。任何把
 * `path:` 推到 600 字之后的**无害重构**（长注释被 stripComments 保长、参数增补、
 * 换行风格变化）都会让注册**静默漏报** —— registered/produced/unconsumed
 * 三个数同时漂移而无人察觉。实测：path 推远 700 字后 produced 直接为空。
 * 配平取实参不依赖距离，是唯一不随排版漂移的判据。
 *
 * 字符串内的花括号不参与配平（引号状态机），否则 `note: 'a } b'` 会提前截断。
 * 未闭合（截断文件/夹具）时返回到文本末尾——响亮退化为「按能读到的部分判定」，
 * 而不是静默漏报整条注册。
 */
export function balancedBraces(text: string, openAt: number): { body: string; from: number } {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openAt; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inStr !== null) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === SQ || c === DQ || c === BACKTICK) { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openAt + 1, i), from: openAt + 1 };
    }
  }
  return { body: text.slice(openAt + 1), from: openAt + 1 };
}
