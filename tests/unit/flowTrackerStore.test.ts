/**
 * flow-tracker **双层存储**契约（cycle-91）—— append-only 历史 + 路由级 counter 口径。
 *
 * ## 为什么钉这些
 *
 * cycle-90 收口台账 O-90-04 登记：「flow-tracker 容量 200 滚动淘汰 ⇒ 统计偏差」。
 * 本轮**治本**：终态记录同时 append 进 `flow-history.jsonl`，滚动淘汰
 * **不再丢数据**。
 *
 * 更重要的是**本轮实测抓到的第二个缺陷**（cycle-90 声称已接线，实际集成层断了）：
 *
 * ```
 * lifecycleMetricsRoute.ts（修复前）：
 *   truncationInfo({ flows, counter: flows.length })   // ⇒ evicted 恒为 0
 * ```
 *
 * ⇒ **截断徽标永远不出现**。而单元测试**全部绕过了路由层**
 * （直接调 `buildLifecycleMetrics(flows, [], truncationInfo(...))` 手工传 counter），
 * 所以这个缺陷从未被任何用例覆盖 ⇒ **单元绿、集成断**。
 *
 * ⇒ 本文件专门补**路由级**回归（真注册、真请求、真读磁盘）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendHistory,
  finishFlow,
  initialFlowTrackerState,
  loadAllFlowRecords,
  loadFlowTracker,
  readHistoryAll,
  saveFlowTracker,
  startFlow,
} from '../../src/host/runtime/flowTracker.ts';
import { registerLifecycleMetricsRoute } from '../../src/host/routes/lifecycleMetricsRoute.ts';

let dir = '';
let cycles = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anic-flowstore-'));
  // 路由用的是 `${root}/.cycles` ⇒ tracker 必须落在 `dir/.cycles`。
  cycles = join(dir, '.cycles');
  mkdirSync(cycles, { recursive: true });
});
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** 跑一条完整流程（start → finish），返回终态记录。 */
function runOne(script = 'gate-check', workspace = 'D:/w'): void {
  const s0 = loadFlowTracker(cycles);
  const { state: s1, flowId } = startFlow(cycles, s0, script, workspace, ['--gate', 'G0']);
  finishFlow(cycles, s1, flowId, { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 42 });
}

describe('flow-tracker 双层存储：append-only 历史', () => {
  it('终态记录进历史文件（append-only，一行一条）', () => {
    runOne();
    const raw = readFileSync(join(cycles, 'flow-history.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { flowId: string; status: string; durationMs: number };
    expect(parsed.status).toBe('DONE');
    expect(parsed.durationMs).toBe(42);
  });

  it('历史累积：多条流程各占一行，顺序=时间顺序', () => {
    runOne('eval-runner');
    runOne('gate-check');
    runOne('init-cycle');
    const all = readHistoryAll(cycles);
    expect(all).toHaveLength(3);
    expect(all.map((f) => f.script)).toEqual(['eval-runner', 'gate-check', 'init-cycle']);
  });

  it('**热窗口淘汰后历史仍在**（治本的核心断言）', () => {
    // 造 250 条 ⇒ 超出 MAX_WINDOW(200) ⇒ 热窗口滚掉 50 条。
    let state = initialFlowTrackerState();
    for (let i = 0; i < 250; i++) {
      const r = startFlow(cycles, state, 'eval-runner', 'D:/w', ['--i', String(i)]);
      state = finishFlow(cycles, r.state, r.flowId, {
        exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: i,
      });
    }
    const hot = loadFlowTracker(cycles);
    expect(hot.flows.length, '热窗口应被裁剪到 200').toBe(200);
    expect(hot.counter, 'counter 应为累计写入数 250').toBe(250);
    // 历史一条没丢。
    const hist = readHistoryAll(cycles);
    expect(hist.length, '历史必须保留全部 250 条（不丢数据）').toBe(250);
    // 热窗口里的 200 条是历史的子集（内容一致）。
    const histById = new Map(hist.map((f) => [f.flowId, f]));
    for (const f of hot.flows) {
      expect(histById.get(f.flowId)).toEqual(f);
    }
  });

  it('全量样本 = 历史 ∪ 热窗口（迁移前记录不丢）', () => {
    // 模拟"迁移前"：只有热窗口里有记录，没有历史文件。
    const legacy = {
      flowId: 'legacy-1', script: 'gate-check', workspace: 'D:/w', args: [],
      status: 'DONE' as const, startedAt: '2026-10-01T00:00:00.000Z',
      endedAt: '2026-10-01T00:00:01.000Z', exitCode: 0, durationMs: 1000,
    };
    saveFlowTracker(cycles, { flows: [legacy], counter: 1 });
    // 再跑一条新流程（进历史）。
    runOne();
    const all = loadAllFlowRecords(cycles);
    expect(all.length, '迁移前记录 + 新记录 都在').toBe(2);
    expect(all.map((f) => f.flowId)).toContain('legacy-1');
  });

  it('坏行跳过而不整体失败（追加写崩溃留半行）', () => {
    runOne();
    // 追加一个半条 JSON（模拟崩溃）。
    writeFileSync(join(cycles, 'flow-history.jsonl'), '{"flowId":"broken"\n', { flag: 'a' });
    const all = readHistoryAll(cycles);
    expect(all.length, '坏行应被跳过，好行保留').toBe(1);
  });

  it('历史文件不存在时返回空数组（不抛）', () => {
    expect(readHistoryAll(cycles)).toEqual([]);
  });
});

describe('flow-tracker 持久化：v1 向后兼容', () => {
  it('v1 文件（无 version 字段）仍可读，counter 语义一致', () => {
    writeFileSync(join(cycles, 'flow-tracker.json'), JSON.stringify({
      flows: [{ flowId: 'a', script: 'x', workspace: 'D:/w', args: [], status: 'DONE', startedAt: '2026-10-01T00:00:00.000Z' }],
      counter: 7,
    }));
    const s = loadFlowTracker(cycles);
    expect(s.flows).toHaveLength(1);
    expect(s.counter).toBe(7);
  });

  it('新写文件带 version 字段', () => {
    runOne();
    const parsed = JSON.parse(readFileSync(join(cycles, 'flow-tracker.json'), 'utf8')) as { version?: number };
    expect(parsed.version).toBe(2);
  });
});

describe('生命周期指标路由：counter 口径（cycle-91 实测缺陷的回归）', () => {
  /** 注册路由并造一个能捕获响应的桩宿主。 */
  function mount(workspaceRoot: string): { call: () => Promise<{ code: number; body: Record<string, unknown> }> } {
    let handler: ((req: unknown, res: unknown) => void) | undefined;
    const ctx = {
      webServer: {
        register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
          if (route.path === '/anic/api/flows/lifecycle') handler = route.handler;
          return () => { /* disposer */ };
        },
      },
    };
    let lastResponse: { code: number; body: Record<string, unknown> } = { code: 0, body: {} };
    const send = (_res: unknown, code: number, body: unknown): void => { lastResponse = { code, body: body as Record<string, unknown> }; };
    registerLifecycleMetricsRoute(ctx, send, { getWorkspaceRoot: () => workspaceRoot });
    return {
      call: async () => {
        if (!handler) throw new Error('路由未注册');
        handler({}, {});
        return lastResponse;
      },
    };
  }

  it('**治本后：热窗口淘汰 250⇒200，但统计样本不缺** ⇒ 无假警告', async () => {
    // 造 250 条 ⇒ 热窗口裁到 200、counter=250。
    let state = initialFlowTrackerState();
    for (let i = 0; i < 250; i++) {
      const r = startFlow(cycles, state, 'eval-runner', dir, ['--i', String(i)]);
      state = finishFlow(cycles, r.state, r.flowId, {
        exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: i,
      });
    }
    const route = mount(dir);
    const res = await route.call();
    expect(res.code).toBe(200);
    const win = res.body['window'] as {
      everWritten: number; retained: number; evicted: number;
      truncated: boolean; truncationWarning: string | null; sampleComplete: boolean;
    };
    // 曾写过 250 条。
    expect(win.everWritten).toBe(250);
    // **统计样本 250 条一条不缺**（append-only 历史保全）——这是治本的直接效果。
    expect(win.retained, '样本应保全全部 250 条（历史层）').toBe(250);
    expect(win.evicted, '样本不缺 ⇒ evicted=0（修复前此处是 50 且语义错误）').toBe(0);
    expect(win.truncated, '样本完整 ⇒ 不该报截断').toBe(false);
    expect(win.sampleComplete, '历史层可用 ⇒ 完整性已被证明').toBe(true);
    // 样本完整 ⇒ 不给"假警告"。
    expect(win.truncationWarning).toBeNull();
  });

  it('**历史层不可用时诚实报缺口**（样本不完整 ⇒ 徽标出现）', async () => {
    // 只写热窗口、**不**写历史（模拟迁移前 / 历史文件缺失）。
    let state = initialFlowTrackerState();
    for (let i = 0; i < 250; i++) {
      const r = startFlow(cycles, state, 'eval-runner', dir, ['--i', String(i)]);
      state = finishFlow(cycles, r.state, r.flowId, {
        exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: i,
      });
    }
    // 删掉历史文件 ⇒ 样本只剩热窗口的 200 条 ⇒ 缺 50 条。
    rmSync(join(cycles, 'flow-history.jsonl'), { force: true });
    const route = mount(dir);
    const res = await route.call();
    const win = res.body['window'] as {
      retained: number; evicted: number; truncated: boolean;
      truncationWarning: string | null; sampleComplete: boolean;
    };
    expect(win.retained).toBe(200);
    expect(win.evicted, '历史缺失 ⇒ 样本缺 50 条（诚实报告）').toBe(50);
    expect(win.truncated).toBe(true);
    expect(win.sampleComplete, '历史层不可用 ⇒ 完整性未被证明').toBe(false);
    expect(win.truncationWarning, '样本不完整 ⇒ 必须有告警').not.toBeNull();
  });

  it('未截断时徽标为 null（不误报）', async () => {
    runOne('gate-check', dir);
    const route = mount(dir);
    const res = await route.call();
    const win = res.body['window'] as { evicted: number; truncated: boolean };
    expect(win.evicted).toBe(0);
    expect(win.truncated).toBe(false);
  });

  it('拿不到工作区 ⇒ 500（fail-closed，绝不返回全项目流）', async () => {
    const ctx = {
      webServer: {
        register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
          void route; return () => { /* disposer */ };
        },
      },
    };
    let captured: ((req: unknown, res: unknown) => void) | undefined;
    let lastResponse: { code: number; body: unknown } = { code: 0, body: {} };
    registerLifecycleMetricsRoute(ctx, (_r, code, body) => { lastResponse = { code, body }; }, {
      getWorkspaceRoot: () => null,
    });
    void captured;
    // 真调用一次（桩宿主注册了路由）。
    const ctx2 = {
      webServer: {
        register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
          captured = route.handler; return () => { /* disposer */ };
        },
      },
    };
    registerLifecycleMetricsRoute(ctx2, (_r, code, body) => { lastResponse = { code, body }; }, {
      getWorkspaceRoot: () => null,
    });
    captured?.({}, {});
    expect(lastResponse.code, '拿不到工作区必须 500').toBe(500);
    expect(lastResponse.body).toEqual({ error: 'ANIC_ROUTE_NO_WORKSPACE' });
  });
});
