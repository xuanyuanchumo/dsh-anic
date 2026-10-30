/**
 * 路径覆盖的**校验判据**（cycle-83：从 pathOverrides.ts 拆出，T3 ≤250 行）。
 *
 * ## 四条判据（与 isolationScan.inWorkspace 同源，不写第二份 realpath 判据）
 *
 * ① 相对 workspace 根（绝对路径直接拒：跨机器复用必错）；
 * ② 不含 `..` 段（`/ws/sub/../../etc` 这类形状经符号链接/大小写重定向后
 *    是否还在界内取决于平台细节，不做这个赌博）；
 * ③ realpath 后仍在 workspace 内（符号链接可以把界内路径指到界外——真正的边界）；
 * ④ 目标是该登记项语义上的形态（`dir` 项必须真的是目录）。
 *
 * 判据本身**委托** `closureAudit/isolationScan.inWorkspace`（`relative()` 而非
 * `startsWith()`：后者会把 `/a/proj-evil` 判成在 `/a/proj` 内——前缀碰撞）。
 * 拆出本文件的理由不是行数，而是**可测性**：契约测试要能直接喂一条 workspace 外的
 * 绝对路径看它是否被点名（反向自检），藏在编排函数里的判据写不出这种断言。
 *
 * ## 拒绝优先级即诊断顺序
 *
 * id 不可覆盖 → 空 → 绝对 → 含 `..` → 界外 → 不存在 → 形态不符 → 碰撞。
 * 每一档返回可读原因，用户看到的是「为什么不给你这条」，而不是一句「非法」。
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { inWorkspace } from '../closureAudit/isolationScan.ts';
import { buildPathContext, defaultPathOf, PATH_DEFS, pathDefById, type PathContext } from './pathRegistry.ts';

export type OverrideRejectCode =
  | 'PATH_EMPTY'
  | 'PATH_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'PATH_KIND_MISMATCH'
  | 'PATH_COLLISION'
  | 'ID_NOT_EDITABLE';

export interface OverrideReject {
  ok: false;
  code: OverrideRejectCode;
  reason: string;
}

export interface OverrideAccepted {
  ok: true;
  /** 归一后的相对路径（`/` 分隔，进 JSON 的就是它）。 */
  rel: string;
  /** 解析后的绝对路径。 */
  abs: string;
}

/** 含 `..` 段判定（先拒字面量，再看解析结果：脆弱写法 = 未来的事故）。 */
export function hasDotDot(rel: string): boolean {
  return rel.split(/[\\/]/).includes('..');
}

/** 相对路径归一（`\` → `/`、去掉 `./` 前缀与尾部斜杠；不做 resolve）。 */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/**
 * 不可覆盖项的默认解析结果（受保护集合）。
 *
 * 覆盖成这些位置等于与契约抢位置：`config.yml` 被两个登记项指到同一处时，
 * 任何读方都无法判定「我读到的是配置还是别的」。用默认解析结果而不是硬编码
 * 字面量，是因为 pluginRoot/dist 那几项的位置本来就是解析出来的。
 */
export function protectedPaths(ctx: PathContext): Set<string> {
  const set = new Set<string>();
  for (const def of PATH_DEFS) {
    if (def.overridable === true) continue;
    const p = defaultPathOf(def, ctx);
    if (p !== null) set.add(p);
  }
  return set;
}

/**
 * realpath + stat 一次拿到（不存在/无权限 → null）。
 *
 * 用 `fs.realpathSync`/`statSync` 而非自造：平台语义（大小写、短名、链接）
 * 只有它们知道。两查之间有 TOCTOU 窗口，但后果只是「判为不存在」——
 * fail-closed 到默认，可接受。
 */
function statSafe(p: string): { real: string; isDir: boolean } | null {
  try {
    const real = realpathSync(p);
    return { real, isDir: statSync(real).isDirectory() };
  } catch {
    return null;
  }
}

/**
 * 校验**单条**覆盖。`siblings` 是同一份表里其它项的候选相对路径（碰撞判定用）。
 *
 * `siblings` 为什么是相对路径而不是绝对：调用方手里只有表内容（相对），
 * 在这里统一 resolve 才能与目标比较——两边各 resolve 一次比让调用方猜更稳。
 */
export function validateOverride(
  root: string,
  id: string,
  raw: unknown,
  siblings: Record<string, string> = {},
): OverrideAccepted | OverrideReject {
  const def = pathDefById(id);
  if (def === undefined || def.overridable !== true) {
    return { ok: false, code: 'ID_NOT_EDITABLE', reason: `${id}: 该项不可编辑（只有生命周期目录可自定义，契约文件与插件解析项不开放）` };
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'PATH_EMPTY', reason: `${id}: 路径为空` };
  }
  const req0 = raw.trim();
  if (isAbsolute(req0)) {
    return { ok: false, code: 'PATH_ABSOLUTE', reason: `${id}: 必须写工作区相对路径（绝对路径跨机器复用必错）` };
  }
  if (hasDotDot(req0)) {
    return { ok: false, code: 'PATH_TRAVERSAL', reason: `${id}: 路径包含 .. 段（不做越界赌博）` };
  }
  const ctx = buildPathContext(root);
  const abs = resolve(ctx.root, normalizeRel(req0));
  if (!inWorkspace(ctx.root, abs)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: `${id}: 路径落在工作区之外（这里只做工作区可视化）` };
  }
  // realpath 判据：字面量在界内，但符号链接可能把界内路径指到界外。
  const real = statSafe(abs);
  if (real === null) {
    return { ok: false, code: 'PATH_NOT_FOUND', reason: `${id}: 目标不存在（先创建目录再改这里）` };
  }
  if (!inWorkspace(ctx.root, real.real)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: `${id}: 路径经符号链接解析后落在工作区之外` };
  }
  if ((def.kind === 'dir' && !real.isDir) || (def.kind === 'file' && real.isDir)) {
    return { ok: false, code: 'PATH_KIND_MISMATCH', reason: `${id}: 该路径项语义是 ${def.kind}，但目标形态不符` };
  }
  if (protectedPaths(ctx).has(real.real)) {
    return { ok: false, code: 'PATH_COLLISION', reason: `${id}: 目标已是某项不可覆盖的固定路径（覆盖它等于与契约抢位置）` };
  }
  for (const [otherId, otherRel] of Object.entries(siblings)) {
    if (otherId === id) continue;
    if (resolve(ctx.root, otherRel) === abs) {
      return { ok: false, code: 'PATH_COLLISION', reason: `${id}: 与 ${otherId} 指向同一路径（两条登记项共用一个位置会让「谁写的」不可判定）` };
    }
  }
  return { ok: true, rel: relative(ctx.root, abs).split(sep).join('/'), abs };
}
