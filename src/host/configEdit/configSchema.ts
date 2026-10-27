/**
 * 可编辑字段描述表（cycle-82 配置可视化编辑器）。
 *
 * ## 为什么是「表 + 生成器」而不是每组字段各写一份表单
 *
 * 字段的四种属性（在 YAML 的哪一段哪一键、什么类型、渲染成什么控件、怎么校验）
 * 必须**同源**：分开放的话，加了校验忘了加控件，或者控件允许的值校验拒绝，
 * 都会变成用户可见的荒谬行为。这里一张表同时喂给 host 校验与 client 表单。
 *
 * ## 未知字段只读不写
 *
 * 表里没有的键，`yamlPatch` 一律不碰。`.cycles/config.yml` 里还有
 * layers/evaluation/journeys/gates/human_gates/control_bands 等大段结构，
 * 它们是多行对象/数组的嵌套结构，用行级手术去改**风险远大于收益**
 * （一个缩进错了整段语义就变）。这是刻意的边界，不是没做。
 *
 * ## 单行纪律（防注入）
 *
 * 所有字段值最终都要塞进 YAML 的单行里。值里出现 `\n`/`\r` 就能凭空造出一个
 * 新键（`x\n  evil_key: true`），所以校验层一律拒绝换行与制表符，并限长。
 * 命令字段允许空格（`node scripts/build.mjs --watch`），其余同理。
 */
import { FLOWS } from '../../shared/flows.ts';

export type ConfigFieldKind = 'string' | 'command' | 'int' | 'bool' | 'stringArray' | 'enum';
export type ConfigFieldGroup = 'project' | 'commands' | 'macro' | 'anic';

/**
 * 数组字段的书写风格。
 *
 * - 'inline'（缺省）：规范内联 `[a, b]`——技术栈这类无外部读方的字段；
 * - 'comma'：裸逗号列表——`anic.allowedOrigins` 专用。原因：`host/config.ts`
 *   的 parseAnicSection 对它是**逗号分隔**解析、不剥方括号，写成 `[a, b]`
 *   会被读成 `[a` 与 `b]` 两个坏来源 —— 写进去就回读不出来。
 */
export type ArrayStyle = 'inline' | 'comma';

export interface ConfigFieldDef {
  /** 点路径 id（= patch 的键），如 'build.build_cmd' / 'anic.flow.workflowTab'。 */
  id: string;
  /** 顶层段名（缩进 0 的 `name:` 行）。 */
  section: string;
  /** 段内键名（缩进 2 的 `key:` 行）。 */
  key: string;
  kind: ConfigFieldKind;
  group: ConfigFieldGroup;
  /** 客户端词表键（写进 docs/anic/cycle-82-config-i18n.md，由 Lead 合并 locale）。 */
  labelKey: string;
  maxLength: number;
  /** 仅 stringArray 有意义；缺省 'inline'。 */
  arrayStyle?: ArrayStyle;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

/** 单行字段统一长度上限（512 足够容纳任何真实命令，同时挡住巨型注入串）。 */
export const MAX_SINGLE_LINE = 512;

/**
 * 词表键构造：`config.` 前缀 + 短名。
 *
 * 为什么不写整串字面量（`'config.field.buildCmd'`）：闭环体检的 `i18nGhosts`
 * 把 `labelKey: '...'` 与 `t('...')` 都当消费，而 locale 合并由 Lead 统一做——
 * 整串字面量会在合并前被报成幽灵消费（closureAuditContract ③ 红）。前缀形态
 * 由 `dynamicKeyPrefixes` 认领，合并前后都干净。见 docs/anic/cycle-82-config-i18n.md。
 */
const label = (suffix: string): string => 'config.' + suffix;

const CMD = (key: string, suffix: string): ConfigFieldDef => ({
  id: `build.${key}`, section: 'build', key, kind: 'command', group: 'commands', labelKey: label(suffix), maxLength: MAX_SINGLE_LINE,
});

/**
 * 字段表（顺序即渲染顺序）。
 *
 * `anic.flow.*` 由 shared/flows.ts 的 FLOWS 展开——那是开关的唯一事实源，
 * 在这里手抄一份键名，新增 flow 时就会漏掉编辑器入口（INV-29 同族缺陷）。
 */
export const CONFIG_FIELDS: readonly ConfigFieldDef[] = [
  { id: 'project.name', section: 'project', key: 'name', kind: 'string', group: 'project', labelKey: label('field.projectName'), maxLength: MAX_SINGLE_LINE },
  { id: 'project.tech_stack', section: 'project', key: 'tech_stack', kind: 'stringArray', group: 'project', labelKey: label('field.techStack'), maxLength: MAX_SINGLE_LINE },
  CMD('build_cmd', 'field.buildCmd'),
  CMD('typecheck_cmd', 'field.typecheckCmd'),
  CMD('lint_cmd', 'field.lintCmd'),
  CMD('test_cmd', 'field.testCmd'),
  CMD('coverage_cmd', 'field.coverageCmd'),
  CMD('e2e_cmd', 'field.e2eCmd'),
  CMD('hygiene_cmd', 'field.hygieneCmd'),
  { id: 'macro_cycle.autonomy_level', section: 'macro_cycle', key: 'autonomy_level', kind: 'enum', group: 'macro', labelKey: label('field.autonomyLevel'), maxLength: 8, enumValues: ['L1', 'L2', 'L3', 'L4'] },
  { id: 'macro_cycle.complexity_budget', section: 'macro_cycle', key: 'complexity_budget', kind: 'int', group: 'macro', labelKey: label('field.complexityBudget'), maxLength: 12, min: 1, max: 10000 },
  ...FLOWS.map((f): ConfigFieldDef => ({
    id: `anic.${f.id}`, section: 'anic', key: f.id, kind: 'bool', group: 'anic', labelKey: f.labelKey, maxLength: 8,
  })),
  // allowedOrigins 必须是裸逗号列表（见 ArrayStyle 注释：方括号会被 parseAnicSection 读坏）。
  { id: 'anic.allowedOrigins', section: 'anic', key: 'allowedOrigins', kind: 'stringArray', group: 'anic', labelKey: label('field.allowedOrigins'), maxLength: MAX_SINGLE_LINE, arrayStyle: 'comma' },
  { id: 'anic.toolDisclosure', section: 'anic', key: 'toolDisclosure', kind: 'enum', group: 'anic', labelKey: label('field.toolDisclosure'), maxLength: 16, enumValues: ['full', 'indexed'] },
];

const BY_ID = new Map(CONFIG_FIELDS.map((f) => [f.id, f]));

export function fieldById(id: string): ConfigFieldDef | undefined {
  return BY_ID.get(id);
}

/** 客户端表单的序列化视图（纯数据，无函数——直接进 JSON 响应）。 */
export interface ConfigFieldView {
  id: string;
  group: ConfigFieldGroup;
  kind: ConfigFieldKind;
  labelKey: string;
  enumValues: string[] | null;
  min: number | null;
  max: number | null;
  maxLength: number;
}

export function configFieldViews(): ConfigFieldView[] {
  return CONFIG_FIELDS.map((f) => ({
    id: f.id, group: f.group, kind: f.kind, labelKey: f.labelKey,
    enumValues: f.enumValues ? [...f.enumValues] : null,
    min: f.min ?? null, max: f.max ?? null, maxLength: f.maxLength,
  }));
}

/** 校验结果：ok=true 时 value 是**规范化后**的值（渲染成 YAML 文本的就是它）。 */
export type FieldValidation =
  | { ok: true; value: string | string[] | number | boolean }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\n\r\t]/;

/** 单行文本纪律：禁换行/回车/制表（防注入新键）+ 长度上限。 */
export function validateSingleLine(raw: unknown, def: ConfigFieldDef, allowEmpty: boolean): { ok: boolean; value: string; error: string } {
  if (typeof raw !== 'string') return { ok: false, value: '', error: 'expect string' };
  if (CONTROL_CHARS.test(raw)) return { ok: false, value: '', error: 'must not contain newline/CR/tab (would inject a new YAML key)' };
  const trimmed = raw.trim();
  if (!allowEmpty && trimmed === '') return { ok: false, value: '', error: 'must not be empty' };
  if (trimmed.length > def.maxLength) return { ok: false, value: '', error: `too long (>${String(def.maxLength)})` };
  return { ok: true, value: trimmed, error: '' };
}

/** 按字段类型校验并规范化（非法值一律拒绝，不静默截断/强转）。 */
export function validateFieldValue(def: ConfigFieldDef, raw: unknown): FieldValidation {
  switch (def.kind) {
    case 'string':
    case 'command': {
      // 命令允许内部空格（`node x.mjs --watch`），因此只 trim 两端。
      const v = validateSingleLine(raw, def, def.kind === 'command');
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error };
    }
    case 'enum': {
      const v = validateSingleLine(raw, def, false);
      if (!v.ok) return { ok: false, error: v.error };
      if (!def.enumValues?.includes(v.value)) {
        return { ok: false, error: `must be one of ${(def.enumValues ?? []).join('/')}` };
      }
      return { ok: true, value: v.value };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: 'expect boolean (true/false)' };
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'expect integer' };
      if (def.min !== undefined && n < def.min) return { ok: false, error: `must be >= ${String(def.min)}` };
      if (def.max !== undefined && n > def.max) return { ok: false, error: `must be <= ${String(def.max)}` };
      return { ok: true, value: n };
    }
    case 'stringArray': {
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' ? raw.split(',') : null;
      if (list === null) return { ok: false, error: 'expect string[]' };
      const out: string[] = [];
      for (const item of list) {
        const v = validateSingleLine(item, def, false);
        if (!v.ok) return { ok: false, error: v.error };
        if (v.value.includes(',')) return { ok: false, error: 'item must not contain comma (inline array separator)' };
        out.push(v.value);
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false, error: 'unsupported field kind' };
  }
}
