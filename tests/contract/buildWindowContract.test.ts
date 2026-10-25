/**
 * F-09 build 删除窗口契约守卫（cycle-77 T3，台账 §9）。
 *
 * 被守卫缺陷（2026-10-23 真实事故）：`scripts/build-client.mjs` 非 watch 路径先
 * `rmSync(distDir)` 再跑 tsdown —— 构建失败时**宿主运行时目录 dist/ 整体消失**，
 * 插件即刻失能。守卫方式（解析**函数体 + 语句顺序**，不做整文件位置猜测）：
 *  1. 词法感知拆出 `if (watchMode) {…} else {…}`（注释/字符串/模板插值内的括号不配对）；
 *  2. 非 watch 路径**不得**出现 dist/ 整体删除（watch 分支的删除是登记遗留，锁其存在）；
 *  3. 非 watch 实现体顺序：client 构建 → host 构建 → 失败出口 → 原子替换 → 清理；
 *  4. **反向自检**：旧写法必须判红、合规源码必须判绿、扫描面不可定位也判红
 *     （恒红/恒绿都是假守卫）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUILD = join(__dirname, '..', '..', 'scripts', 'build-client.mjs');

/* ── 词法感知源码原语（注释/字符串内的括号不参与配对） ── */

function skipString(src: string, start: number): number {
  const q = src[start];
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === q) return i;
    if (q === '`' && c === '$' && src[i + 1] === '{') {
      const end = matchBrace(src, i + 1);
      if (end < 0) return src.length;
      i = end;
    }
  }
  return src.length;
}

function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 去掉注释（保留字符串字面量；注释里的 rmSync 不算真删除）。 */
export function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const end = skipString(src, i); out += src.slice(i, end + 1); i = end + 1; continue; }
    out += c; i++;
  }
  return out;
}

export interface ModeBranches { watch: string; other: string; watchSpan: [number, number] }

/** 拆出 `if (watchMode) {…}` 与 `else {…}` 两个分支体；结构不匹配 → null。 */
export function extractModeBranches(raw: string): ModeBranches | null {
  const s = stripComments(raw);
  const at = s.indexOf('if (watchMode)');
  if (at < 0) return null;
  const watchOpen = s.indexOf('{', at);
  const watchClose = watchOpen < 0 ? -1 : matchBrace(s, watchOpen);
  if (watchOpen < 0 || watchClose < 0) return null;
  const m = s.slice(watchClose + 1).match(/^\s*else\s*\{/);
  if (!m) return null;
  const otherOpen = watchClose + 1 + (m[0].length - 1);
  const otherClose = matchBrace(s, otherOpen);
  if (otherClose < 0) return null;
  return { watch: s.slice(watchOpen + 1, watchClose), other: s.slice(otherOpen + 1, otherClose), watchSpan: [watchOpen, watchClose] };
}

/** 取具名函数体（不含 function 头与花括号）；找不到 → null。 */
export function extractFunctionBody(raw: string, name: string): string | null {
  const s = stripComments(raw);
  const at = s.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const open = s.indexOf('{', at);
  const close = open < 0 ? -1 : matchBrace(s, open);
  if (open < 0 || close < 0) return null;
  return s.slice(open + 1, close);
}

/** 第 name 的第 1 个**调用点**（跳过 function 定义处）；无 → -1。 */
function callIndex(src: string, name: string): number {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 24), m.index))) continue;
    return m.index;
  }
  return -1;
}

const DIST_DELETE_RE = /rmSync\(\s*(?:distDir|join\(\s*pluginDir\s*,\s*['"]dist['"]\s*\))/g;

/** 非 watch 路径（watch 分支之外）的 dist/ 整体删除次数。 */
export function distDeletesOutsideWatch(raw: string): number {
  const s = stripComments(raw);
  const b = extractModeBranches(s);
  if (!b) return Number.POSITIVE_INFINITY; // 定位不了扫描面 = 假守卫，按最坏计
  const outside = s.slice(0, b.watchSpan[0]) + s.slice(b.watchSpan[1] + 1);
  return (outside.match(DIST_DELETE_RE) ?? []).length;
}

export interface BuildWindowVerdict {
  ok: boolean;
  violations: string[];
  order: { client: number; host: number; exit: number; promote: number; cleanup: number };
}

/** 核心判定：非 watch 构建路径的「先构建后替换」顺序 + 零 dist 删除。 */
export function analyzeBuildWindow(raw: string): BuildWindowVerdict {
  const violations: string[] = [];
  const order = { client: -1, host: -1, exit: -1, promote: -1, cleanup: -1 };
  const s = stripComments(raw);
  const b = extractModeBranches(s);
  if (!b) return { ok: false, violations: ['扫描面失效：找不到 if (watchMode) {…} else {…}（守卫必须能定位被守卫路径）'], order };

  const deletes = distDeletesOutsideWatch(s);
  if (deletes !== 0) violations.push(`非 watch 路径出现 dist/ 整体删除 ×${deletes}：F-09 删除窗口回归（构建失败 ⇒ 宿主失能）`);
  if (!/rmSync\(\s*distDir/.test(b.watch)) violations.push('watch 分支缺少 rmSync(distDir)：契约假设失效（watch 行为已变，须同步本守卫）');

  const body = extractFunctionBody(s, 'runNonWatchBuild');
  if (body === null) {
    violations.push('找不到非 watch 构建实现 runNonWatchBuild（结构变更 ⇒ 本守卫失效，必须同步）');
    return { ok: violations.length === 0, violations, order };
  }
  order.client = callIndex(body, 'buildClientStaged');
  order.host = callIndex(body, 'buildHostStaged');
  order.exit = body.indexOf('process.exit');
  order.promote = callIndex(body, 'promoteStaged');
  order.cleanup = body.indexOf('rmSync(cjsDir');

  if (order.client < 0) violations.push('缺少 staging client 构建调用（buildClientStaged）');
  if (order.host < 0) violations.push('缺少 staging host 构建调用（buildHostStaged）');
  if (order.exit < 0) violations.push('缺少失败出口（process.exit）：构建失败必须显式退出且不碰 dist/');
  if (order.promote < 0) violations.push('缺少原子替换调用（promoteStaged）：产物如何进入 dist/ 不可判定');
  const pair = (a: number, bIdx: number): boolean => a >= 0 && bIdx >= 0;
  if (pair(order.client, order.promote) && order.client > order.promote) violations.push('顺序违例：client 构建在原子替换之后');
  if (pair(order.host, order.promote) && order.host > order.promote) violations.push('顺序违例：host 构建在原子替换之后');
  if (pair(order.exit, order.promote) && order.exit > order.promote) violations.push('顺序违例：失败出口在原子替换之后（失败也会动 dist/）');
  if (pair(order.cleanup, order.promote) && order.cleanup < order.promote) violations.push('破坏性清理（rmSync(cjsDir)）出现在构建成功路径之前');
  if ((body.match(DIST_DELETE_RE) ?? []).length > 0) violations.push('非 watch 构建实现内部整体删除 dist/：删除窗口回归');
  return { ok: violations.length === 0, violations, order };
}

const LEGACY_SRC = `const watchMode = process.argv.includes('--watch');
if (watchMode) {
  rmSync(distDir, { recursive: true, force: true });
  spawn(findTsdown(), [...CLIENT_ARGS, '--watch']);
} else {
  rmSync(distDir, { recursive: true, force: true });
  run(CLIENT_ARGS);
  if (!wrapOnce()) process.exit(1);
  buildHost();
}
`;

const PROMOTE_FIRST_SRC = `if (watchMode) { rmSync(distDir, { recursive: true, force: true }); }
else { runNonWatchBuild(); }
function runNonWatchBuild() {
  promoteStaged(join(STAGE, 'client.js'), join(STAGE, 'host.js'));
  const c = buildClientStaged();
  const h = buildHostStaged();
  process.exit(1);
}
`;

const COMPLIANT_SRC = `if (watchMode) { rmSync(distDir, { recursive: true, force: true }); }
else { runNonWatchBuild(); }
function buildClientStaged() { return null; }
function buildHostStaged() { return null; }
function promoteStaged(a, b) { renameSync(a, b); }
function runNonWatchBuild() {
  rmSync(stageDir, { recursive: true, force: true });
  const c = buildClientStaged();
  const h = buildHostStaged();
  if (!c || !h) { rmSync(stageDir, { recursive: true, force: true }); console.error('failed'); process.exit(1); }
  promoteStaged(c, h);
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(cjsDir, { recursive: true, force: true });
  console.log('done');
}
`;

describe('F-09 build 删除窗口静态守卫（scripts/build-client.mjs）', () => {
  const real = readFileSync(BUILD, 'utf-8');
  it('扫描集下限 + 零删除：源码可定位、两分支与实现函数齐备，且非 watch 路径零 dist/ 整体删除', () => {
    expect(real.length).toBeGreaterThan(1000);
    const b = extractModeBranches(real);
    expect(b).not.toBeNull();
    expect(b?.watch.length).toBeGreaterThan(0);
    expect(b?.other.length).toBeGreaterThan(0);
    expect(extractFunctionBody(real, 'runNonWatchBuild')).not.toBeNull();
    // 空集恒绿是假守卫 ⇒ 扫描面必须真实非空后，才断言删除窗口已消除
    expect(distDeletesOutsideWatch(real)).toBe(0);
  });

  it('真实源码：语句顺序 = 构建 → 失败出口 → 原子替换 → 清理 判定为绿', () => {
    const v = analyzeBuildWindow(real);
    expect(v.violations, v.violations.join('; ')).toEqual([]);
    expect(v.ok).toBe(true);
    // 顺序显式断言（不只看 ok 位：位置关系本身就是契约）
    expect(v.order.client).toBeGreaterThanOrEqual(0);
    expect(v.order.host).toBeGreaterThanOrEqual(0);
    expect(v.order.exit).toBeGreaterThan(v.order.client);
    expect(v.order.exit).toBeLessThan(v.order.promote);
    expect(v.order.promote).toBeLessThan(v.order.cleanup);
  });

  it('反向自检 A：旧写法（先 rmSync(distDir) 再 run）必须判红', () => {
    const v = analyzeBuildWindow(LEGACY_SRC);
    expect(v.ok).toBe(false);
    expect(v.violations.join('; ')).toContain('dist/ 整体删除');
    expect(distDeletesOutsideWatch(LEGACY_SRC)).toBe(1);
  });

  it('反向自检 B/C：替换先于构建、失败出口在替换之后、扫描面不可定位 都必须判红', () => {
    const v = analyzeBuildWindow(PROMOTE_FIRST_SRC);
    expect(v.ok).toBe(false);
    const joined = v.violations.join('; ');
    expect(joined).toContain('顺序违例');
    expect(joined).toContain('失败出口在原子替换之后');
    // 结构不可定位 ≠ 空绿：守卫必须对自己「没找到被守卫路径」这件事判红
    const broken = analyzeBuildWindow('export const nothing = 1;\n');
    expect(broken.ok).toBe(false);
    expect(broken.violations.join('; ')).toContain('扫描面失效');
  });

  it('正向自检：合规源码判绿（守卫可被满足，不是恒红）', () => {
    const v = analyzeBuildWindow(COMPLIANT_SRC);
    expect(v.violations, v.violations.join('; ')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('watch 合同不变：仍以 dist/client-cjs 为 watch 输出 + --watch 分支仍在', () => {
    expect(real).toContain("'--outDir', 'dist/client-cjs'");
    expect(real).toContain("process.argv.includes('--watch')");
    expect(real).toContain("[...CLIENT_ARGS, '--watch']");
  });
});
