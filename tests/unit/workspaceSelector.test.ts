/**
 * Q-1（cycle-77）连接性缺陷单元测试：`?workspace=` 查询参数与 `X-ANIC-Workspace`
 * 请求头**同等级**同为工作区选择器，优先级 头 > 查询 > registry > sessions > cwd。
 *
 * 被守卫缺陷（实测证据）：anic_status / anic_snapshot / anic_self_check 返回的
 * statusUrl / snapshotUrl / selfCheckUrl 全是 `?workspace=<abs>` 形态，而修复前的
 * resolveWorkspaceRoots 只读请求头——curl 该 URL 得到 cycles.total=0 / band=L2
 * （回落到宿主首个工作区），换请求头才拿到 73。查询参数被忽略不是报错，是**读错
 * 工作区的静默错误**，因此每个正向断言都配反向自检（证明守卫有牙，不是 happy path）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceRoots } from '../../src/host/snapshotRoute.ts';
import { buildRouteContext } from '../../src/host/routes/routeContext.ts';

const CLEANUPS: string[] = [];
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 临时工作区夹具：withCycles=true 时建 `.cycles/config.yml`（选择器第二采信条件）。 */
function workspace(withCycles = true): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-sel-'));
  if (withCycles) {
    mkdirSync(join(root, '.cycles'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'config.yml'), 'autonomy_level: L2\n');
  }
  CLEANUPS.push(root);
  return root;
}

interface StubCtx {
  workspaceRegistry?: { list?(): { path?: string }[] };
  sessions?: { list?(): { header?: { cwd?: string } }[] };
}

/** stub 宿主上下文（最小形状：registry 报 root，sessions 可选报另一个根）。 */
function makeCtx(root: string, sessionRoot?: string): StubCtx {
  const ctx: StubCtx = { workspaceRegistry: { list: (): { path?: string }[] => [{ path: root }] } };
  if (sessionRoot !== undefined) ctx.sessions = { list: (): { header?: { cwd?: string } }[] => [{ header: { cwd: sessionRoot } }] };
  return ctx;
}

const urlWith = (ws: string): string => `/anic/org-status?workspace=${encodeURIComponent(ws)}`;
const headerWith = (ws: string): Record<string, string> => ({ 'x-anic-workspace': encodeURIComponent(ws) });

/**
 * 修复前行为的等价副本（只读头、完全忽略查询参数）——**反向自检**用。
 * 它必须对"只有查询参数"的请求返回 null（=旧实现会回落到 registry 的错误工作区），
 * 否则本文件的断言就无法区分新旧实现，等于假守卫。
 */
function legacyResolveHeaderOnly(ctx: StubCtx, req: unknown): string | null {
  const raw = (req as { headers?: Record<string, string | string[] | undefined> } | null | undefined)?.headers?.['x-anic-workspace'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string' || val.trim() === '') return null;
  const claimed = decodeURIComponent(val);
  return (ctx.workspaceRegistry?.list?.() ?? []).some((w) => w.path === claimed) ? claimed : null;
}

describe('Q-1 工作区选择器：?workspace= 与请求头同等级', () => {
  it('① 头优先于查询参数（两个选择器都合法时头赢）', () => {
    const known = workspace();
    const viaHeader = workspace();
    const viaQuery = workspace();
    const ctx = makeCtx(known, viaHeader); // 头声明的 viaHeader 命中 sessions 合法集
    const req = { url: urlWith(viaQuery), headers: headerWith(viaHeader) };
    expect(resolveWorkspaceRoots(ctx, req)).toBe(viaHeader);
    // 反向自检：若优先级写反（查询盖过头），结果是 viaQuery —— 断言必须能判红
    expect(resolveWorkspaceRoots(ctx, req)).not.toBe(viaQuery);
  });

  it('② 无头时查询参数生效（修复前会静默回落到 registry 的错误工作区）', () => {
    const known = workspace();
    const viaQuery = workspace();
    const ctx = makeCtx(known);
    const req = { url: urlWith(viaQuery) };
    expect(resolveWorkspaceRoots(ctx, req)).toBe(viaQuery);
    // 反向自检：旧实现（只读头）对该请求一无所获 → 回落 known
    expect(legacyResolveHeaderOnly(ctx, req)).toBeNull();
    expect(resolveWorkspaceRoots(ctx, {})).toBe(known);
    // 且"无查询"与"有查询"的结果必须不同，否则②没有测到任何东西
    expect(resolveWorkspaceRoots(ctx, {})).not.toBe(resolveWorkspaceRoots(ctx, req));
  });

  it('③ 未知且无 .cycles 的路径被忽略并回落（选择器不是任意路径入口）', () => {
    const known = workspace();
    const stranger = workspace(false); // 临时目录存在，但没有 .cycles
    const ctx = makeCtx(known);
    expect(resolveWorkspaceRoots(ctx, { url: urlWith(stranger) })).toBe(known);
    // 反向自检：若校验放宽成"路径存在即采信"，会返回 stranger
    expect(resolveWorkspaceRoots(ctx, { url: urlWith(stranger) })).not.toBe(stranger);
  });

  it('④ `..` 穿越 / 不存在路径被忽略（含工具面泄露的 ..%2Fevil 形态）', () => {
    const known = workspace();
    const ctx = makeCtx(known);
    const traversal = join(known, '..', '__anic_nonexistent_probe__');
    for (const bad of [
      traversal,
      'Z:\\__anic_nonexistent_probe__',
      '..\\evil',
      '../evil',
    ]) {
      expect(resolveWorkspaceRoots(ctx, { url: urlWith(bad) })).toBe(known);
    }
    // 反向自检：即便原文带 ..%2F（toolsGatewayDomain 里 hitlUrl 的形态），也不得被采信
    expect(resolveWorkspaceRoots(ctx, { url: '/anic/hitl-audit?workspace=..%2Fevil' })).toBe(known);
  });

  it('⑤ 编码后的反斜杠路径可解码命中（%3A%5C 形态与非编码原样形态都行）', () => {
    const known = workspace();
    const target = workspace(); // 不在 registry 合法集，只能靠"真含 .cycles"被采信
    const ctx = makeCtx(known);
    // encodeURIComponent：Windows 路径 → C%3A%5CUsers%5C...%5Canic-sel-xxx
    expect(urlWith(target)).toContain('%5C');
    expect(resolveWorkspaceRoots(ctx, { url: urlWith(target) })).toBe(target);
    // 未编码原样反斜杠（手工 curl / 浏览器自动编码前的形态）同样命中
    expect(resolveWorkspaceRoots(ctx, { url: `/anic/org-status?workspace=${target}` })).toBe(target);
    // 反向自检：不做解码时字符串带 %5C，不存在 → 回落 known
    expect(legacyResolveHeaderOnly(ctx, { url: urlWith(target) })).toBeNull();
  });

  it('⑥ 畸形/缺失 URL 不抛异常且一律回落（选择器绝不炸掉请求）', () => {
    const known = workspace();
    const ctx = makeCtx(known);
    const malformed: unknown[] = [
      { url: '/anic/org-status?workspace=%E0%A4%A' }, // 非法百分号转义
      { url: '/anic/org-status?workspace' }, // 无等号
      { url: '/anic/org-status?workspace=' }, // 空值
      { url: '/anic/org-status?' }, // 只有问号
      { url: 42 },
      { url: null },
      {},
      null,
      undefined,
      'garbage-req', // 非对象请求
    ];
    for (const req of malformed) {
      expect(() => resolveWorkspaceRoots(ctx, req)).not.toThrow();
      expect(resolveWorkspaceRoots(ctx, req)).toBe(known);
    }
  });

  it('真实接缝：buildRouteContext.getWorkspaceRoot 把 req 交给选择器（路由层无需改）', () => {
    const known = workspace();
    const viaQuery = workspace();
    const rc = buildRouteContext(makeCtx(known));
    expect(rc.getWorkspaceRoot({ url: urlWith(viaQuery) })).toBe(viaQuery);
    expect(rc.getWorkspaceRoot({ url: '/anic/org-status' })).toBe(known);
    // 反向自检：不带 req 的调用（旧代码路径）仍按宿主来源解析，不受查询通道影响
    expect(rc.getWorkspaceRoot()).toBe(known);
  });
});
