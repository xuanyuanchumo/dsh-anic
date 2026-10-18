/**
 * stepTraceRoute 单元测试（cycle-30 测试体系深挖）。
 *
 * 此前仅常量入 ALL_ROUTES（snapshotRoute.test.ts）——handler 级零覆盖。
 * 契约面：
 *   - 注册 exact 路由 + 返回 disposer；
 *   - 无 .cycles → 404（未 init 项目是可用状态，不是错误）；
 *   - 有 .cycles → 200 四源投影（snapshot + workflow-state + ledger + cycle 目录）；
 *   - 构建器抛错 → 500 响亮失败（不静默 200）。
 *   - ctx 直接携带 webServer（本路由不接收 deps，注册形态与 skillHealthRoute 不同）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStepTraceRoute, STEP_TRACE_ROUTE } from '../../src/host/routes/stepTraceRoute.ts';

const CLEANUPS: string[] = [];
function tmpWorkspace(withCycles: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-steptrace-'));
  if (withCycles) {
    mkdirSync(join(root, '.cycles'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'workflow-graph.yaml'), [
      'nodes:',
      '  - id: build',
      '    type: task',
      '    label: "构建"',
      'edges: []',
    ].join('\n'));
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

interface Captured { status: number | null; body: unknown }
/** sendJson 形态的 res 桩：writeHead 记状态 + end 记 body（http.ServerResponse 最小形状）。 */
function resStub(): { statusCode?: number; body?: unknown; writeHead: (code: number, headers: Record<string, string>) => void; end: (data?: string) => void } {
  const r: { statusCode?: number; body?: unknown; writeHead?: (code: number, headers: Record<string, string>) => void; end?: (data?: string) => void } = {};
  r.writeHead = (code: number): void => { r.statusCode = code; };
  r.end = (data?: string): void => { if (data !== undefined) r.body = JSON.parse(data); };
  return r as { statusCode?: number; body?: unknown; writeHead: (code: number, headers: Record<string, string>) => void; end: (data?: string) => void };
}
function makeHarness(): { registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>; call: (req: unknown) => Captured } {
  const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const ctx = {
    webServer: {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => {
        registered.push(r);
        return (): void => {};
      },
    },
  };
  const disposer = registerStepTraceRoute(ctx);
  expect(typeof disposer).toBe('function');
  expect(registered).toHaveLength(1);
  expect(registered[0]?.kind).toBe('exact');
  expect(registered[0]?.path).toBe(STEP_TRACE_ROUTE);
  return {
    registered,
    call: (req: unknown): Captured => {
      const res = resStub();
      registered[0]?.handler(req, res);
      return { status: res.statusCode ?? null, body: res.body };
    },
  };
}

describe('registerStepTraceRoute', () => {
  it('无 webServer → null（多代宿主安全降级）', () => {
    expect(registerStepTraceRoute({})).toBeNull();
  });

  it('工作区无 .cycles → 404（未 init 是可用状态，不是错误）', () => {
    const h = makeHarness();
    // resolveWorkspaceRoots 走 ctx.cwd（无 registry/sessions 注入时）
    const cap = h.call({ method: 'GET' });
    // tmp cwd 无 .cycles → 404；真机 cwd 有 .cycles → 200。
    // 单测 cwd 不可控，这里只断言两合法形态之一，不猜 cwd。
    expect([200, 404]).toContain(cap.status);
  });

  it('注入 workspaceRegistry 工作区（无 .cycles）→ 404 + error 字段', () => {
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const ctx = {
      webServer: {
        register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; },
      },
      // snapshotRoute 的 SnapshotCtx.workspaceRegistry：{list(): {path}[]} 形态
      workspaceRegistry: { list: (): Array<{ path: string }> => [{ path: tmpWorkspace(false) }] },
    };
    const d = registerStepTraceRoute(ctx);
    expect(typeof d).toBe('function');
    const res = resStub();
    registered[0]?.handler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).toContain('no .cycles');
  });

  it('注入 workspaceRegistry 工作区（有 .cycles）→ 200 四源投影（wf: 节点可见）', () => {
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const ctx = {
      webServer: {
        register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; },
      },
      workspaceRegistry: { list: (): Array<{ path: string }> => [{ path: tmpWorkspace(true) }] },
    };
    const d = registerStepTraceRoute(ctx);
    expect(typeof d).toBe('function');
    const res = resStub();
    registered[0]?.handler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.body);
    // buildStepTrace 输出的关键字段（四源投影的确定性骨架）
    expect(body).toContain('wf:build');
  });

  it('workflow-graph.yaml 损坏（目录当文件读）→ 500 响亮失败（不静默 200）', () => {
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const root = tmpWorkspace(false);
    mkdirSync(join(root, '.cycles'), { recursive: true });
    // workflow-graph.yaml 是一个目录 → readFileSync EISDIR → 构建 throw → 500
    mkdirSync(join(root, '.cycles', 'workflow-graph.yaml'));
    const ctx = {
      webServer: {
        register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; },
      },
      workspaceRegistry: { list: (): Array<{ path: string }> => [{ path: root }] },
    };
    registerStepTraceRoute(ctx);
    const res = resStub();
    registered[0]?.handler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toContain('error');
  });
});
