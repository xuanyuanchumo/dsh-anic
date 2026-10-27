/**
 * 行级手术式 YAML patch（cycle-82）—— 保留注释、保留未知键、保留键顺序。
 *
 * ## 为什么不能「读成对象再写回」
 *
 * `.cycles/config.yml` 里到处是解释性中文注释（cycle-77 就给 complexity_budget
 * 写了四行）。任何 parse→stringify 都会把注释连同上下的空行节奏一起抹平，
 * 而注释是「为什么这么配」的唯一载体——丢注释比丢字段更糟（docs/anic/21 §3.1）。
 *
 * ## 判据（机械可证伪）
 *
 * ① 只动命中的那一行：其余行**逐字节相等**（`lineDiff` 的 same 部分可断言）；
 * ② 注释行集合改动前后**完全相等**；
 * ③ 段/键定位与 `host/config.ts` 的 `parseAnicSection` 同源（缩进 0 = 段头，
 *    段体止于下一个缩进 0 的非空行），否则「写进去读不回来」；
 * ④ 缺失键在**段尾**插入；整段缺失则在文件末尾新建段（绝不插到别的段里）；
 * ⑤ 值不是单行标量（块标量 `|`/`>` 或有子结构）时**拒绝改写**并说明原因——
 *    展开子结构属于语义重写，超出「换个值」的边界；
 * ⑥ 同键重复出现时**拒绝**：那两个值谁生效取决于读者，静默只改一行会造出
 *    「改了但没生效」的假象。
 *
 * 定位原语在 `configRead.ts`（读与写必须共用一套段/键判定，否则两边的
 * 「段边界」会各自漂移）；差异计算在 `yamlDiff.ts`。
 */
import {
  blockScalarBodyLines,
  detectEol,
  indentOf,
  isBlank,
  isCommentLine,
  joinLines,
  serializeInlineArray,
  serializeScalar,
  splitInlineComment,
  splitLines,
} from './yamlText.ts';
import {
  CONFIG_FIELDS,
  fieldById,
  validateFieldValue,
  type ConfigFieldDef,
} from './configSchema.ts';
import { findKeyLines, readFieldValue } from './configRead.ts';

/** 规范化后的目标值（写进 YAML 的就是这个）。 */
export type PatchValue = string | string[] | number | boolean;

export interface PatchPlan {
  ok: boolean;
  /** 全部字段都合法时才有意义（ok=false 时等于 before）。 */
  before: string;
  after: string;
  /** 真正发生变化的字段 id（已与目标值相等的不计，保证幂等且不制造无谓 diff）。 */
  changedFields: string[];
  /** 本次需要新插入的字段 id（段内原本没有该键）。 */
  insertedFields: string[];
  warnings: string[];
  /** ok=false 时的第一个原因（其余进 warnings）。 */
  error: string;
}

/** 值 → YAML 单行文本（类型自适应，数组按字段的 arrayStyle 展开）。 */
function renderValue(def: ConfigFieldDef, value: PatchValue): string {
  if (def.kind === 'bool') return value === true ? 'true' : 'false';
  if (def.kind === 'int') return String(value);
  if (def.kind === 'stringArray') {
    const items = Array.isArray(value) ? value : [];
    // 裸逗号列表：分隔符后带一个空格（与技能侧写法一致，且 parseCommaList 会 trim）。
    return def.arrayStyle === 'comma' ? items.join(', ') : serializeInlineArray(items);
  }
  return serializeScalar(String(value));
}

/** 值相等判定（数组按内容比，其余按类型比——`100` 与 `'100'` 不算相等，避免假幂等）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

/** 把值塞回原行：保留缩进、键名、冒号后空白节奏与行内注释。返回 null = 拒绝改写。 */
function rewriteLine(line: string, def: ConfigFieldDef, value: PatchValue, warnings: string[]): string | null {
  const { body, comment } = splitInlineComment(line);
  const m = /^(\s*[A-Za-z0-9_.-]+\s*:\s*)([\s\S]*)$/.exec(body);
  if (!m || m[1] === undefined) return null;
  const prefix = m[1];
  const rest = m[2] ?? '';
  // 块标量头（`key: |` / `key: >-`）：正文在后续行，单行替换会把块截断成字符串。
  if (/^[|>][+-]?\d?\s*$/.test(rest.trim())) {
    warnings.push(`${def.id}: 值为多行块标量，拒绝原位改写（改成单行会丢失块结构）`);
    return null;
  }
  if (rest.trim() === '') {
    warnings.push(`${def.id}: 键后无单行值（可能是嵌套结构），拒绝原位改写`);
    return null;
  }
  // 行内注释前的空白原样保留（`L4  # note` 里的两空格是作者的排版意图）。
  const trailing = /[ \t]+$/.exec(rest)?.[0] ?? '';
  const gap = comment === '' ? '' : (trailing === '' ? '  ' : trailing);
  return `${prefix}${renderValue(def, value)}${gap}${comment}`;
}

/** 段内子键缩进（取第一个子键的缩进，缺省 2）。 */
function childIndent(lines: readonly string[], header: number, end: number): number {
  for (let i = header + 1; i < end; i += 1) {
    const line = lines[i] as string;
    if (isBlank(line) || isCommentLine(line)) continue;
    const ind = indentOf(line);
    if (ind > 0) return ind;
  }
  return 2;
}

/**
 * 生成 patch 计划（**纯函数，不落盘**）。dryRun 与真写共用本函数——
 * 「预览的 diff」与「真正写下的内容」必须是同一个字节串，否则预览是装饰。
 */
export function planPatch(content: string, patch: Record<string, unknown>): PatchPlan {
  const warnings: string[] = [];
  const changed: string[] = [];
  const inserted: string[] = [];
  const targets: Array<{ def: ConfigFieldDef; value: PatchValue }> = [];

  // 校验阶段：任一非法值 ⇒ 整体拒绝（不做部分写入——半套配置比没改更危险）。
  for (const [id, raw] of Object.entries(patch)) {
    const def = fieldById(id);
    if (!def) {
      warnings.push(`${id}: 未知字段（只读不写）`);
      continue;
    }
    const v = validateFieldValue(def, raw);
    if (!v.ok) {
      return { ok: false, before: content, after: content, changedFields: [], insertedFields: [], warnings, error: `${id}: ${v.error}` };
    }
    targets.push({ def, value: v.value as PatchValue });
  }
  if (targets.length === 0) {
    return { ok: false, before: content, after: content, changedFields: [], insertedFields: [], warnings, error: 'patch 不含任何可写字段' };
  }

  const eol = detectEol(content);
  const lines = splitLines(content);
  // 遮蔽集随插入移动，必须每轮重算（块标量正文的行号会整体偏移）。
  let mask = blockScalarBodyLines(lines);

  // 按字段表顺序处理：插入位置互相影响，顺序必须确定（同输入同输出）。
  const ordered = [...targets].sort((a, b) => CONFIG_FIELDS.indexOf(a.def) - CONFIG_FIELDS.indexOf(b.def));

  for (const { def, value } of ordered) {
    // 每轮都以**当前文本**回读：上一轮的插入会移动行号，用原始 content 判
    // 「要不要改」会在多字段 patch 里重复插入（同键两行 = 语义歧义）。
    if (sameValue(readFieldValue(joinLines(lines, eol), def), value)) continue;

    const found = findKeyLines(lines, def.section, def.key);
    if (found === null) {
      // 整段缺失：在文件末尾新建（绝不在段内其它位置猜测归属）。
      if (lines.length > 0 && !isBlank(lines[lines.length - 1] as string)) lines.push('');
      lines.push(`${def.section}:`, `  ${def.key}: ${renderValue(def, value)}`);
      mask = blockScalarBodyLines(lines);
      changed.push(def.id);
      inserted.push(def.id);
      warnings.push(`${def.id}: 段 '${def.section}' 不存在，已在文件末尾新建`);
      continue;
    }
    if (found.hits.length > 1) {
      return { ok: false, before: content, after: content, changedFields: [], insertedFields: [], warnings, error: `${def.id}: 键在段内出现 ${String(found.hits.length)} 次（重复键：谁生效取决于读者，拒绝静默改一行）` };
    }
    const at = found.hits[0];
    if (at === undefined) {
      // 段内缺键：插到段体最后一个非空内容行之后（保持段尾注释跟随原位）。
      let insertAt = found.header + 1;
      for (let i = found.header + 1; i < found.end; i += 1) {
        const l = lines[i] as string;
        if (!isBlank(l) && !isCommentLine(l)) insertAt = i + 1;
      }
      lines.splice(insertAt, 0, `${' '.repeat(childIndent(lines, found.header, found.end))}${def.key}: ${renderValue(def, value)}`);
      mask = blockScalarBodyLines(lines);
      changed.push(def.id);
      inserted.push(def.id);
      warnings.push(`${def.id}: 段内缺键，已在段尾插入`);
      continue;
    }
    const next = rewriteLine(lines[at] as string, def, value, warnings);
    if (next === null) {
      return { ok: false, before: content, after: content, changedFields: [], insertedFields: [], warnings, error: `${def.id}: 该字段无法原位改写（原因见 warnings）` };
    }
    if (next === lines[at]) continue;
    lines[at] = next;
    changed.push(def.id);
  }

  const after = joinLines(lines, eol);
  if (changed.length === 0) warnings.push('patch 与当前配置一致，无字段变化');
  return { ok: true, before: content, after, changedFields: changed, insertedFields: inserted, warnings, error: '' };
}
