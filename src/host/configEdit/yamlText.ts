/**
 * 行级 YAML 手术的**文字原语**（cycle-82 配置可视化编辑器）。
 *
 * ## 为什么没有 yaml 依赖（docs/anic/21 §3.1 的落地）
 *
 * ① 运行时零依赖是硬纪律（package.json 的 dependencies 至今为空）；
 * ② 更致命：任何 `parse → stringify` 都会把 `.cycles/config.yml` 里的中文注释
 *    抹掉——而注释是「为什么这么配」的唯一载体（cycle-77 就往 complexity_budget
 *    上写了四行解释），丢注释比丢字段更糟。
 *
 * ## 职责边界
 *
 * 本文件只做**单行文字**的读与生成：引号策略、行内注释剥离、多行块遮蔽、
 * 行尾风格。段/键的定位与改写策略在 `yamlPatch.ts`；语义校验在 `configSchema.ts`。
 * 把这三层拆开是因为它们各自都有独立的失败模式，混在一个文件里就没法分开测。
 *
 * ## 语义对齐（必须与 host/config.ts 一致，否则写进去的值读不回来）
 *
 * `host/config.ts` 的 `getYamlString` 用 `indexOf(' #')` 剥行内注释、用
 * 「首尾都是同一引号才剥」的引号容错。本文件的 `parseScalar` 是同一语义的
 * 更严格实现（引号内的 `#` **不**当注释），两者在合法输入上等价——差异只在
 * 「引号内含 #」这一种情形，此时本实现是正确的那一方（见 stripInlineComment 注）。
 */

/** 行尾风格：内容里出现过 CRLF 就整体按 CRLF 补齐（绝不混排）。 */
export interface EolInfo {
  seq: '\n' | '\r\n';
  /** 原文是否以换行结尾（插入时不擅自加上/去掉尾换行）。 */
  trailing: boolean;
}

export function detectEol(content: string): EolInfo {
  return {
    seq: content.includes('\r\n') ? '\r\n' : '\n',
    trailing: content.endsWith('\n'),
  };
}

/** 切行（去 EOL，保留空行）。末尾换行不产生额外空行。 */
export function splitLines(content: string): string[] {
  if (content === '') return [];
  // 先剥尾换行：只剥 `\n` 会把 CRLF 文件最后一行的 `\r` 留在行内，
  // 于是「原样写回」变成「多一个 \r」——那是字节级污染，diff 会把它当成改动。
  const body = content.endsWith('\n')
    ? content.slice(0, content.endsWith('\r\n') ? content.length - 2 : content.length - 1)
    : content;
  return body.split(/\r?\n/);
}

/** 合行（按 EolInfo 还原尾换行）。 */
export function joinLines(lines: readonly string[], eol: EolInfo): string {
  const body = lines.join(eol.seq);
  return eol.trailing ? body + eol.seq : body;
}

/** 行首缩进宽度（制表符按 1 计——本仓配置只缩进空格，够用且不引入歧义）。 */
export function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n += 1;
  return n;
}

export function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 整行注释（`#` 前只有空白）。 */
export function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/** 引号状态机：返回 `#` 之后的部分（不含 `#`），用于在不破坏引号语义的前提下拆注释。 */
function commentSplitAt(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    // YAML: `#` 只有位于行首或前面是空白时才是注释开始。
    // `https://a#frag` 里的 # 不是注释——config.ts 的 indexOf(' #') 同口径。
    if (c === '#' && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return i;
    }
  }
  return -1;
}

/**
 * 拆行内注释：`key: value  # why` → { body: 'key: value  ', comment: '# why' }。
 * comment 保留 `#` 与之后原文（含前面的空白由调用方决定怎么拼）。
 */
export function splitInlineComment(text: string): { body: string; comment: string } {
  const at = commentSplitAt(text);
  if (at < 0) return { body: text, comment: '' };
  return { body: text.slice(0, at), comment: text.slice(at).trimEnd() };
}

/** 单引号/双引号包裹则剥掉（双引号内的 \" 与 \\ 反转义）。 */
export function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2) {
    const first = v.charAt(0);
    const last = v.charAt(v.length - 1);
    if (first === '"' && last === '"') {
      return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (first === "'" && last === "'") {
      // YAML 单引号内的 '' 表示一个字面单引号
      return v.slice(1, -1).replaceAll("''", "'");
    }
  }
  return v;
}

/** 标量文本 → 值（空 = null，表示「这行没有值」）。 */
export function parseScalar(text: string): string | null {
  const v = unquote(splitInlineComment(text).body);
  return v.length > 0 ? v : null;
}

/** 看起来像数字/布尔的字符串必须加引号，否则写进去会被当成别的类型。 */
const LOOKS_NUMERIC = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const LOOKS_SPECIAL = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
/** 首字符是 YAML 指示符时必须加引号（否则解析成列表/映射/锚点/标签）。 */
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * 值 → 安全的单行 YAML 文本。
 *
 * 加引号判据全部是「不加就会改变语义」的情形，不做美化：能裸写就裸写，
 * 这样 `dsh-anic`、`node scripts/build.mjs` 这类既有裸值改写后形态不变。
 */
export function serializeScalar(value: string): string {
  if (value === '') return '""';
  const needsQuote =
    LOOKS_NUMERIC.test(value)
    || LOOKS_SPECIAL.test(value)
    || LEADING_INDICATOR.test(value)
    || /^\s|\s$/.test(value)
    || /#/.test(value)
    || /\t/.test(value)
    || /:(\s|$)/.test(value);
  if (!needsQuote) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 内联数组解析：`["a", b]` → ['a','b']；不是数组形态返回 null。 */
export function parseInlineArray(text: string): string[] | null {
  const body = splitInlineComment(text).body.trim();
  if (!body.startsWith('[') || !body.endsWith(']')) return null;
  const inner = body.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => unquote(part));
}

/** 内联数组生成：空数组写 `[]`（与既有 `metrics: []` 形态一致）。 */
export function serializeInlineArray(items: readonly string[]): string {
  if (items.length === 0) return '[]';
  return '[' + items.map((it) => serializeScalar(it)).join(', ') + ']';
}

/** 该行是否是多行块标量头（`key: |`、`key: >-`、`key: |2`）。 */
function isBlockScalarHeader(line: string): boolean {
  const body = splitInlineComment(line).body;
  return /[|>][+-]?\d?\s*$/.test(body) && /:\s*[|>]/.test(body);
}

/**
 * 多行块标量的**正文行**下标集合。
 *
 * 为什么必须先算这个：块正文里可能出现缩进 0 的 `something:` 文本（脚本片段、
 * 示例 YAML），不遮蔽就会被当成一个新的顶层段 —— 手术刀会切到别人的字段上。
 */
export function blockScalarBodyLines(lines: readonly string[]): Set<number> {
  const mask = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (mask.has(i)) continue;
    const line = lines[i] as string;
    if (!isBlockScalarHeader(line)) continue;
    const base = indentOf(line);
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] as string;
      if (isBlank(next) || indentOf(next) > base) { mask.add(j); j += 1; continue; }
      break;
    }
  }
  return mask;
}

/** 注释行集合（改动前后必须完全相等——注释是用户资产，不是可再生成的注释）。 */
export function commentLines(lines: readonly string[]): string[] {
  return lines.filter((l) => isCommentLine(l));
}
