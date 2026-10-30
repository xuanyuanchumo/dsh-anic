/**
 * 配置响应的**形状守卫与写响应类型**（cycle-83：从 configTypes.ts 拆出，T3 ≤250 行）。
 *
 * ## 为什么形状守卫独立成文件
 *
 * 半截响应（路由 500、老宿主没有该端点、字段被裁剪）进渲染器会产生**看起来
 * 正常但内容错乱**的表单——那时用户保存下去的是错值。守卫的作用是让这种响应
 * 整块不渲染（null），而不是渲染出一张"字段都在但值全是空"的假表单。
 *
 * 拆开的实际理由是行数：`configTypes.ts` 同时承载词表键联合、值归一化
 * （`draftToPatchValue` / `valueToDraftText`）与四个响应形状。守卫与形状是
 * **一个整体**（它们逐字段对应），归一化是另一个整体，把它们分开后两端
 * 都在 250 行内，且 import 方向单一（渲染层只依赖本文件与 configTypes）。
 *
 * ## 三个新形状为什么各有一个守卫
 *
 * 写响应有三种语义（改字段 / 改路径 / 改整份），它们的变更单位不同：
 * `changedFields`（字段 id）/ `changedIds`（路径 id）/ `backup`（备份名）。
 * 共用一个守卫会让「字段改了 0 个」与「路径改了 0 条」混成同一件事，
 * 而调用方要据此决定提示哪一句（提示错了比不提示更误导）。
 */
import { isObjectLike } from '../../components/fetchJson.ts';
import type { ConfigFieldJson, ConfigJson, ConfigPathJson } from './configTypes.ts';

export type { ConfigJson } from './configTypes.ts';
export type { ConfigFieldJson, ConfigPathJson } from './configTypes.ts';

/**
 * cycle-83：覆盖表视图（GET 的 `pathOverrides` 字段）。
 *
 * `ignored` 是本形状唯一的**布尔裁决**：true = 整份覆盖表被忽略（fail-closed）。
 * 客户端必须显著提示，否则用户会以为自己设的路径生效了。
 */
export interface PathOverridesJson {
  /** 生效的覆盖：`id → 相对路径`。 */
  active: Record<string, string>;
  /** 可覆盖 id 清单（客户端据此决定是否给编辑按钮）。 */
  editableIds: string[];
  ignored: boolean;
  present: boolean;
  warnings: string[];
}

/** cycle-83：单份备份的可见事实 + 相对当前的字段级差异。 */
export interface BackupViewJson {
  name: string;
  at: string | null;
  bytes: number;
  changedFields: string[];
  values: Record<string, { backup: unknown; current: unknown }>;
}

const GROUPS = ['project', 'commands', 'macro', 'anic'] as const;
const KINDS = ['string', 'command', 'int', 'bool', 'stringArray', 'enum'] as const;

function isField(v: unknown): v is ConfigFieldJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['labelKey'] !== 'string') return false;
  if (!GROUPS.includes(o['group'] as (typeof GROUPS)[number])) return false;
  if (!KINDS.includes(o['kind'] as (typeof KINDS)[number])) return false;
  if (typeof o['maxLength'] !== 'number') return false;
  if (o['enumValues'] !== null && !Array.isArray(o['enumValues'])) return false;
  return true;
}

/**
 * 路径项守卫。
 *
 * cycle-83 的 `overridden`/`editable` 是**可选**字段：老宿主不返回它们，
 * 缺省按「默认解析、不可编辑」处理（fail-closed —— 不给编辑入口总比给一个
 * 点了没反应的入口好）。所以它们不参与采信条件。
 */
function isPathEntry(v: unknown): v is ConfigPathJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['labelKey'] !== 'string') return false;
  if (o['kind'] !== 'dir' && o['kind'] !== 'file') return false;
  if (typeof o['exists'] !== 'boolean' || typeof o['isDir'] !== 'boolean') return false;
  if (typeof o['bytes'] !== 'number') return false;
  if (o['path'] !== null && typeof o['path'] !== 'string') return false;
  return true;
}

/** 覆盖表视图守卫（缺省字段按空处理——老宿主没有它就是「没有覆盖」）。 */
export function isPathOverridesJson(v: unknown): v is PathOverridesJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return isObjectLike(o['active']) && Array.isArray(o['editableIds']) && typeof o['ignored'] === 'boolean';
}

/** 备份摘要守卫（缺省时不采信，回落到 `backups: string[]` 名字列表）。 */
export function isBackupViewJson(v: unknown): v is BackupViewJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['name'] === 'string' && Array.isArray(o['changedFields']);
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
  if (typeof o['workspace'] !== 'string') return false;
  if (!isObjectLike(o['values'])) return false;
  if (!Array.isArray(o['schema']) || o['schema'].length === 0) return false;
  if (!o['schema'].every(isField)) return false;
  if (!isObjectLike(o['paths'])) return false;
  const paths = o['paths'] as Record<string, unknown>;
  if (!Array.isArray(paths['entries']) || !paths['entries'].every(isPathEntry)) return false;
  if (!Array.isArray(o['warnings'])) return false;
  if (!isObjectLike(o['configFile'])) return false;
  return true;
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

/** 写入响应的形状守卫（ok 必须有，其余字段按需透传）。 */
export function isConfigWriteJson(v: unknown): v is ConfigWriteJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['ok'] === 'boolean' && Array.isArray(o['changedFields']) && Array.isArray(o['warnings']);
}

/**
 * 路径覆盖写入响应（cycle-83）。
 *
 * 变更单位是 `changedIds`/`removedIds`（路径 id），不是 `changedFields`。
 */
export interface PathWriteJson {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  error: string;
  changedIds: string[];
  removedIds: string[];
  warnings: string[];
  /** 真写后的完整覆盖表（dryRun 时看 `next`）。 */
  overrides?: Record<string, string>;
  next?: Record<string, string>;
  paths?: ConfigJson['paths'];
}

export function isPathWriteJson(v: unknown): v is PathWriteJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['ok'] === 'boolean' && Array.isArray(o['changedIds']) && Array.isArray(o['removedIds']);
}

/** 回滚写入响应（cycle-83）：带安全备份路径与刷新后的备份清单。 */
export interface RollbackJson {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  error: string;
  backup: string;
  changedFields: string[];
  warnings: string[];
  /** 回滚**前**的当前态落在哪（用户据此能回滚回去）。 */
  safetyBackupPath?: string | null;
  beforeHash?: string;
  afterHash?: string;
  backups?: BackupViewJson[];
  diff?: Array<{ kind: 'same' | 'add' | 'remove'; text: string; beforeLine: number | null; afterLine: number | null }>;
  stats?: { changed: number; added: number; removed: number };
}

export function isRollbackJson(v: unknown): v is RollbackJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['ok'] === 'boolean' && typeof o['backup'] === 'string' && Array.isArray(o['changedFields']);
}
