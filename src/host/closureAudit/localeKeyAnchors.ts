/**
 * 词表键 → `locale/zh.json` **真实行号**索引（cycle-75 · 修 `keyAnchor` 误报）。
 *
 * ## 被修的缺陷（T2 实测，Lead 复核证实）
 *
 * 旧 `keyAnchor()` 用 `key.split('.').pop()` 取**叶子名**，再在全文找第一处
 * `^\s*"<leaf>"\s*:` —— 短叶子名会命中**别的键**。实测三例全部错位：
 *
 * ```
 * trace.statusDone  → 报 :79   真值 :123   （:79 是 live.statusDone）
 * state.loading     → 报 :24   真值 :60    （:24 是别的 loading）
 * gate.pending      → 报 :75   真值 :235   （:75 是 live.pending）
 * ```
 *
 * 影响：`ClosureItem.definedAt` 是白盒面上「这资产在哪定义」的锚点，
 * 行号错会让读者跳到**无关行**——不是「留白」，是**可见性伪证**。
 * 本仓纪律「无证据 ≠ 通过」的同族推论：**错的行号比没有行号更糟**。
 *
 * ## 修法（方案 A：完整键路径 → 行号）
 *
 * 逐行扫描**文本**（不 JSON.parse —— 解析后拿不到行号），用**缩进栈**还原
 * JSON 路径：每行 `"k": value` 按缩进回退栈顶，`value` 是 `{` 则入栈，
 * 否则该行是一条叶子，键 = 栈内各级 + k。
 *
 * 为什么必须逐行而不是再解析一遍：`zh.json` 是**唯一**词表真相源（G-SINGLE），
 * 再 copy 一份数组就是第二真相源。本模块只建 `key → line` 的**行号索引**，
 * 键集仍以 `flattenKeys(JSON.parse(...))` 为准——两者若不一致由契约测试点名。
 */

/** 一行的解析结果：键、缩进、是否开启子对象。 */
interface ParsedLine {
  key: string;
  indent: number;
  opens: boolean;
  trimmedRight: string;
}

const KEY_LINE = /^\s*"([^"]+)"\s*:\s*(.*)$/;

/**
 * 解析一行。
 *
 * **必须先去掉行尾 `\r`**（Windows CRLF，本仓工作区就是 CRLF）：JS 正则的 `.`
 * **不匹配行终止符**，故 `(.*)$` 在 `"meta": {\r` 上永远失败——实测该缺陷让
 * 整个索引**零覆盖**（302 键全部未定位）。这是本仓已知的 CRLF 陷阱族
 * （T6 在技能脚本行号上踩过同款）。
 */
function parseLine(line: string): ParsedLine | null {
  const trimmedCr = line.endsWith('\r') ? line.slice(0, -1) : line;
  const m = KEY_LINE.exec(trimmedCr);
  if (!m || !m[1]) return null;
  const indent = trimmedCr.length - trimmedCr.trimStart().length;
  const rest = (m[2] ?? '').trim();
  return { key: m[1], indent, opens: rest.startsWith('{'), trimmedRight: rest };
}

/**
 * 建 `完整键路径 → 1 起行号` 索引。
 *
 * 同键重复（JSON 里同名键不可能合法共存于同一父级，但**不同父级**可同名）时
 * 各记各的完整路径，故不会互相覆盖——这正是旧实现缺的那一维。
 */
export function buildKeyLineIndex(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack: Array<{ indent: number; key: string }> = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i] as string);
    if (parsed === null) continue;
    // 回退到同级的父：缩进不小于本行者出栈。
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= parsed.indent) {
      stack.pop();
    }
    const path = [...stack.map((s) => s.key), parsed.key].join('.');
    if (parsed.opens) {
      stack.push({ indent: parsed.indent, key: parsed.key });
    } else {
      out.set(path, i + 1);
    }
  }
  return out;
}

/**
 * 词表键的行号（**未定位时返回 0**，不是猜一个行号）。
 *
 * `0` 是显式的「未定位」语义（调用方拼成 `locale/zh.json:0`）——
 * 比给一个错行诚实：错行会让读者以为定位成功。
 */
export function lineOfKey(index: ReadonlyMap<string, number>, key: string): number {
  return index.get(key) ?? 0;
}
