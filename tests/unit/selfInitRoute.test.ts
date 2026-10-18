/**
 * selfInitRoute 单元测试（cycle-30 测试体系深挖）。
 *
 * 此前仅 routeWorkspaceCycle22 的 req 透传（404 早退）——行为分支零覆盖。
 * 契约面（docs/anic/12 §2.3 + 13 §2.2）：
 *   - 非 POST → 405；
 *   - flow.selfInit 开关关闭 → 403 ANIC_ROUTE_SELF_INIT_DISABLED；
 *   - 无可解析工作区 → 404 ANIC_ROUTE_SELF_INIT_NO_WORKSPACE；
 *   - 工作区已有 .cycles/config.yml → 409 ANIC_ROUTE_SELF_INIT_ALREADY
 *     （refuse-to-rerun 幂等设计——404/403/409 全部早退于技能 spawn 之前）。
 *   - 200 路径需要真 spawn init-workflow.mjs（技能 e2e 已在 skillReplaceE2E/
 *     npxInit 覆盖），本测试不重复——只钉守卫分支的顺序与错误码。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSelfInitRoute, SELF_INIT_ROUTE } from '../../src/host/routes/selfInitRoute.ts';

const CLEANUPS: string[] = [];
function tmpWorkspace(withConfig: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-selfinit-'));
  if (withConfig) {
    mkdirSync(join(root, '.cycles'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'config.yml'), 'autonomy_level: L4\nproject_name: t\n');
  }
  CLEANUPS.push(root);
  return root;
}
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Captured { status: number | null; body: string }
function makeHarness(root: string | null, selfInitOn = true): { registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>; call: (req: unknown) => Captured } {
  const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const ctx = { webServer: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; } } };
  const disposer = registerSelfInitRoute(ctx, {
    send: (res: unknown, status: number, body: unknown): void => {
      (res as { statusCode?: number }).statusCode = status;
      (res as { body?: unknown }).body = body;
    },
    getWorkspaceRoot: (): string | null => root,
    loadFlows: (): { selfInit: boolean } => ({ selfInit: selfInitOn }),
  });
  expect(typeof disposer).toBe('function');
  expect(registered).toHaveLength(1);
  expect(registered[0]?.path).toBe(SELF_INIT_ROUTE);
  return {
    registered,
    call: (req: unknown): Captured => {
      const res: { statusCode?: number; body?: unknown } = {};
      registered[0]?.handler(req, res);
      return { status: res.statusCode ?? null, body: JSON.stringify(res.body ?? null) };
    },
  };
}

describe('registerSelfInitRoute（守卫分支：405/403/404/409 早退于技能 spawn 之前）', () => {
  it('无 webServer → null（多代宿主安全降级）', () => {
    expect(registerSelfInitRoute({}, { send: (): void => {}, getWorkspaceRoot: (): string | null => null, loadFlows: (): { selfInit: boolean } => ({ selfInit: true }) })).toBeNull();
  });

  it('非 POST → 405 POST only', () => {
    const h = makeHarness(tmpWorkspace(false));
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(405);
    expect(cap.body).toContain('POST only');
  });

  it('flow.selfInit 关闭 → 403 ANIC_ROUTE_SELF_INIT_DISABLED（13 §2.2 关闭形态契约）', () => {
    const h = makeHarness(tmpWorkspace(false), false);
    const cap = h.call({ method: 'POST' });
    expect(cap.status).toBe(403);
    expect(cap.body).toContain('ANIC_ROUTE_SELF_INIT_DISABLED');
  });

  it('无可解析工作区 → 404 ANIC_ROUTE_SELF_INIT_NO_WORKSPACE', () => {
    const h = makeHarness(null);
    const cap = h.call({ method: 'POST' });
    expect(cap.status).toBe(404);
    expect(cap.body).toContain('ANIC_ROUTE_SELF_INIT_NO_WORKSPACE');
  });

  it('已有 .cycles/config.yml → 409 ANIC_ROUTE_SELF_INIT_ALREADY（refuse-to-rerun 幂等）', () => {
    const h = makeHarness(tmpWorkspace(true));
    const cap = h.call({ method: 'POST' });
    expect(cap.status).toBe(409);
    expect(cap.body).toContain('ANIC_ROUTE_SELF_INIT_ALREADY');
    expect(cap.body).toContain('idempotent by design');
  });

  it('守卫顺序：405 先于 403（方法契约先于开关契约）', () => {
    // 开关关 + GET 方法 → 405（不是 403）
    const h = makeHarness(null, false);
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(405);
  });

  it('守卫顺序：403 先于 404（开关契约先于工作区解析）', () => {
    // 开关关 + 无工作区 → 403（不是 404）
    const h = makeHarness(null, false);
    const cap = h.call({ method: 'POST' });
    expect(cap.status).toBe(403);
  });
});
