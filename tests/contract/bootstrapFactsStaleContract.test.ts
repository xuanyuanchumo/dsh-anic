/**
 * 自举事实基线**陈旧判定接线**契约（cycle-95 WS-A · O-94-04）。
 *
 * ## 被守卫的缺陷（复刻真实事故，不是假设）
 *
 * `GET /anic/self/status` 此前只 `loadBootstrapState(cyclesDir)` 然后原样 send：
 * 磁盘上 2026-10-28 的 `EXHAUSTED / evalScore 0 / 根因指向 cycle-83` 被当作
 * **当前事实**返回，而同一仓 10-30 的 cycle-88 评估与门禁实际全 PASS。两天里
 * 任何人问「自举收敛了吗」，拿到的都是比现实更旧的结论。
 *
 * 更糟的是 `diffFacts` / `factsDigest` / `activeVsArchived` 三个函数早已实现且
 * 单测全绿——但路由**零调用**，它们是不接线的死代码。"有实现"与"在判断里生效"
 * 是两件事，本契约检查的是后者。
 *
 * ## 判定口径（每条都对应一个可机器证伪的失败形态）
 *
 * ① 旧状态文件（**没有 facts 字段**）⇒ 必须 `stale:true`（未验证即陈旧）；
 * ② 状态文件 facts 与当前项目完全一致 ⇒ `stale:false`；
 * ③ 只有某一项变（gitHead）⇒ `stale:true` 且 `staleReasons` **精确点名**该项
 *    （多报与漏报都要红：多报让告警变噪声，漏报让旧结论继续冒充当前事实）；
 * ④ 响应必须带 `factsDigest`（16 位）且与当前事实自洽（`activeVsArchived`
 *    的输入也来自同一份当前事实——两份事实会让面板读数自相矛盾）；
 * ⑤ 归档只当历史：`activeVsArchived.evaluationInput` **只含活跃循环**，
 *    `archived` 单独计数。把 archive/ 算进活跃面 = 让归档的失败记录否决现在。
 * ⑥ 反向自检：把同一套判据喂给"完全相等"的存档，必须**不**报陈旧——
 *    否则 ①②③ 的绿灯可能只是"永远报陈旧"。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSelfBootstrapRoutes } from '../../src/host/routes/selfBootstrapRoute.ts';
import type { ProjectFacts } from '../../src/host/runtime/bootstrapFacts.ts';

/* ── 测试基建（与 zeroCoverageFiles 的自举段同形：捕获型 res + 路由表 ctx）── */

const TMPS: string[] = [];
afterEach(() => { while (TMPS.length > 0) rmSync(TMPS.pop() as string, { recursive: true, force: true }); });

function mkWs(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  TMPS.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function makeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) { captured.status = status; },
    setHeader() { /* 本契约不校验头 */ },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') {
        try { captured.body = JSON.parse(chunk); } catch { captured.body = chunk; }
      } else if (chunk !== undefined) captured.body = chunk;
    },
  };
  return { captured, res };
}

function sendFn(res: unknown, code: number, body: unknown): void {
  const r = res as { writeHead(s: number): void; end(c?: unknown): void };
  r.writeHead(code);
  r.end(JSON.stringify(body));
}

/**
 * 需要技能目录里的 `init-workflow.mjs` 哨兵：`resolveSelfTarget` 用它的存在性认
 * 技能目录（缺失即 404）。status 端点不跑前置守卫（只读），故够用。
 */
function makeCtx(ws: string) {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  return {
    routes,
    ctx: {
      webServer: {
        register(d: { path: string; handler: (req: unknown, res: unknown) => void }) {
          routes.set(d.path, d.handler);
          return () => { routes.delete(d.path); };
        },
      },
      workspaceRegistry: { list: () => [{ path: ws }] },
    },
  } as unknown as { ctx: Parameters<typeof registerSelfBootstrapRoutes>[0]; routes: Map<string, (req: unknown, res: unknown) => void> };
}

/** 造一个含技能哨兵 + 指定循环/归档的工作区；返回 GET status 的响应体。 */
function statusOf(ws: string): Record<string, unknown> {
  writeFile(ws, '.dsh/skills/ai-native-iteration-cycle/scripts/init-workflow.mjs', '// sentinel\n');
  const { ctx, routes } = makeCtx(ws);
  registerSelfBootstrapRoutes(ctx, sendFn);
  const { captured, res } = makeRes();
  routes.get('/anic/self/status')!({}, res);
  expect(captured.status).toBe(200);
  return captured.body as Record<string, unknown>;
}

/** 一个「事实齐全」的存档快照（供"完全一致 ⇒ 不陈旧"的正向路径）。 */
function storedFacts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    gitHead: null, gitDirty: null, currentCycle: null, currentPhase: null,
    ledgerHead: null, ledgerEntries: 0, ledgerValid: true, evalReport: null,
    activeCycles: 0, archivedCycles: 0, activeCycleNames: [], skillVersion: null,
    hasCyclesDir: true,
    ...over,
  };
}

/** 写自举前置（restart 走 guardPreconditions：缺 config / 缺 cycle 目录即 412）。 */
function writePrereqs(ws: string): void {
  mkdirSync(join(ws, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(ws, '.cycles', 'config.yml'),
    'build_cmd: "echo build"\ntest_cmd: "echo ok"\nlint_cmd: "echo lint"\n', 'utf-8');
  writeFile(ws, '.dsh/skills/ai-native-iteration-cycle/scripts/init-workflow.mjs', '// sentinel\n');
}

/** 调一个同步/微任务端点并返响应体（restart 走 readBody 的 Promise 路径）。 */
async function postRestart(ws: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ctx, routes } = makeCtx(ws);
  registerSelfBootstrapRoutes(ctx, sendFn);
  const { captured, res } = makeRes();
  routes.get('/anic/self/restart')!({ body }, res);
  await new Promise((r) => setTimeout(r, 30));
  expect(captured.status).toBe(200);
  return captured.body as Record<string, unknown>;
}

describe('POST /anic/self/restart — 写侧同样只认活跃面（cycle-95）', () => {
  it('重启落盘的 evaluationInput 只含活跃循环，归档不进评估输入', async () => {
    const ws = mkWs('anic-restart-input');
    writePrereqs(ws);
    mkdirSync(join(ws, '.cycles/cycles/cycle-89'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-83'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-84'), { recursive: true });

    const body = await postRestart(ws, { reason: 'test: archive isolation' });
    const state = body['state'] as Record<string, unknown>;
    // 写侧与读侧用同一个分列口径：重启的评估输入不得把归档算进来
    const input = state['evaluationInput'] as string[];
    expect(input, '归档进入了重启的评估输入面').toEqual(['cycle-1', 'cycle-89']);
    expect(input).not.toContain('cycle-83');
    // 摘要与存档时刻同场落盘（下一次 status 才能核对"这次重启基于哪份事实"）
    expect(state['factsDigest']).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof state['factsAt']).toBe('string');
  });

  it('重启后立刻查 status ⇒ stale:false（写读口径自洽，不是各算一套）', async () => {
    const ws = mkWs('anic-restart-roundtrip');
    writePrereqs(ws);
    await postRestart(ws, { reason: 'test: roundtrip' });
    const status = statusOf(ws);
    // 关键：写侧存的 facts 必须能被读侧守卫接受并判"未变"。若守卫过严或读侧另采一份，
    // 这里会立刻变 stale:true —— 那说明读写口径分叉（缺陷换个位置复发）。
    expect(status['stale'], '重启刚写入的基线被读成陈旧 ⇒ 写读口径分叉').toBe(false);
    expect(status['restartCount']).toBe(1);
  });
});

describe('GET /anic/self/status — 陈旧判定接线（cycle-95）', () => {
  it('① 旧状态文件（没有 facts）⇒ stale:true 且给出现采事实与摘要', () => {
    const ws = mkWs('anic-stale-nofacts');
    // 复刻真实事故形态：EXHAUSTED + evalScore 0 + 根因指向别处，且**没有** facts 键
    writeFile(ws, '.cycles/self-bootstrap.json', JSON.stringify({
      status: 'EXHAUSTED', round: 3, maxRounds: 3, lastEvalScore: 0, lastGateVerdict: 'FAIL',
      history: [{ round: 3, evalScore: 0, gateVerdict: 'FAIL', timestamp: '2026-10-28T05:30:15.591Z' }],
      lastFailure: { round: 3, evalScore: 0, gateVerdict: 'FAIL', reasons: ['G1: No task entries found'], timestamp: 't' },
    }));
    mkdirSync(join(ws, '.cycles/cycles/cycle-88'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-83'), { recursive: true });

    const body = statusOf(ws);
    // 状态本身照旧如实返回（历史结论是审计轨迹，不粉饰）
    expect(body['status']).toBe('EXHAUSTED');
    expect(body['lastEvalScore']).toBe(0);
    // 但"还作不作数"必须是 false —— 这是本契约的唯一要点
    expect(body['stale'], '没有存档事实必须判陈旧（未验证即陈旧）').toBe(true);
    expect(body['staleReasons']).toEqual(['facts']);
    // 现采事实与摘要必须同场出现（只报 stale 而不给现采事实 = 无法核对）
    expect(typeof body['facts']).toBe('object');
    expect(body['factsDigest']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('② 存档事实与当前项目完全一致 ⇒ stale:false（反向自检：判据不能恒报陈旧）', () => {
    const ws = mkWs('anic-stale-equal');
    mkdirSync(join(ws, '.cycles/cycles/cycle-88'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-83'), { recursive: true });
    // 先取一次"当前事实"，再把它原样写回状态文件 —— 形状与取值必须兼容
    const first = statusOf(ws)['facts'] as ProjectFacts;
    writeFile(ws, '.cycles/self-bootstrap.json', JSON.stringify({
      status: 'CONVERGED', round: 1, maxRounds: 3, lastEvalScore: 1, lastGateVerdict: 'PASS',
      history: [], facts: first, factsAt: '2026-10-31T00:00:00.000Z',
    }));
    const body = statusOf(ws);
    expect(body['status']).toBe('CONVERGED');
    expect(body['stale'], '事实完全一致却报陈旧 ⇒ 判定是"见到即报"').toBe(false);
    expect(body['staleReasons']).toEqual([]);
    expect(body['factsAt']).toBe('2026-10-31T00:00:00.000Z');
  });

  it('③ 单项变化（currentCycle）⇒ 精确点名该项，其余不得混入', () => {
    const ws = mkWs('anic-stale-one');
    mkdirSync(join(ws, '.cycles/cycles/cycle-88'), { recursive: true });
    const first = statusOf(ws)['facts'] as ProjectFacts;
    writeFile(ws, '.cycles/self-bootstrap.json', JSON.stringify({
      status: 'EXHAUSTED', round: 3, maxRounds: 3,
      // 存档里的循环与当前（cycle-88 已存在）不同 ⇒ 只该报 currentCycle
      facts: { ...first, currentCycle: 'cycle-83', currentPhase: null },
    }));
    const body = statusOf(ws);
    expect(body['stale']).toBe(true);
    expect(body['staleReasons'], '多报/漏报都必须红').toEqual(['currentCycle']);
  });

  it('④ 摘要与当前事实自洽：digest 由现采事实算出（不是存档摘要的复制）', () => {
    const ws = mkWs('anic-stale-digest');
    mkdirSync(join(ws, '.cycles/cycles/cycle-90'), { recursive: true });
    // 存档摘要故意写一个假值：响应里的历史摘要若被无脑转发，就会与 facts 脱钩
    writeFile(ws, '.cycles/self-bootstrap.json', JSON.stringify({
      status: 'IDLE', round: 0, maxRounds: 3, factsDigest: 'deadbeefdeadbeef',
    }));
    const body = statusOf(ws);
    expect(body['factsDigest']).not.toBe('deadbeefdeadbeef');
    expect(body['factsDigest']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('⑤ 归档只当历史：evaluationInput 只含活跃循环，archived 单独计数', () => {
    const ws = mkWs('anic-stale-archive');
    mkdirSync(join(ws, '.cycles/cycles/cycle-88'), { recursive: true });
    mkdirSync(join(ws, '.cycles/cycles/cycle-89'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-83'), { recursive: true });
    mkdirSync(join(ws, '.cycles/archive/cycle-84'), { recursive: true });

    const body = statusOf(ws);
    const split = body['activeVsArchived'] as { active?: string[]; archived?: number; total?: number; evaluationInput?: string[] };
    expect(split.active).toEqual(['cycle-88', 'cycle-89']);
    expect(split.archived).toBe(2);
    expect(split.total).toBe(4);
    expect(split.evaluationInput, '归档进入了评估输入面 ⇒ 历史失败会否决现在的结论').toEqual(['cycle-88', 'cycle-89']);
    expect(split.evaluationInput).not.toContain('cycle-83');
  });
});
