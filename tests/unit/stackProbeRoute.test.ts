/**
 * stackProbeRoute 单元测试（cycle-30 测试体系深挖）。
 *
 * 此前仅 routeWorkspaceCycle22 的 req 透传（404 早退）——行为分支零覆盖。
 * probeStack/configToYaml 的域逻辑已有 runtime.test 六用例（Node/Cargo/
 * Python/Go/generic/YAML 生成）——本测试只钉 HTTP 面胶水：
 *   - 注册 exact 路由 + disposer；
 *   - 无工作区 → 404；
 *   - Node 项目工作区 → 200 {stack:'node', configYaml 含 autonomy_level}。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStackProbeRoute } from '../../src/host/routes/stackProbeRoute.ts';

const CLEANUPS: string[] = [];
function nodeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-stackprobe-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
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
function makeHarness(root: string | null): { registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>; call: (req: unknown) => Captured } {
  const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const ctx = { webServer: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; } } };
  const disposer = registerStackProbeRoute(ctx, {
    send: (res: unknown, status: number, body: unknown): void => {
      (res as { statusCode?: number }).statusCode = status;
      (res as { body?: unknown }).body = body;
    },
    getWorkspaceRoot: (): string | null => root,
  });
  expect(typeof disposer).toBe('function');
  expect(registered).toHaveLength(1);
  expect(registered[0]?.path).toBe('/anic/api/stack-probe');
  return {
    registered,
    call: (req: unknown): Captured => {
      const res: { statusCode?: number; body?: unknown } = {};
      registered[0]?.handler(req, res);
      return { status: res.statusCode ?? null, body: JSON.stringify(res.body ?? null) };
    },
  };
}

describe('registerStackProbeRoute', () => {
  it('无 webServer → null（多代宿主安全降级）', () => {
    expect(registerStackProbeRoute({}, { send: (): void => {}, getWorkspaceRoot: (): string | null => null })).toBeNull();
  });

  it('无可解析工作区 → 404 no workspace', () => {
    const h = makeHarness(null);
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(404);
    expect(cap.body).toContain('no workspace');
  });

  it('Node 项目 → 200 探测结果 + configYaml（autonomy_level 建议配置）', () => {
    const h = makeHarness(nodeWorkspace());
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(200);
    expect(cap.body).toContain('node');
    expect(cap.body).toContain('configYaml');
    expect(cap.body).toContain('autonomy_level');
  });
});
