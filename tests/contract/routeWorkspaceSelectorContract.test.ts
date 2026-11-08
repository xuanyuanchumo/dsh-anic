/**
 * 路由工作区选择器契约（cycle-112）—— self/* 与 skill/* 必须把 `req` 透传给解析器。
 *
 * ## 被守卫缺陷（真机实证）
 *
 * `resolveSelfTarget` 原签名只收 `(ctx, send, res)`，内部 `resolveWorkspaceRoots(ctx)`
 * **不带请求** ⇒ 头 / 查询 / 会话三种选择器全部失效，回落 registry/sessions/cwd 的
 * 第一个工作区。实测（2026-11-08）：
 *
 *   curl "http://127.0.0.1:49501/anic/self/status?workspace=D%3A/.../dsh-anic"
 *   → {"status":"EVALUATING","facts":{"currentCycle":"cycle-9",...},"stale":true}
 *
 * 返回的是**另一个项目**的自举状态（本仓当前 cycle-111，`stale` 另有真值）。面板
 * 「闭环与自举」域因此长期 ⚠️，且这就是用户明令的「不同项目隔离显示不能污染」形态。
 *
 * ## 三条腿
 *
 *   ① 静态：src/host/routes/**.ts 内不得出现 `resolveWorkspaceRoots(ctx)`
 *      与 `resolveSelfTarget(ctx, send, res)`（二者都必须带当前请求）；
 *   ② 行为：`resolveSelfTarget(..., req)` 在请求声明了另一个工作区时必须解析到它；
 *   ③ 反向自检：判定器对违例样例必须判红（守卫可红性，防哑）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSelfTarget } from '../../src/host/routes/selfBootstrapShared.ts';
import type { SnapshotCtx } from '../../src/host/snapshotRoute.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTES_DIR = join(ROOT, 'src', 'host', 'routes');

function routeSources(): Array<{ rel: string; src: string }> {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ rel: `src/host/routes/${f}`, src: readFileSync(join(ROUTES_DIR, f), 'utf8') }));
}

/** 违例判定器：解析器调用必须带当前请求（第二个实参）。 */
function findReqDroppingCalls(src: string): string[] {
  const hits: string[] = [];
  for (const raw of src.split('\n')) {
    // 纪律：只扫**代码行**——注释里的示例形态不算调用（本仓自指陷阱第二例：
    // 说明文字写了旧形态，守卫把文档当成违例；反向自检钉住注释必须被忽略）。
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    const code = line.replace(/\/\/.*$/, '');
    if (/resolveWorkspaceRoots\(ctx\)/.test(code)) hits.push(line);
    if (/resolveSelfTarget\(ctx,\s*send,\s*res\)/.test(code)) hits.push(line);
  }
  return hits;
}

const CLEANUPS: string[] = [];
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('腿① 静态：路由层的解析调用必须带 req', () => {
  it('src/host/routes/** 零 `resolveWorkspaceRoots(ctx)` / `resolveSelfTarget(ctx, send, res)`', () => {
    const offenders: string[] = [];
    for (const { rel, src } of routeSources()) {
      for (const hit of findReqDroppingCalls(src)) offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders, '解析调用丢掉了当前请求（选择器失效 ⇒ 跨项目污染）：\n' + offenders.join('\n')).toEqual([]);
  });

  it('腿③ 反向自检：判定器对旧形态必判红（守卫可红性）', () => {
    const bad = ["const roots = resolveWorkspaceRoots(ctx);", "const t = resolveSelfTarget(ctx, send, res);"];
    const good = ["const roots = resolveWorkspaceRoots(ctx, req);", "const t = resolveSelfTarget(ctx, send, res, req);"];
    expect(bad.flatMap((l) => findReqDroppingCalls(l))).toHaveLength(2);
    expect(good.flatMap((l) => findReqDroppingCalls(l))).toHaveLength(0);
    // 注释里的示例形态不得被当成调用（自指陷阱：本契约自己的文档就写了旧形态）。
    const commented = [' * `resolveWorkspaceRoots(ctx)` 不带请求 ⇒ 选择器失效', '// resolveSelfTarget(ctx, send, res) 旧形态'];
    expect(commented.flatMap((l) => findReqDroppingCalls(l))).toHaveLength(0);
  });
});

describe('腿② 行为：请求声明的工作区必须被采信', () => {
  it('X-ANIC-Workspace 头 → resolveSelfTarget 解析到声明工作区（不是回落第一个）', () => {
    const claimed = mkdtempSync(join(tmpdir(), 'anic-selfws-'));
    CLEANUPS.push(claimed);
    mkdirSync(join(claimed, '.cycles'), { recursive: true });
    // ctx 无 registry/sessions ⇒ 只有选择器（acceptClaim 的 .cycles 兜底）能命中声明。
    const ctx = {} as SnapshotCtx;
    let err: { statusCode?: number } | null = null;
    const send = (res: unknown): void => { err = res as { statusCode?: number }; };
    const target = resolveSelfTarget(ctx, send as never, {}, {
      headers: { 'x-anic-workspace': claimed },
    } as never);
    expect(err, '解析被拒 ⇒ 选择器未生效').toBeNull();
    expect(target, '声明的工作区未被采信').not.toBeNull();
    expect(target?.roots).toBe(claimed);
  });

  it('?workspace= 查询参数同等级（无头时也采信）', () => {
    const claimed = mkdtempSync(join(tmpdir(), 'anic-selfwsq-'));
    CLEANUPS.push(claimed);
    mkdirSync(join(claimed, '.cycles'), { recursive: true });
    const ctx = {} as SnapshotCtx;
    let err: { statusCode?: number } | null = null;
    const send = (res: unknown): void => { err = res as { statusCode?: number }; };
    const target = resolveSelfTarget(ctx, send as never, {}, {
      url: `/anic/self/status?workspace=${encodeURIComponent(claimed)}`,
    } as never);
    expect(err).toBeNull();
    expect(target?.roots).toBe(claimed);
  });
});