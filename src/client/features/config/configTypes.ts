/**
 * 配置编辑器的客户端类型与词表读取（cycle-82）。
 *
 * ## 为什么词表键是「前缀 + 短名」（这条很重要）
 *
 * 新键还没进 `locale/*.json`（由 Lead 按 docs/anic/cycle-8x-config-i18n.md 合并），
 * 而闭环体检有两条机械判据同时生效：
 *   - `i18nGhosts`：源码里出现 `t('config.title')` 这种**整串字面量** ⇒ 立刻被报成
 *     「幽灵消费」（键不存在），`closureAuditContract` ③ 变红；
 *   - `i18nClosure`：键进 locale 之后若无人消费 ⇒ 「死键」，`i18nDeadKeyContract` 红。
 * 前缀形态 `t('config.' + suffix)` 两头都安全：合并前键不存在（无幽灵、无死键），
 * 合并后 `dynamicKeyPrefixes` 以 `config.` 前缀认领全部 `config.*` 键（无死键）。
 *
 * 代价是拼错不再有幽灵提示，所以用字面量联合类型把拼错挡在**编译期**。
 *
 * ## cycle-83 拆分：形状守卫移到 configGuards.ts
 *
 * 本文件保留「读什么/怎么归一」（词表、值归一化、响应形状的类型声明），
 * 守卫（isConfigJson 等）与三种写响应形状在 configGuards.ts。
 * 渲染层 import 两者，import 方向单一；两个文件都在 250 行内。
 */
import { t } from '../../i18n.ts';
import type { BackupViewJson, PathOverridesJson } from './configGuards.ts';

export type {
  ConfigWriteJson, PathWriteJson, RollbackJson, BackupViewJson, PathOverridesJson,
} from './configGuards.ts';
export {
  isConfigJson,
  isConfigWriteJson,
  isPathWriteJson,
  isRollbackJson,
  isPathOverridesJson,
  isBackupViewJson,
} from './configGuards.ts';

/**
 * 本分区词表键的**短名联合**（编译期防拼错；理由见文件头）。
 */
export type ConfigTextSuffix =
  | 'title' | 'ariaLabel' | 'hint' | 'dirty' | 'dirtyCount'
  | 'save' | 'saving' | 'savedAt' | 'preview' | 'discard' | 'reset' | 'resetOne'
  | 'previewSummary' | 'saveSummary' | 'saveFailed' | 'backupAt'
  | 'pathTitle' | 'pathMeta' | 'pathDir' | 'pathMissing' | 'pathUnresolved'
  | 'pathCopy' | 'pathCopyLabel' | 'pathProbeRejected' | 'pathProbeAccepted'
  // cycle-83：路径行内编辑 + 覆盖表状态（docs/anic/cycle-83-config-i18n.md）
  | 'pathEdit' | 'pathEditSave' | 'pathEditCancel' | 'pathEditReset'
  | 'pathEditHint' | 'pathDefault' | 'pathOverridden' | 'pathEditing' | 'pathNotEditable'
  | 'pathOverridesIgnored' | 'pathOverridesActive' | 'pathOverridesNone'
  | 'pathEditInvalid' | 'pathEditOutside'
  // cycle-83：草稿冲突条（三态：无冲突 / 冲突 / 已撤销）
  | 'conflictTitle' | 'conflictLine' | 'conflictAdopt' | 'conflictKeep'
  | 'conflictDismiss' | 'conflictOriginal'
  // cycle-83：备份下拉与回滚
  | 'backupTitle' | 'backupNone' | 'backupRestore' | 'backupPreviewRestore'
  | 'backupChanged' | 'backupRestoring' | 'backupRestored'
  | 'backupRestoreFailed' | 'backupSafety';

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
 * （cycle-82 实测踩到，Lead 定位）。所以常量**保留导出**（契约测试要断言它被认领），
 * 只是绝不进 `t()` 的实参首位置。
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

/** 与 host/configEdit/pathRegistry.ts 的 PathEntry 逐字段对应。 */
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
  /** 解析结果套用了覆盖表（老宿主缺省 = false）。 */
  overridden?: boolean;
  /** 该路径项是否允许自定义（老宿主缺省 = 不可编辑，fail-closed）。 */
  editable?: boolean;
}

/** GET /anic/api/config 响应。 */
export interface ConfigJson {
  workspace: string;
  values: Record<string, unknown>;
  schema: ConfigFieldJson[];
  paths: { workspace: string; entries: ConfigPathJson[]; warnings: string[]; overridesIgnored?: boolean };
  warnings: string[];
  rawHash: string | null;
  configFile: { exists: boolean; bytes: number; mtime: string | null };
  backups: string[];
  /** 仅当请求带 ?probePath= 时出现。 */
  probe?: { ok: boolean; entry?: ConfigPathJson; reason?: string; code?: string } | null;
  /** cycle-83：覆盖表视图（缺省 = 老宿主，编辑入口按 editableIds 空集处理）。 */
  pathOverrides?: PathOverridesJson;
  /** cycle-83：备份摘要（缺省 = 老宿主，回落到 backups 名字列表）。 */
  backupViews?: BackupViewJson[];
}

/** 配置端点（相对路径——桌面端经 dsh-app 同源代理）。 */
export const CONFIG_URL = '/anic/api/config';
/** cycle-83：路径覆盖表端点。 */
export const CONFIG_PATHS_URL = '/anic/api/config/paths';
/** cycle-83：备份回滚端点。 */
export const CONFIG_ROLLBACK_URL = '/anic/api/config/rollback';

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
