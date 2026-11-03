/**
 * GET /anic/api/flows/view 契约（cycle-101 · 有界视图面板消费面）。
 *
 * 守卫四件事：
 *   ① 正常注册：reg 收到路径常量，注册恰好一次；
 *   ② 无工作区 → 404 统一信封（fail-closed，绝不返回全项目流）；
 *   ③ 无 .cycles → 空视图（total 0，如实不伪造历史）；
 *   ④ limit 查询参数解析（非法值回退默认，不抛不 500）。
 */
import { describe, expect, it } from 'vitest';
import { registerFlowsViewRoute, FLOWS_VIEW_ROUTE } from '../../src/host/routes/flowsViewRoute.ts';

interface Captured { status: number; body: unknown }

function harness(workspace: string | null) {
  const captured: Captured[] = [];
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
  registerFlowsViewRoute(
    (_res, status, body) => { captured.push({ status, body }); },
    {
      getWorkspaceRoot: () => workspace,
      reg: (path, handler) => { routes.push({ path, handler }); },
    },
  );
  return { captured, routes };
}

describe('GET /anic/api/flows/view（有界视图端点）', () => {
  it('① 注册恰好一条路由，路径取自常量（单一事实源）', () => {
    const h = harness(null);
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]!.path).toBe(FLOWS_VIEW_ROUTE);
    expect(FLOWS_VIEW_ROUTE).toBe('/anic/api/flows/view');
  });

  it('② 无工作区 → 404 统一信封（fail-closed）', () => {
    const h = harness(null);
    h.routes[0]!.handler({ url: '/anic/api/flows/view' }, {});
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.status).toBe(404);
    const body = h.captured[0]!.body as { ok: boolean; error: { code: string; retry: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('ANIC_ROUTE_NO_WORKSPACE');
    expect(body.error.retry).toBe('never'); // 策略表语义（拒绝类永不重试）
  });

  it('③ 工作区无 .cycles → 空视图（total 0，不伪造历史）', () => {
    const h = harness('Z:/__no_such_workspace__');
    h.routes[0]!.handler({ url: '/anic/api/flows/view' }, {});
    const body = h.captured[0]!.body as {
      view: { totalEver: number; head: unknown[]; dropped: number };
      marker: string;
    };
    expect(body.view.totalEver).toBe(0);
    expect(body.view.head).toEqual([]);
    expect(body.view.dropped).toBe(0);
    expect(body.marker).toContain('flows 0 total');
  });

  it('④ limit 查询参数被解析；非法值/缺 url 都回退默认不抛', () => {
    const h = harness('Z:/__no_such_workspace__');
    h.routes[0]!.handler({ url: '/anic/api/flows/view?limit=7' }, {});
    expect(h.captured.at(-1)!.status).toBe(200);
    h.routes[0]!.handler({ url: '/anic/api/flows/view?limit=abc' }, {});
    expect(h.captured.at(-1)!.status).toBe(200);
    h.routes[0]!.handler({}, {}); // 桩宿主无 url 字段
    expect(h.captured.at(-1)!.status).toBe(200);
  });
});
