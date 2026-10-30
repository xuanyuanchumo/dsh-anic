/**
 * 插件路径表（cycle-82 路径可视化；cycle-83 接覆盖表）。
 *
 * ## 为什么这件事必须做（用户原话点名）
 *
 * 「配置/路径支持自定义可视化编辑等」——`.cycles` 各文档的生命周期此前只在
 * CLI/SKILL.md 里描述，用户无法回答「我的账本到底写到哪个文件、技能装在哪、
 * dist 在哪」。路径表把这条链**显式化**，每项带 exists/bytes/mtime，
 * 让「说存在」变成「读到证据才算存在」。
 *
 * ## 两层：默认（登记表） + 覆盖（`.cycles/paths.json`）
 *
 * 登记表在 `pathRegistry.ts`（**唯一真相源**），覆盖表在 `pathOverrides.ts`。
 * 本文件只做合并：默认值 + 覆盖 → 解析结果。合并规则只有一条——
 * **覆盖里有合法条目就用它，整份非法就整份回默认**（fail-closed，理由见
 * pathOverrides 文件头：半套生效比没有更危险）。
 *
 * ## 安全边界（这是路径可视化，不是任意文件浏览器）
 *
 * 自定义路径只接受「不含 `..`、realpath 后仍包含在 workspace 内、且自身存在」的
 * 路径，否则**拒绝并说明原因**。把任意路径读出来做成接口，等于给插件开一个
 * 任意文件读取入口——那不是本诉求要的东西。
 *
 * ## 一套推导，不留第二份
 *
 * 判据 `isInside` 直接**委托** `closureAudit/isolationScan.inWorkspace`
 * （`relative()` 而非 `startsWith()`：后者会把 `/a/proj-evil` 判成在 `/a/proj` 内）。
 * 本文件不写第二份 realpath/前缀判据——两份判据漂移是这类安全面的经典失守形态。
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { inWorkspace } from '../closureAudit/isolationScan.ts';
import {
  buildPathContext,
  defaultPathOf,
  overridablePathIds,
  PATH_DEFS,
  pathLabel,
  probeEntry,
  type PathEntry,
  type PathTable,
} from './pathRegistry.ts';
import { loadPathOverrides, type PathResolveResult } from './pathOverrides.ts';

export type { PathEntry, PathTable, PathKind, PathDef } from './pathRegistry.ts';
export {
  PATH_DEFS,
  overridablePathIds,
  pathDefById,
  buildPathContext,
  defaultPathOf,
} from './pathRegistry.ts';
export type { PathResolveResult } from './pathOverrides.ts';
export { loadPathOverrides } from './pathOverrides.ts';

/**
 * `child` 是否等于 `parent` 或位于其下（按路径段比较）。
 *
 * **委托** isolationScan.inWorkspace，不在这里重写——两份判据一旦漂移，
 * 「路径表说是界内」与「隔离守卫说是越界」会同时成立，而用户只看到前者。
 */
export function isInside(parent: string, child: string): boolean {
  return inWorkspace(parent, child);
}

/**
 * 构建路径表（默认 + 覆盖两层）。
 *
 * 顺序即重要性：工作区 → .cycles 契约文件 → 生命周期目录 → 技能 → 插件。
 * 客户端按此顺序渲染，用户从上往下读就是「我的项目长什么样」。
 *
 * warnings 里既有推导告警（plugin root 找不到）也有覆盖告警（整份被忽略），
 * 两者都是「表里这个值为什么不是你期望的」——不区分来源就等于没解释。
 */
export function collectPaths(workspaceRoot: string, resolved?: PathResolveResult): PathTable {
  const ctx = buildPathContext(workspaceRoot);
  const overrides = resolved ?? loadPathOverrides(ctx.root);
  const warnings: string[] = [];
  if (ctx.pluginRoot === null) warnings.push('plugin root not resolvable (package.json with name=dsh-anic not found upward)');
  warnings.push(...overrides.warnings);
  if (overrides.present && overrides.ignored) {
    warnings.push('覆盖表整份被忽略：解析一律回落到登记表的默认路径（不做半套生效）');
  }

  const entries: PathEntry[] = PATH_DEFS.map((def) => {
    const ov = overrides.overrides[def.id];
    if (ov !== undefined) return probeEntry(def, ctx, { path: ov.abs, overridden: true });
    return probeEntry(def, ctx, { path: defaultPathOf(def, ctx), overridden: false });
  });

  return { workspace: ctx.root, entries, warnings, overridesIgnored: overrides.ignored };
}

/** 生效的覆盖（`id → 相对路径`）——客户端据此显示「默认 / 自定义」。 */
export function activeOverrides(resolved: PathResolveResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(resolved.overrides)) out[id] = v.rel;
  return out;
}

/** 可覆盖 id 的稳定顺序（客户端逐项渲染编辑入口；顺序 = 登记表顺序）。 */
export const EDITABLE_PATH_IDS: readonly string[] = overridablePathIds();

export type PathRequestResult =
  | { ok: true; entry: PathEntry }
  | { ok: false; reason: string; code: PathRejectCode };

export type PathRejectCode =
  | 'PATH_EMPTY'
  | 'PATH_TRAVERSAL'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND';

/** realpath 容错：不存在的路径返回 null（后面的 NOT_FOUND 分支会给出更好的原因）。 */
function safeRealpath(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

/**
 * 校验一个**自定义**路径请求（相对 workspace 或绝对，但必须落在其内）。
 *
 * 拒绝优先级即诊断顺序：空 → 含 `..` → 在 workspace 外 → 不存在。
 * 每一档都返回可读原因，用户看到的是「为什么不给你这个路径」，
 * 而不是一句「非法」。
 */
export function resolveCustomPath(workspaceRoot: string, raw: unknown): PathRequestResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'PATH_EMPTY', reason: '路径为空' };
  }
  const req = raw.trim();
  // `..` 一律拒绝，即使 realpath 之后恰好还在界内——因为 `/ws/sub/../../etc` 这类
  // 形状经符号链接/大小写重定向后是否仍在界内取决于平台细节，不做这个赌博。
  if (/(^|[/\\])\.\.([/\\]|$)/.test(req)) {
    return { ok: false, code: 'PATH_TRAVERSAL', reason: '路径包含 .. 段（不做越界赌博）' };
  }
  const abs = resolve(workspaceRoot, req);
  if (!isInside(workspaceRoot, abs)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: '路径落在工作区之外（这里只做工作区可视化）' };
  }
  const realWs = safeRealpath(workspaceRoot) ?? resolve(workspaceRoot);
  const real = safeRealpath(abs);
  if (real === null) {
    return { ok: false, code: 'PATH_NOT_FOUND', reason: '路径不存在（realpath 失败）' };
  }
  // realpath 之后再判一次：符号链接可以把界内路径指到界外，这一档是真正的边界。
  if (!isInside(realWs, real)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: '路径经符号链接解析后落在工作区之外' };
  }
  const ctx = buildPathContext(workspaceRoot);
  const custom = {
    id: 'custom', suffix: 'path.custom', kind: 'file' as const,
    source: '自定义请求路径（已通过 realpath 边界校验）',
  };
  return { ok: true, entry: probeEntry(custom, ctx, { path: real, overridden: false }) };
}

/** 词表键构造（客户端自定义路径行复用同一前缀规则）。 */
export { pathLabel };
