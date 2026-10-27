/**
 * 从 config 原文**按字段定义回读**当前值（cycle-82）。
 *
 * ## 为什么与「读整份配置」分开
 *
 * `host/config.ts` 的 `loadWorkspaceConfig` 是语义入口（INV-25），但它只解析
 * 它自己消费的那几个键。编辑器需要读 `project.name`、`coverage_cmd` 这类
 * loader 不解析的字段——那份读取逻辑在这里，且必须与 loader **同一定位语义**
 * （段 = 缩进 0 的 `name:`，段体到下一个缩进 0 的非空行为止），否则会出现
 * 「表单显示 L4、loader 认为 L3」这种最坏形态的双投影矛盾。
 *
 * ## allowedOrigins 为什么不用内联数组
 *
 * `parseAnicSection` 对 `allowedOrigins` 是**逗号列表**解析（不剥 `[...]`）。
 * 写成 `[a, b]` 会被它读成 `[a` 与 `b]` 两个坏来源——写进去就回读不出来。
 * 所以该字段按 `arrayStyle: 'comma'` 序列化（裸逗号列表），
 * 而 `tech_stack` 这类无 loader 消费者的字段用规范内联 `[a, b]`。
 */
import {
  blockScalarBodyLines,
  indentOf,
  isBlank,
  isCommentLine,
  parseInlineArray,
  parseScalar,
  splitInlineComment,
  splitLines,
  unquote,
} from './yamlText.ts';
import type { ConfigFieldDef } from './configSchema.ts';

/** 逗号列表解析（与 host/config.ts 的 parseAnicSection 逐条同语义）。 */
export function parseCommaList(text: string): string[] {
  const raw = splitInlineComment(text).body;
  const out: string[] = [];
  for (const part of raw.split(',')) {
    let v = unquote(part);
    v = v.replace(/\/+$/, '');
    if (v.length > 0) out.push(v);
  }
  return out;
}

/** 原文字面 → 类型化值（不做范围校验，校验在 validateFieldValue）。 */
function decodeValue(def: ConfigFieldDef, tail: string): string | string[] | number | boolean | null {
  if (def.kind === 'bool') {
    const v = (parseScalar(tail) ?? '').toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }
  if (def.kind === 'int') {
    const v = parseScalar(tail);
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (def.kind === 'stringArray') {
    if (def.arrayStyle === 'comma') return parseCommaList(tail);
    return parseInlineArray(tail);
  }
  return parseScalar(tail);
}

/** 段体内该键出现的全部行（重复键由调用方决定怎么处理——这里如实返回全部）。 */
export function findKeyLines(
  lines: readonly string[],
  section: string,
  key: string,
): { header: number; end: number; hits: number[] } | null {
  const mask = blockScalarBodyLines(lines);
  let header = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (mask.has(i)) continue;
    const line = lines[i] as string;
    if (isBlank(line) || isCommentLine(line) || indentOf(line) !== 0) continue;
    if (splitInlineComment(line).body.trimEnd() === `${section}:`) { header = i; break; }
  }
  if (header < 0) return null;
  let end = lines.length;
  for (let j = header + 1; j < lines.length; j += 1) {
    if (mask.has(j)) continue;
    const next = lines[j] as string;
    if (isBlank(next) || isCommentLine(next)) continue;
    if (indentOf(next) === 0) { end = j; break; }
  }
  const hits: number[] = [];
  for (let i = header + 1; i < end; i += 1) {
    if (mask.has(i)) continue;
    const line = lines[i] as string;
    if (isBlank(line) || isCommentLine(line)) continue;
    if (indentOf(line) === 0) continue;
    const m = /^\s+([A-Za-z0-9_.-]+)\s*:/.exec(splitInlineComment(line).body);
    if (m && m[1] === key) hits.push(i);
  }
  return { header, end, hits };
}

/**
 * 读某字段的当前值（缺键 = null）。
 *
 * 重复键返回**第一个**（与 `host/config.ts` 的 `getYamlString` 同口径）；
 * 写入侧对重复键一律拒绝（见 yamlPatch），所以这个选择只影响"显示什么"。
 */
export function readFieldValue(content: string, def: ConfigFieldDef): string | string[] | number | boolean | null {
  const lines = splitLines(content);
  const found = findKeyLines(lines, def.section, def.key);
  const at = found?.hits[0];
  if (at === undefined) return null;
  const body = splitInlineComment(lines[at] as string).body;
  const m = /^\s+[A-Za-z0-9_.-]+\s*:(.*)$/.exec(body);
  if (!m) return null;
  const tail = m[1] ?? '';
  // 块标量/嵌套结构没有单行值可读——如实为 null，不猜内容。
  if (/^\s*$/.test(tail) || /^\s*[|>][+-]?\d?\s*$/.test(tail)) return null;
  return decodeValue(def, tail);
}
