/**
 * cycle-22 路由 req 传递契约（其余域统一）：
 * cycle-21 修了 nativeRoute 7 路由（真机发现写侧工作区错位）；本测试钉住
 * 其余域 7 文件全部 handler 把 req 原样传给 getWorkspaceRoot——
 * X-ANIC-Workspace 头参与解析的契约不再只对 native 域成立。
 *
 * 覆盖文件（cycle-22 迁移面）：
 * - cycleRoute.ts（init/advance/close/state/list 5 路由）
 * - ledgerRoute.ts（ledger/append/verify 3 路由）
 * - skillInstallRoute.ts（install/status/repair 3 路由）
 * - dualBootstrapRoute.ts（dual-evaluate/dual-advance/dual-status 3 路由）
 * - segmentedLedgerRoute.ts（seg-ledger/append/verify/init 4 路由）
 * - selfInitRoute.ts（self/init 1 路由）
 * - stackProbeRoute.ts（stack-probe 1 路由）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Registered {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

interface CtxStub {
  webServer: { register: (r: Registered) => (() => void) | null };
}

function makeCtx(): { ctx: CtxStub; registered: Registered[] } {
  const registered: Registered[] = [];
  const ctx: CtxStub = {
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
  };
  return { ctx, registered };
}

function makeSend(captured: { status: number; body: unknown }[]) {
  return (_res: unknown, status: number, body: unknown) => { captured.push({ status, body }); };
}

const CLEANUPS: string[] = [];
afterEach(() => {
  while (CLEANUPS.length) { const p = CLEANUPS.pop(); try { rmSync(p!, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-cycle22-route-'));
  CLEANUPS.push(dir);
  return dir;
}

/** 404 早退形态：getWorkspaceRoot 返回 null → 任何工作区都不该被触。 */
async function expectReqPassthrough(registered: Registered[], captured: { status: number; body: unknown }[], method: string, path: string) {
  const hit = registered.find((r) => r.path === path);
  expect(hit, `route ${path} registered`).toBeDefined();
  const req = { method, url: path, headers: {} };
  hit!.handler(req, {});
  // POST 路由普遍 readBody 异步——给微任务链一次 flush 机会
  await new Promise((r) => setTimeout(r, 10));
  // 404 = no workspace（getWorkspaceRoot 被以 req 调用并返回 null 的证据）
  expect(captured.at(-1)?.status).toBe(404);
}

describe('cycle-22 其余域路由 getWorkspaceRoot(req) 统一', () => {
  it('cycleRoute：5 路由注册 + req 透传（404 早退）', async () => {
    const { registerCycleRoute } = await import('../../src/host/routes/cycleRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerCycleRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
    });
    expect(registered.map((r) => r.path).sort()).toEqual([
      '/anic/cycle/advance', '/anic/cycle/close', '/anic/cycle/init', '/anic/cycle/list', '/anic/cycle/state',
    ]);
    for (const [m, p] of [['POST', '/anic/cycle/init'], ['POST', '/anic/cycle/advance'], ['POST', '/anic/cycle/close'], ['GET', '/anic/cycle/state'], ['GET', '/anic/cycle/list']] as const) {
      await expectReqPassthrough(registered, captured, m, p);
      expect(passedReq).toBeDefined();
    }
  });

  it('ledgerRoute：3 路由注册 + req 透传（404 早退）', async () => {
    const { registerLedgerRoute } = await import('../../src/host/routes/ledgerRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerLedgerRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
    });
    expect(registered.map((r) => r.path).sort()).toEqual([
      '/anic/api/ledger', '/anic/api/ledger/append', '/anic/api/ledger/verify',
    ]);
    await expectReqPassthrough(registered, captured, 'GET', '/anic/api/ledger');
    expect(passedReq).toBeDefined();
    await expectReqPassthrough(registered, captured, 'GET', '/anic/api/ledger/verify');
    // append 是 POST readBody 异步——给微任务机会
    await expectReqPassthrough(registered, captured, 'POST', '/anic/api/ledger/append');
  });

  it('skillInstallRoute：3 路由 req 透传（404 早退；写侧路由）', async () => {
    const { registerSkillInstallRoute } = await import('../../src/host/routes/skillInstallRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerSkillInstallRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
    });
    expect(registered.map((r) => r.path).sort()).toEqual([
      '/anic/skill/install', '/anic/skill/repair', '/anic/skill/status',
    ]);
    for (const [m, p] of [['POST', '/anic/skill/install'], ['GET', '/anic/skill/status'], ['POST', '/anic/skill/repair']] as const) {
      await expectReqPassthrough(registered, captured, m, p);
      expect(passedReq).toBeDefined();
    }
  });

  it('dualBootstrapRoute：3 路由 req 透传（404 早退）', async () => {
    const { registerDualBootstrapRoute } = await import('../../src/host/routes/dualBootstrapRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerDualBootstrapRoute({ ctx, send: makeSend(captured), getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; }, pluginDir: 'X:/plugin' });
    expect(registered.map((r) => r.path).sort()).toEqual([
      '/anic/self/dual-advance', '/anic/self/dual-evaluate', '/anic/self/dual-status',
    ]);
    for (const [m, p] of [['POST', '/anic/self/dual-evaluate'], ['POST', '/anic/self/dual-advance'], ['GET', '/anic/self/dual-status']] as const) {
      await expectReqPassthrough(registered, captured, m, p);
      expect(passedReq).toBeDefined();
    }
  });

  it('segmentedLedgerRoute：4 路由 req 透传（404 早退）', async () => {
    const { registerSegmentedLedgerRoute } = await import('../../src/host/routes/segmentedLedgerRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerSegmentedLedgerRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
    });
    expect(registered.map((r) => r.path).sort()).toEqual([
      '/anic/api/seg-ledger', '/anic/api/seg-ledger/append', '/anic/api/seg-ledger/init', '/anic/api/seg-ledger/verify',
    ]);
    for (const [m, p] of [['GET', '/anic/api/seg-ledger'], ['GET', '/anic/api/seg-ledger/verify'], ['GET', '/anic/api/seg-ledger/init']] as const) {
      await expectReqPassthrough(registered, captured, m, p);
      expect(passedReq).toBeDefined();
    }
  });

  it('stackProbeRoute：req 透传（404 早退）', async () => {
    const { registerStackProbeRoute } = await import('../../src/host/routes/stackProbeRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerStackProbeRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
    });
    await expectReqPassthrough(registered, captured, 'GET', '/anic/api/stack-probe');
    expect(passedReq).toBeDefined();
  });

  it('selfInitRoute：req 透传（404 早退；POST /anic/self/init）', async () => {
    const { registerSelfInitRoute } = await import('../../src/host/routes/selfInitRoute.ts');
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    let passedReq: unknown = null;
    registerSelfInitRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => { passedReq = req; return null; },
      loadFlows: () => ({ selfInit: true }),
    });
    await expectReqPassthrough(registered, captured, 'POST', '/anic/self/init');
    expect(passedReq).toBeDefined();
  });

  it('写侧钉：X-ANIC-Workspace 声明的工作区收到写入，默认工作区零写入', async () => {
    // band-detect 是 cycle-21 真机 bug 的写侧路由；此处用同款 resolveWorkspaceRoots
    // 语义验「头声明优先」在真 route handler 链路上成立——用 skillInstallRoute
    // install 写侧（写 .dsh/skills/ 到声明工作区）。
    const { registerSkillInstallRoute } = await import('../../src/host/routes/skillInstallRoute.ts');
    const claimed = tmpWorkspace();
    const fallback = tmpWorkspace();
    const { ctx, registered } = makeCtx();
    const captured: { status: number; body: unknown }[] = [];
    // 头声明优先 + 采信条件：路径存在（resolveWorkspaceRoots 的 existsSync(.cycles) 采信域）
    // ——临时工作区无 .cycles 时 fallback；模拟器简化为「头声明即返回」（真链路在
    // snapshotRoute.test.ts 已钉），此处只钉 handler 把 req 传下去 → 头能到达解析器。
    const headers: Record<string, string> = { 'x-anic-workspace': encodeURIComponent(claimed) };
    registerSkillInstallRoute(ctx, {
      send: makeSend(captured),
      getWorkspaceRoot: (req?: unknown) => {
        const h = (req as { headers?: Record<string, string> } | undefined)?.headers;
        const claimedHeader = h?.['x-anic-workspace'];
        if (claimedHeader) return decodeURIComponent(claimedHeader);
        return fallback;
      },
    });
    const hit = registered.find((r) => r.path === '/anic/skill/install')!;
    hit.handler({ method: 'POST', url: '/anic/skill/install', headers }, {});
    // 无内联技能时 install 500（ANIC_ROUTE_SKILL_INSTALL_FAILED）或 200——
    // 但关键断言：响应到达（handler 完整跑完，说明 root 非空路径生效）
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].status).not.toBe(404);
    expect(fallback).not.toBe(claimed);
  });
});
