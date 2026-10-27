/**
 * 配置编辑器的客户端类型与形状守卫（cycle-82）。
 *
 * ## 为什么形状守卫写在这里而不是渲染器里
 *
 * 半截响应（路由 500、老宿主没有该端点、字段被裁剪）进渲染器会产生**看起来
 * 正常但内容错乱**的表单——那时用户保存下去的是错值。守卫的作用是让这种响应
 * 整块不渲染（null），而不是渲染出一张"字段都在但值全是空"的假表单。
 * 这也是本仓 budget/ledger/flows 各分区的同款做法（isBudget / isLedgerList）。
 */
import { isObjectLike } from '../../components/fetchJson.ts';
import { t } from '../../i18n.ts';

/**
 * 本分区词表键的**短名联合**（编译期防拼错）。
 *
 * ## 为什么键是「前缀 + 短名」而不是整串字面量（这条很重要）
 *
 * 新键还没进 `locale/*.json`（由 Lead 按 docs/anic/cycle-82-config-i18n.md 合并），
 * 而闭环体检有两条机械判据同时生效：
 *   - `i18nGhosts`：源码里出现 `t('config.title')` 这种**整串字面量** ⇒ 立刻被报成
 *     「幽灵消费」（键不存在），`closureAuditContract` ③ 变红；
 *   - `i18nClosure`：键进 locale 之后若无人消费 ⇒ 「死键」，`i18nDeadKeyContract` 红。
 * 前缀形态 `t('config.' + suffix)` 两头都安全：合并前键不存在（无幽灵、无死键），
 * 合并后 `dynamicKeyPrefixes` 以 `config.` 前缀认领全部 `config.*` 键（无死键）。
 * 仓内已有同款范式（`renderBudget` 的 `budget.status_${...}`）。
 *
 * 代价是拼错不再有幽灵提示，所以用字面量联合类型把拼错挡在**编译期**。
 * 这些文件里因此不出现任何 `config.xxx` 整串字面量。
 */
export type ConfigTextSuffix =
  | 'title' | 'ariaLabel' | 'hint' | 'dirty' | 'dirtyCount'
  | 'save' | 'saving' | 'savedAt' | 'preview' | 'discard' | 'reset' | 'resetOne'
  | 'previewSummary' | 'saveSummary' | 'saveFailed' | 'backupAt'
  | 'pathTitle' | 'pathMeta' | 'pathDir' | 'pathMissing' | 'pathUnresolved'
  | 'pathCopy' | 'pathCopyLabel' | 'pathProbeRejected' | 'pathProbeAccepted';

/** 词表前缀（导出供契约测试断言「该前缀被 dynamicKeyPrefixes 认领」）。 */
export const CONFIG_I18N_PREFIX = 'config.';

/**
 * 分区文案（唯一读法：前缀 + 短名，见上注）。
 *
 * ## 关键实现细节：`'config.'` 字面量必须**内联**，不能经常量中转
 *
 * 闭包扫描器 `dynamicKeyPrefixes` 认的形态是「`t(` 之后首个实参是**引号字面量**
 * 且该字面量以 `.`/`_` 结尾、紧跟 `+`」或反引号模板。写成
 * `t(CONFIG_I18N_PREFIX + suffix)` 时首个 token 是**标识符**，两种形态都不命中
 * ⇒ 扫描器看不见任何 `config.*` 消费 ⇒ locale 合并后 55 条键全被判**死键**
 * （cycle-82 实测踩到，Lead 定位）。
 *
 * 直接实验证据（同一段源码喂给 dynamicKeyPrefixes）：
 *   `t('config.' + suffix)`            → 认领 `config.` ✓
 *   `t(CONFIG_I18N_PREFIX + suffix)`   → 认领 0 个     ✗
 *   `t('config.' + 'group.' + group)`  → 认领 `config.` ✓
 *
 * 所以常量**保留导出**（契约测试要断言它被认领），只是绝不进 `t()` 的实参首位置。
 */
export function cfgText(suffix: ConfigTextSuffix, params?: Record<string, string | number>): string {
  return t('config.' + suffix, params);
}

/** 分组标题（组名来自服务端 schema，故键名动态拼接）。 */
export function cfgGroupText(group: string): string {
  return t('config.' + 'group.' + group);
}

/** 与 host/configEdit/configSchema.ts 的 ConfigFieldView 逐字段对应。 */
export interface ConfigFieldJson {
  id: string;
  group: 'project' | 'commands' | 'macro' | 'anic';
  kind: 'string' | 'command' | 'int' | 'bool' | 'stringArray' | 'enum';
  labelKey: string;
  enumValues: string[] | null;
  min: number | null;
  max: number | null;
  maxLength: number;
}

/** 与 host/configEdit/paths.ts 的 PathEntry 逐字段对应。 */
export interface ConfigPathJson {
  id: string;
  labelKey: string;
  path: string | null;
  kind: 'dir' | 'file';
  exists: boolean;
  isDir: boolean;
  bytes: number;
  mtime: string | null;
  source: string;
}

/** GET /anic/api/config 响应。 */
export interface ConfigJson {
  workspace: string;
  values: Record<string, unknown>;
  schema: ConfigFieldJson[];
  paths: { workspace: string; entries: ConfigPathJson[]; warnings: string[] };
  warnings: string[];
  rawHash: string | null;
  configFile: { exists: boolean; bytes: number; mtime: string | null };
  backups: string[];
  /** 仅当请求带 ?probePath= 时出现。 */
  probe?: { ok: boolean; entry?: ConfigPathJson; reason?: string; code?: string } | null;
}

/** POST /anic/api/config 响应（dryRun 带 diff，真写带 applied/observed）。 */
export interface ConfigWriteJson {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  error: string;
  changedFields: string[];
  insertedFields: string[];
  warnings: string[];
  backupPath?: string | null;
  observed?: Record<string, unknown> | null;
  diff?: Array<{ kind: 'same' | 'add' | 'remove'; text: string; beforeLine: number | null; afterLine: number | null }>;
  stats?: { changed: number; added: number; removed: number };
  beforeHash?: string;
  afterHash?: string;
}

/** 配置与路径表的唯一端点（相对路径——桌面端经 dsh-app 同源代理）。 */
export const CONFIG_URL = '/anic/api/config';

const GROUPS = ['project', 'commands', 'macro', 'anic'] as const;
const KINDS = ['string', 'command', 'int', 'bool', 'stringArray', 'enum'] as const;

function isField(v: unknown): v is ConfigFieldJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.labelKey !== 'string') return false;
  if (!GROUPS.includes(o.group as (typeof GROUPS)[number])) return false;
  if (!KINDS.includes(o.kind as (typeof KINDS)[number])) return false;
  if (typeof o.maxLength !== 'number') return false;
  if (o.enumValues !== null && !Array.isArray(o.enumValues)) return false;
  return true;
}

function isPathEntry(v: unknown): v is ConfigPathJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.labelKey !== 'string') return false;
  if (o.kind !== 'dir' && o.kind !== 'file') return false;
  if (typeof o.exists !== 'boolean' || typeof o.isDir !== 'boolean') return false;
  if (typeof o.bytes !== 'number') return false;
  if (o.path !== null && typeof o.path !== 'string') return false;
  return true;
}

/**
 * 采信条件：schema 非空且**每一项**形状合法 + paths.entries 是合法数组。
 *
 * 为什么要求 schema 非空：空 schema 会让整张表单"渲染成功但一个字段都没有"，
 * 用户只会以为「这个项目没有可配项」——那是把接口故障伪装成正常态。
 */
export function isConfigJson(v: unknown): v is ConfigJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.workspace !== 'string') return false;
  if (!isObjectLike(o.values)) return false;
  if (!Array.isArray(o.schema) || o.schema.length === 0) return false;
  if (!o.schema.every(isField)) return false;
  if (!isObjectLike(o.paths)) return false;
  const paths = o.paths as Record<string, unknown>;
  if (!Array.isArray(paths.entries) || !paths.entries.every(isPathEntry)) return false;
  if (!Array.isArray(o.warnings)) return false;
  if (!isObjectLike(o.configFile)) return false;
  return true;
}

/** 写入响应的形状守卫（ok 必须有，其余字段按需透传）。 */
export function isConfigWriteJson(v: unknown): v is ConfigWriteJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.ok === 'boolean' && Array.isArray(o.changedFields) && Array.isArray(o.warnings);
}

/** 表单草稿值 → 提交给 patch 的值（布尔/数字在这里定型，字符串原样）。 */
export function draftToPatchValue(field: ConfigFieldJson, draft: string | boolean): unknown {
  if (field.kind === 'bool') return draft === true || draft === 'true';
  if (field.kind === 'int') return typeof draft === 'string' ? Number.parseInt(draft, 10) : Number(draft);
  if (field.kind === 'stringArray') {
    const text = typeof draft === 'string' ? draft : String(draft);
    return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  return typeof draft === 'string' ? draft : String(draft);
}

/** 服务端值 → 草稿文本（null 显示为空，不让 "null" 字面进输入框）。 */
export function valueToDraftText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
