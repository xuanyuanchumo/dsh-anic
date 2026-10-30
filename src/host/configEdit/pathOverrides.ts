/**
 * 路径覆盖表（cycle-83）——`.cycles/paths.json` 的读、整份校验与原子写。
 *
 * ## 两层：登记表是真相，覆盖表只是「这次把它们放哪」
 *
 * 覆盖表**不改登记表**（见 pathRegistry 文件头：改了覆盖表就分不清「这条路径本来
 * 存在吗」）。所以这里的产物只有两样：一个 `<id> → 绝对路径` 的解析映射，
 * 以及一份 warnings。`collectPaths()` 用它做第二层，默认值仍在。
 *
 * ## fail-closed 到默认：任何一条非法 ⇒ 整份忽略
 *
 * 这是本文件最重要的裁决。半套生效比没有更危险：用户改了 A 与 B，其中 B
 * 写错了，若只忽略 B，用户看到 A 生效、以为一切都按他说的生效了，而 B 仍是
 * 默认——两个字段指向同一批文档时，后果是文档分裂。所以校验是**全有或全无**，
 * 并且每一条非法都进 warnings（不是「非法」两个字，是「哪条、为什么」）。
 *
 * 单条判据在 `pathOverrideRules.ts`（拆出理由：契约测试要直接喂它做反向自检）。
 *
 * ## 撤销一条 = patch 里传 null
 *
 * `null` 的语义是「回默认」而不是「写一个 null 值」。用 null 而不是空串，
 * 是因为空串在 JSON 里等于「有这条但没内容」，会与「没有这条」混淆。
 *
 * ## 写入是整份替换 + 原子写
 *
 * 覆盖表是本文件独占的 JSON（不是共享 YAML，无需行级手术），所以
 * 「读旧表 → 合并 patch → 整份校验 → 原子写 → 回读断言」就是最小动作。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { createScoped } from '../logger.ts';
import { overridablePathIds } from './pathRegistry.ts';
import { validateOverride } from './pathOverrideRules.ts';

const log = createScoped('anic:path-overrides');

export const PATHS_FILE_REL = '.cycles/paths.json';
export const PATHS_VERSION = 1;

export type { OverrideAccepted, OverrideReject, OverrideRejectCode } from './pathOverrideRules.ts';
export { validateOverride, protectedPaths, hasDotDot, normalizeRel } from './pathOverrideRules.ts';

/** 覆盖表文件（工作区绝对路径）。 */
export function pathsFilePath(root: string): string {
  return join(resolve(root), ...PATHS_FILE_REL.split('/'));
}

/** 可覆盖 id 清单（客户端与校验层共用，避免两处各自抄一份白名单）。 */
export const EDITABLE_PATH_IDS: readonly string[] = overridablePathIds();

/** 覆盖解析结果：映射 + warnings + 「是否整份被忽略」。 */
export interface PathResolveResult {
  /** 生效的覆盖（`id → {rel, abs}`）；整份非法时为空对象。 */
  overrides: Record<string, { rel: string; abs: string }>;
  warnings: string[];
  /** true = 覆盖表**整份**被忽略（fail-closed 信号，客户端据此着色）。 */
  ignored: boolean;
  /** 表文件是否存在（不存在是正常态，不是警告）。 */
  present: boolean;
}

const EMPTY = (warnings: string[], ignored: boolean, present: boolean): PathResolveResult =>
  ({ overrides: {}, warnings, ignored, present });

/**
 * 读 + 校验整份表（**全有或全无**）。
 *
 * 「哪种坏」也要分开说：解析失败 / 不是对象 / version 不符 / overrides 不是对象
 * 各有独立文案——只说「覆盖表坏了」等于让用户自己猜哪一步错的。
 */
export function loadPathOverrides(root: string): PathResolveResult {
  const file = pathsFilePath(root);
  if (!existsSync(file)) return EMPTY([], false, false);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    return EMPTY([`.cycles/paths.json 无法解析（整份忽略，解析回落到默认）：${e instanceof Error ? e.message : String(e)}`], true, true);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return EMPTY(['.cycles/paths.json 不是对象（整份忽略，解析回落到默认）'], true, true);
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== PATHS_VERSION) {
    return EMPTY([`.cycles/paths.json 的 version 不是 ${String(PATHS_VERSION)}（整份忽略，解析回落到默认）`], true, true);
  }
  const table = obj['overrides'];
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return EMPTY(['.cycles/paths.json 的 overrides 不是对象（整份忽略，解析回落到默认）'], true, true);
  }
  const entries = Object.entries(table as Record<string, unknown>);
  if (entries.length === 0) return EMPTY([], false, true);

  // 两遍：先归一候选（碰撞判定要看全部），再逐条校验；任何一条失败 ⇒ 整份忽略。
  const candidates: Record<string, string> = {};
  for (const [id, v] of entries) if (typeof v === 'string') candidates[id] = v;
  const accepted: Record<string, { rel: string; abs: string }> = {};
  const warnings: string[] = [];
  for (const [id, v] of entries) {
    const r = validateOverride(root, id, v, candidates);
    if (!r.ok) { warnings.push(`${r.code}: ${r.reason}`); continue; }
    accepted[id] = { rel: r.rel, abs: r.abs };
  }
  if (warnings.length > 0) {
    log.warn(`path overrides ignored (${warnings.length} invalid): ${warnings.join(' | ')}`);
    return { overrides: {}, warnings: warnings.map((w) => `整份覆盖表被忽略：${w}`), ignored: true, present: true };
  }
  return { overrides: accepted, warnings: [], ignored: false, present: true };
}

/** 覆盖表里当前生效的条目数（供 GET 展示「覆盖了 N 项」）。 */
export function overriddenCount(r: PathResolveResult): number {
  return Object.keys(r.overrides).length;
}

/**
 * 覆盖表的 patch 计划（dryRun 与真写共用——同 config 的裁决）。
 *
 * patch 形状 `{<pathId>: <相对路径>|null}`：`null` = 撤销覆盖（回默认）。
 * 只校验 patch 涉及项 + 未触及的既有项；任何一条失败 ⇒ `ok=false` 且**零写入**。
 */
export interface PathPlan {
  ok: boolean;
  /** 生效后的完整覆盖表（ok=true 时才有意义）。 */
  next: Record<string, string>;
  changedIds: string[];
  removedIds: string[];
  warnings: string[];
  error: string;
}

export function planPathOverrides(root: string, patch: Record<string, unknown>): PathPlan {
  const current = loadPathOverrides(root);
  const next: Record<string, string> = {};
  // 既有覆盖先落表：**未触及项原样保留**（一次只改一条不该顺带清掉别人）。
  for (const [id, v] of Object.entries(current.overrides)) next[id] = v.rel;
  const changedIds: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const [id, raw] of Object.entries(patch)) {
    const before = next[id];
    if (raw === null) {
      if (before === undefined) continue;
      delete next[id];
      removed.push(id);
      continue;
    }
    const r = validateOverride(root, id, raw, next);
    if (!r.ok) { warnings.push(`${r.code}: ${r.reason}`); continue; }
    if (before !== r.rel) changedIds.push(id);
    next[id] = r.rel;
  }
  if (warnings.length > 0) {
    return { ok: false, next: {}, changedIds: [], removedIds: [], warnings, error: 'path override rejected (no write)' };
  }
  // 组合校验：改完之后的表必须整体仍然合法（两条指向同一处 = 谁写的不可判定）。
  for (const [id, rel] of Object.entries(next)) {
    const r = validateOverride(root, id, rel, next);
    if (!r.ok) {
      return { ok: false, next: {}, changedIds: [], removedIds: [], warnings: [`${r.code}: ${r.reason}`], error: 'path override rejected (no write)' };
    }
  }
  return { ok: true, next, changedIds, removedIds: removed.filter((id) => !(id in next)), warnings: [], error: '' };
}

export interface PathWriteOutcome {
  ok: boolean;
  applied: boolean;
  changedIds: string[];
  removedIds: string[];
  warnings: string[];
  /** 写入后的覆盖表（回读确认过——与 config 的 Post-Verify 同款纪律）。 */
  overrides: Record<string, string>;
  error: string;
}

/**
 * 应用覆盖 patch：校验 → 原子写 `.cycles/paths.json` → **回读断言**。
 *
 * 回读不是装饰：写失败（磁盘满/权限）时若直接声称「已改」，用户下次打开面板
 * 会发现设置没了却不知道哪一步丢的。回读失败即如实报错（表若被写坏则整份
 * 忽略，解析仍回落到默认——fail-closed 的兜底）。
 */
export function applyPathOverrides(root: string, patch: Record<string, unknown>): PathWriteOutcome {
  const plan = planPathOverrides(root, patch);
  const base = { changedIds: [] as string[], removedIds: [] as string[], warnings: plan.warnings };
  if (!plan.ok) return { ok: false, applied: false, ...base, overrides: {}, error: plan.error };
  if (plan.changedIds.length === 0 && plan.removedIds.length === 0) {
    return { ok: true, applied: false, ...base, overrides: plan.next, error: '' };
  }
  const body = `${JSON.stringify({ version: PATHS_VERSION, overrides: plan.next }, null, 2)}\n`;
  try {
    atomicWriteFileSync(pathsFilePath(root), body);
  } catch (e) {
    return { ok: false, applied: false, ...base, overrides: {}, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const back = loadPathOverrides(root);
  if (back.ignored) {
    // 自己写的表被自己判非法 = 写入内容有 bug，必须响亮（而不是静默回落到默认）。
    log.error(`path overrides written but rejected on re-read: ${back.warnings.join(' | ')}`);
    return { ok: false, applied: true, changedIds: plan.changedIds, removedIds: plan.removedIds, warnings: back.warnings, overrides: {}, error: 're-read rejected the table we just wrote' };
  }
  const got: Record<string, string> = {};
  for (const [id, v] of Object.entries(back.overrides)) got[id] = v.rel;
  for (const id of Object.keys(plan.next)) {
    if (got[id] !== plan.next[id]) {
      return { ok: false, applied: true, changedIds: plan.changedIds, removedIds: plan.removedIds, warnings: [], overrides: got, error: `re-read mismatch on ${id}: got ${String(got[id])} want ${plan.next[id]}` };
    }
  }
  log.info(`path overrides applied: changed=${plan.changedIds.join(',')} removed=${plan.removedIds.join(',')}`);
  return { ok: true, applied: true, changedIds: plan.changedIds, removedIds: plan.removedIds, warnings: [], overrides: got, error: '' };
}
