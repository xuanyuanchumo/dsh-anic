/**
 * nativeRoute 工作区解析契约测试（cycle-21 真机发现修复）。
 *
 * 发现场景：测试宿主多会话（首条 codegraph），请求带
 * `X-ANIC-Workspace: dsh-anic` 头调 band-detect——org-status（带 req）读对
 * 工作区，band-detect（不带 req）却把自主带 entry 写进了首条会话的
 * codegraph/.cycles/band-history.json。写侧路由忽略头 = 跨工作区数据写错位。
 *
 * 契约：7 条原生路由的 handler 必须把 req 传给 getWorkspaceRoot（头参与解析
 * 的前提）；band-detect 写侧落盘在「解析器选定的工作区」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerNativeRoute } from '../../src/host/routes/nativeRoute.ts';

const CLEANUPS: string[] = [];
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Captured { status: number | null; body: unknown }
/** 注册 nativeRoute 并捕获 getWorkspaceRoot 收到的 req（契约主体）。 */
function makeHarness(): {
  paths: string[];
  call: (method: string, path: string, req: unknown) => Captured;
} {
  const registered = new Map<string, { kind: string; path: string; handler: (req: unknown, res: unknown) => void }>();
  let capturedReq: unknown = 'not-called';
  let resolveRoot: string | null = null;
  const ctx = {
    webServer: {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => {
        // reg() 只传 {kind,path,handler}——method 由各 handler 内部校验（405）
        registered.set(r.path, r);
        return (): void => { /* 宿主承接 */ };
      },
    },
  };
  const disposers = registerNativeRoute(ctx, {
    send: (res: unknown, status: number, body: unknown): void => {
      (res as { statusCode?: number }).statusCode = status;
      (res as { body?: unknown }).body = body;
    },
    getWorkspaceRoot: (req?: unknown): string | null => {
      capturedReq = req;
      return resolveRoot;
    },
    agentCards: new Map(),
  });
  expect(disposers.length).toBeGreaterThan(0);
  return {
    paths: [...registered.keys()],
    call: (method: string, path: string, req: unknown): Captured => {
      resolveRoot = (req as { __root?: string } | null)?.__root ?? null;
      const res: { statusCode?: number; body?: unknown } = {};
      // req 必须自带 method（handler 内部校验 405）；原样传递以保身份断言
      registered.get(path)?.handler(req, res);
      // 契约断言材料：getWorkspaceRoot 收到的就是 handler 收到的同一 req
      const out: Captured & { passedReq?: unknown } = {
        status: res.statusCode ?? null,
        body: res.body ?? null,
        passedReq: capturedReq,
      };
      // 上一请求的 capturedReq 不应泄漏到下一断言
      capturedReq = 'not-called';
      return out;
    },
  };
}

/** 带预置质量带历史的临时工作区（band-detect 正向写测试用）。 */
function workspaceWithQualityHistory(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-nativews-'));
  mkdirSync(join(root, '.cycles'), { recursive: true });
  writeFileSync(join(root, '.cycles', 'band-history.json'), JSON.stringify([
    { timestamp: '2026-10-01T00:00:00.000Z', totalScore: 100, avgScore: 17.5, fileCount: 10, overBudgetCount: 0 },
    { timestamp: '2026-10-02T00:00:00.000Z', totalScore: 110, avgScore: 18.1, fileCount: 11, overBudgetCount: 1 },
  ]));
  CLEANUPS.push(root);
  return root;
}

const ROUTES: Array<[string, string]> = [
  ['POST', '/anic/hitl-audit'],
  ['GET', '/anic/band-detect'],
  ['GET', '/anic/org-status'],
  ['GET', '/anic/fact-base'],
  ['GET', '/anic/plan-sync'],
  ['POST', '/anic/multi-agent-gate'],
  ['POST', '/anic/fix-loop'],
];

describe('nativeRoute 工作区解析（cycle-21：全部 7 路由带 req）', () => {
  it('7 条路由全部注册（回归：路由集合不变）', () => {
    const h = makeHarness();
    const expectPaths = ROUTES.map(([, p]) => p);
    for (const p of expectPaths) {
      expect(h.paths).toContain(p);
    }
    expect(h.paths).toHaveLength(7);
  });

  it('每条路由都把 handler 收到的 req 原样传给 getWorkspaceRoot（头解析的前提）', async () => {
    const h = makeHarness();
    for (const [m, p] of ROUTES) {
      // 带 X-ANIC-Workspace 头形状的 req；__root=null 让 handler 走 404 早退
      // （重逻辑不跑——本用例只钉「req 传递」契约本身）
      const req = { method: m, url: p, headers: { 'x-anic-workspace': 'D%3A%5Cclaimed-ws' } };
      const cap = h.call(m, p, req) as { status: number | null; passedReq?: unknown };
      expect(cap.status).toBe(404); // 无可解析工作区 → 早退（不依赖工作区内容）
      expect(cap.passedReq).toBe(req); // ← 契约：不是 undefined、不是别的对象
    }
  });

  it('band-detect：写侧落盘在解析器选定的工作区（真机错位场景的回归钉）', async () => {
    const claimed = workspaceWithQualityHistory();
    const defaultRoot = workspaceWithQualityHistory();
    const h = makeHarness();
    // 模拟多会话宿主：默认解析 → defaultRoot；头声明 → claimed（合法集含 .cycles）
    const req = {
      method: 'GET',
      url: '/anic/band-detect?score=0.82',
      headers: { 'x-anic-workspace': encodeURIComponent(claimed) },
      __root: claimed,
    };
    const cap = h.call('GET', '/anic/band-detect', req) as { status: number | null; body?: { current?: string; entries?: Array<{ cycle: number }> }; passedReq?: unknown };
    expect(cap.status).toBe(200);
    expect((cap.passedReq as { headers?: Record<string, string> })?.headers?.['x-anic-workspace']).toBe(encodeURIComponent(claimed));
    const body = cap.body as { current: string; entries: Array<{ cycle: number; score: number }> };
    expect(body.current).toBe('normal'); // 0.82 ≥ 0.7
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.cycle).toBe(1); // 自主带子序列编号（cycle-21 写侧语义）
    // 落盘断言：claimed 工作区追加保留（2 质量 + 1 自主 = 3）；default 不被写
    const claimedFile = JSON.parse(readFileSync(join(claimed, '.cycles', 'band-history.json'), 'utf8')) as unknown[];
    expect(claimedFile).toHaveLength(3);
    const auto = claimedFile.filter((e) => typeof (e as { band?: unknown }).band === 'string');
    expect(auto).toHaveLength(1);
    const quality = claimedFile.filter((e) => (e as { avgScore?: unknown }).avgScore !== undefined);
    expect(quality).toHaveLength(2); // 质量带历史原样保留（追加不覆写）
    const defaultFile = JSON.parse(readFileSync(join(defaultRoot, '.cycles', 'band-history.json'), 'utf8')) as unknown[];
    expect(defaultFile).toHaveLength(2); // 错位写回归钉：默认工作区零写入
  });
});
