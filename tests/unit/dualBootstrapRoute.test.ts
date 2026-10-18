/**
 * dualBootstrapRoute 单元测试（cycle-30 测试体系深挖）。
 *
 * 此前仅 routeWorkspaceCycle22 的 req 透传（404 早退）——行为分支零覆盖。
 * 契约面：
 *   - 三路由注册（dual-evaluate/dual-advance/dual-status）+ disposer 数组；
 *   - 无 webServer → 空数组；
 *   - 无工作区 → 404 ANIC_ROUTE_NO_WORKSPACE（三路由同形）；
 *   - pluginDir 未解析 → 500 ANIC_PLUGIN_ROOT_UNRESOLVED（P0-DIR-ROOT 响亮失败）；
 *   - dual-status 有状态文件 → 200 状态；无 → 200 初始态。
 * dual-evaluate/dual-advance 的 200 路径调 evaluatePluginSelf（真实审计插件
 * 源码树）——域逻辑已有 bootstrap 域测试覆盖，本测试钉守卫分支与
 * dual-status 的落盘语义。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDualBootstrapRoute } from '../../src/host/routes/dualBootstrapRoute.ts';
import type { DualBootstrapState } from '../../src/host/dualBootstrap.ts';
import type { BootstrapState } from '../../src/host/selfBootstrap.ts';

const CLEANUPS: string[] = [];
function tmpWorkspace(withState: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-dualroute-'));
  mkdirSync(join(root, '.cycles'), { recursive: true });
  if (withState) {
    // DualBootstrapState 真实形状：{plugin: BootstrapState, skill: BootstrapState, crossProposals[]}
    const bs = (round: number, score: number): BootstrapState => ({
      status: 'EVALUATED', round, maxRounds: 3, lastEvalScore: score, lastGateVerdict: 'doubt',
      history: [{ round, evalScore: score, gateVerdict: 'doubt', fixApplied: null, timestamp: '2026-10-17T00:00:00.000Z' }],
    });
    const state: DualBootstrapState = { plugin: bs(1, 60), skill: bs(0, 0), crossProposals: [] };
    writeFileSync(join(root, '.cycles', 'dual-bootstrap.json'), JSON.stringify(state));
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
function makeHarness(root: string | null, pluginDir: string): { registered: Map<string, (req: unknown, res: unknown) => void>; call: (method: string, path: string) => Captured } {
  const registered = new Map<string, (req: unknown, res: unknown) => void>();
  const ctx = { webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.set(r.path, r.handler); return (): void => {}; } } };
  const disposers = registerDualBootstrapRoute({
    ctx,
    send: (res: unknown, status: number, body: unknown): void => {
      (res as { statusCode?: number }).statusCode = status;
      (res as { body?: unknown }).body = body;
    },
    getWorkspaceRoot: (): string | null => root,
    pluginDir,
  });
  expect(disposers).toHaveLength(3);
  expect(registered.size).toBe(3);
  expect([...registered.keys()].sort()).toEqual(['/anic/self/dual-advance', '/anic/self/dual-evaluate', '/anic/self/dual-status']);
  return {
    registered,
    call: (method: string, path: string): Captured => {
      const res: { statusCode?: number; body?: unknown } = {};
      registered.get(path)?.({ method }, res);
      return { status: res.statusCode ?? null, body: JSON.stringify(res.body ?? null) };
    },
  };
}

describe('registerDualBootstrapRoute（三路由守卫与状态语义）', () => {
  it('无 webServer → 空数组（多代宿主安全降级，不返回 null）', () => {
    const out = registerDualBootstrapRoute({ ctx: {}, send: (): void => {}, getWorkspaceRoot: (): string | null => null, pluginDir: '' });
    expect(out).toEqual([]);
  });

  it('无工作区 → 三路由均 404 ANIC_ROUTE_NO_WORKSPACE', () => {
    const h = makeHarness(null, 'some-dir');
    for (const [m, p] of [['POST', '/anic/self/dual-evaluate'], ['POST', '/anic/self/dual-advance'], ['GET', '/anic/self/dual-status']] as const) {
      const cap = h.call(m, p);
      expect(cap.status, `${m} ${p}`).toBe(404);
      expect(cap.body, `${m} ${p}`).toContain('ANIC_ROUTE_NO_WORKSPACE');
    }
  });

  it('pluginDir 未解析 → dual-evaluate/dual-advance 500 ANIC_PLUGIN_ROOT_UNRESOLVED（P0-DIR-ROOT：evaluatePluginSelf(\'\') 会审计错误目录，必须响亮失败）', () => {
    const h = makeHarness(tmpWorkspace(false), '');
    for (const p of ['/anic/self/dual-evaluate', '/anic/self/dual-advance'] as const) {
      const cap = h.call('POST', p);
      expect(cap.status, p).toBe(500);
      expect(cap.body, p).toContain('ANIC_PLUGIN_ROOT_UNRESOLVED');
    }
  });

  it('dual-status：无状态文件 → 200 初始态（IDLE/round 0）；有状态文件 → 200 载入（plugin.lastEvalScore 可数）', () => {
    const h0 = makeHarness(tmpWorkspace(false), 'x');
    const cap0 = h0.call('GET', '/anic/self/dual-status');
    expect(cap0.status).toBe(200);
    const parsed0 = JSON.parse(cap0.body) as { plugin: { status: string; round: number } };
    expect(parsed0.plugin.status).toBe('IDLE');
    expect(parsed0.plugin.round).toBe(0);

    const h1 = makeHarness(tmpWorkspace(true), 'x');
    const cap1 = h1.call('GET', '/anic/self/dual-status');
    expect(cap1.status).toBe(200);
    const parsed1 = JSON.parse(cap1.body) as { plugin: { status: string; round: number; lastEvalScore: number; history: unknown[] } };
    expect(parsed1.plugin.status).toBe('EVALUATED');
    expect(parsed1.plugin.round).toBe(1);
    expect(parsed1.plugin.lastEvalScore).toBe(60);
    expect(parsed1.plugin.history).toHaveLength(1);
  });
});
