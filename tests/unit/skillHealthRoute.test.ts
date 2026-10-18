/**
 * skillHealthRoute 单元测试（cycle-20 P3：HTTP 观测面）。
 *
 * 契约面（与 anic_status 工具同一份 analyzeSkillHealth 分析——单一事实源）：
 *   - 注册 exact 路由 + disposer 不丢弃；
 *   - 非 GET → 405；无可解析工作区 → 404；
 *   - 无 .cycles/无 tracker → 200 空态（totalInvocations: 0，不 500——
 *     「没有调用历史」是合法事实，与 snapshotRoute 的 404 语义不同：
 *     本路由的空态就是有效观测结果）；
 *   - 有 flow-tracker.json → 200 报告（scripts/totalInvocations/建议）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSkillHealthRoute, SKILL_HEALTH_ROUTE } from '../../src/host/routes/skillHealthRoute.ts';

const CLEANUPS: string[] = [];
function workspace(withTracker: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-health-'));
  if (withTracker) {
    mkdirSync(join(root, '.cycles'), { recursive: true });
    // 三条 gate-check 流（2 DONE + 1 FAILED）→ degraded 建议面非空
    writeFileSync(join(root, '.cycles', 'flow-tracker.json'), JSON.stringify({
      counter: 3,
      flows: [
        { flowId: 'gate-check-t1-1', script: 'gate-check', workspace: root, args: [], status: 'DONE', startedAt: '2026-10-17T01:00:00.000Z', endedAt: '2026-10-17T01:00:02.000Z', exitCode: 0, durationMs: 2000 },
        { flowId: 'gate-check-t2-2', script: 'gate-check', workspace: root, args: [], status: 'FAILED', startedAt: '2026-10-17T02:00:00.000Z', endedAt: '2026-10-17T02:00:03.000Z', exitCode: 1, durationMs: 3000 },
        { flowId: 'gate-check-t3-3', script: 'gate-check', workspace: root, args: [], status: 'DONE', startedAt: '2026-10-17T03:00:00.000Z', endedAt: '2026-10-17T03:00:01.000Z', exitCode: 0, durationMs: 1000 },
      ],
    }));
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

interface Captured { status: number | null; body: string | null }
function makeHarness(root: string | null): { registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>; call: (req: unknown) => Captured } {
  const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const ctx = {
    webServer: {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => {
        registered.push(r);
        return (): void => { /* disposers 被宿主承接 */ };
      },
    },
  };
  let disposed = 0;
  const disposers = registerSkillHealthRoute(ctx, {
    send: (res: unknown, status: number, body: unknown): void => {
      (res as { statusCode?: number }).statusCode = status;
      (res as { body?: unknown }).body = body;
    },
    getWorkspaceRoot: (): string | null => root,
  });
  expect(disposers).toHaveLength(1);
  // disposer 可安全调用（宿主承接语义）
  const d = disposers[0];
  if (typeof d === 'function') d();
  disposed += 1;
  expect(disposed).toBe(1);
  return {
    registered,
    call: (req: unknown): Captured => {
      const res: { statusCode?: number; body?: unknown } = {};
      registered[0]?.handler(req, res);
      return { status: res.statusCode ?? null, body: JSON.stringify(res.body ?? null) };
    },
  };
}

describe('registerSkillHealthRoute', () => {
  it('注册 exact 路由 + 返回 disposer（disposer 不丢弃）', () => {
    const h = makeHarness(workspace(false));
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0]?.kind).toBe('exact');
    expect(h.registered[0]?.path).toBe(SKILL_HEALTH_ROUTE);
  });

  it('无 webServer → 空数组（多代宿主安全降级）', () => {
    const out = registerSkillHealthRoute({}, { send: (): void => {}, getWorkspaceRoot: () => null });
    expect(out).toEqual([]);
  });

  it('非 GET → 405', () => {
    const h = makeHarness(workspace(true));
    const cap = h.call({ method: 'POST' });
    expect(cap.status).toBe(405);
    expect(cap.body).toContain('GET only');
  });

  it('无可解析工作区 → 404（错误码可 grep）', () => {
    const h = makeHarness(null);
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(404);
    expect(cap.body).toContain('ANIC_ROUTE_NO_WORKSPACE');
  });

  it('无 .cycles → 200 空态（totalInvocations: 0——没有调用历史是合法观测结果，不是 500）', () => {
    const h = makeHarness(workspace(false));
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body ?? '{}') as { totalInvocations: number; scripts: unknown[] };
    expect(body.totalInvocations).toBe(0);
    expect(body.scripts).toEqual([]);
  });

  it('有 flow-tracker 历史 → 200 报告：脚本行 + 总调用数 + 建议（degraded 语义贯通）', () => {
    const h = makeHarness(workspace(true));
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body ?? '{}') as {
      totalInvocations: number;
      overallSuccessRate: number;
      scripts: Array<{ script: string; level: string; total: number; successRate: number }>;
      suggestions: Array<{ id: string; severity: string }>;
    };
    expect(body.totalInvocations).toBe(3);
    // 2/3 成功率 < 0.8 → degraded（continuousLearning 阈值单一事实源）
    expect(body.scripts).toHaveLength(1);
    expect(body.scripts[0]?.script).toBe('gate-check');
    expect(body.scripts[0]?.level).toBe('degraded');
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0]?.id).toBe('fix-gate-check');
  });
});
