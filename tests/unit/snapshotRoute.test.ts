/**
 * snapshotRoute + 宿主入口 apply 单元测试。
 *
 * 契约锚点（全部转录自父工程与 DSH 宿主语义，见文件头注释）：
 *   - 路由注册形如 { kind:'exact', path, handler }，经 ctx.effect 承接 disposer
 *     （disposer 不丢弃 = 九条红线；宿主 effect 返回值即清理）；
 *   - 工作区解析链 registry → sessions.header.cwd → process.cwd()，逐请求重解析；
 *   - 200 响应带 no-store + CORS + X-ANIC-Snapshot-Digest；无 .cycles → 404（不是 500）；
 *   - 无 webServer → 返回 null（插件主体不受影响，多代宿主安全降级）；
 *   - apply()：有 effect 走 effect（label 声明 M1 四条路由），无 effect 直接注册。
 *
 * M1 演进说明（本文件的更新理由）：apply() 原先只注册 snapshotRoute 一条路由，M1 全功能面
 * 落地后改为经 routes/index.ts 的 registerAnicRoutes 聚合注册四条
 * （workflow-snapshot / step-trace / self-check / self/init）。**不变量不变**：
 * setup 仍在 effect 内执行、effect 返回的聚合 disposer 仍被宿主承接、且必须一次清干净
 * 全部 webServer 注册（本文件用 toHaveBeenCalledTimes(4) 把"逐个清"钉死，
 * 而不是只看"清过一次"——后者在聚合器只清第一条时会假绿）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSnapshotRoute, SNAPSHOT_ROUTE } from '../../src/host/snapshotRoute.ts';
import { STEP_TRACE_ROUTE } from '../../src/host/routes/stepTraceRoute.ts';
import { SELF_CHECK_ROUTE } from '../../src/host/routes/selfCheckRoute.ts';
import { SELF_INIT_ROUTE } from '../../src/host/routes/selfInitRoute.ts';
import { apply } from '../../src/index.ts';

const CLEANUPS: string[] = [];
function workspaceWithCycles(hasCycles: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-ws-'));
  if (hasCycles) {
    const cycles = join(root, '.cycles');
    mkdirSync(cycles, { recursive: true });
    writeFileSync(join(cycles, 'config.yml'), 'autonomy_level: L2\n');
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

interface CapturedResponse { status: number | null; headers: Record<string, string> | null; body: string | null }
function makeRes(): { res: unknown; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: null, headers: null, body: null };
  const res = {
    writeHead: (status: number, headers: Record<string, string>): void => { captured.status = status; captured.headers = headers; },
    end: (data?: string): void => { captured.body = data ?? null; },
  };
  return { res, captured };
}

interface RegisteredDef { kind: string; path: string; handler: (req: unknown, res: unknown) => void }
interface CtxSpec {
  root?: string;
  registryThrows?: boolean;
  withSessions?: boolean;
  disposerWorks?: boolean;
}
function makeCtx(spec: CtxSpec): { ctx: unknown; registered: RegisteredDef[]; webServerDisposer: () => void } {
  const registered: RegisteredDef[] = [];
  const webServerDisposer = vi.fn();
  const ctx: Record<string, unknown> = {
    webServer: {
      register: (...args: unknown[]): (() => void) => {
        // 两种调用形态：对象 {kind,path,handler} 或三参 (method,path,handler)
        if (typeof args[0] === 'object' && args[0] !== null) {
          registered.push(args[0] as RegisteredDef);
        } else if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          registered.push({ kind: 'exact', path: args[1] as string, handler: args[2] as (req: unknown, res: unknown) => void });
        }
        return spec.disposerWorks === false ? undefined : webServerDisposer;
      },
    },
  };
  if (spec.root !== undefined) {
    if (spec.registryThrows) {
      ctx.workspaceRegistry = { list: (): unknown[] => { throw new Error('registry not mounted'); } };
    } else {
      ctx.workspaceRegistry = { list: (): { path?: string }[] => [{ path: spec.root }] };
    }
    if (spec.withSessions) ctx.sessions = { list: (): { header?: { cwd?: string } }[] => [{ header: { cwd: 'D:\\must-not-be-used' } }] };
  }
  return { ctx, registered, webServerDisposer };
}

describe('registerSnapshotRoute', () => {
  it('注册 exact 路由并返回 webServer 的 disposer（disposer 不丢弃）', () => {
    const { ctx, registered, webServerDisposer } = makeCtx({ root: workspaceWithCycles(true) });
    const disposer = registerSnapshotRoute(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.kind).toBe('exact');
    expect(registered[0]?.path).toBe(SNAPSHOT_ROUTE);
    expect(disposer).toBe(webServerDisposer);
  });

  it('无 webServer 时返回 null（跳过而非崩溃）', () => {
    expect(registerSnapshotRoute({})).toBeNull();
    expect(registerSnapshotRoute({ webServer: {} })).toBeNull();
  });

  it('200：no-store + 16 位内容指纹 + 快照计数；无 Origin 时**不发** CORS 头（P0-8）', () => {
    const root = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler({}, res);
    expect(captured.status).toBe(200);
    expect(captured.headers?.['Cache-Control']).toBe('no-store');
    // P0-8：同源请求不需要 CORS 头；通配符 `*` 已被彻底移除（跨站读取面关闭）
    expect(captured.headers?.['Access-Control-Allow-Origin']).toBeUndefined();
    expect(captured.headers?.['X-ANIC-Snapshot-Digest']).toMatch(/^[0-9a-f]{16}$/);
    const body = JSON.parse(captured.body ?? '{}') as { counts: { nodes: number }; autonomy: string };
    expect(body.counts.nodes).toBeGreaterThan(0);
    expect(body.autonomy).toBe('L2');
  });

  it('工作区无 .cycles → 404（未 init 项目是可用状态，不是错误）', () => {
    const root = workspaceWithCycles(false);
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler({}, res);
    expect(captured.status).toBe(404);
    expect(String((JSON.parse(captured.body ?? '{}') as { error: string }).error)).toContain('no .cycles');
  });

  it('解析链：registry 优先于 sessions；registry 抛错落 sessions；两者皆无落 process.cwd', () => {
    const root = workspaceWithCycles(true);
    const mk = (over: { registry?: unknown; sessions?: unknown }): { ctx: unknown; registered: RegisteredDef[] } => {
      const base = makeCtx({ root });
      if ('registry' in over) (base.ctx as Record<string, unknown>).workspaceRegistry = over.registry;
      if ('sessions' in over) (base.ctx as Record<string, unknown>).sessions = over.sessions;
      registerSnapshotRoute(base.ctx);
      return base;
    };
    const ask = (registered: RegisteredDef[]): CapturedResponse => {
      const { res, captured } = makeRes();
      registered[0]?.handler({}, res);
      return captured;
    };
    const wsOf = (c: CapturedResponse): string => decodeURIComponent(String(c.headers?.['X-ANIC-Workspace']));

    // ① 优先级：registry 与 sessions 同在 → registry 赢（sessions 指向必不可能有效的路径作哨兵）
    const prio = mk({ sessions: { list: (): { header?: { cwd?: string } }[] => [{ header: { cwd: 'D:\\must-not-be-used' } }] } });
    expect(ask(prio.registered).status).toBe(200);
    expect(wsOf(ask(prio.registered))).toBe(root);

    // ② registry 抛错 → sessions 兜底（根换成 sessions 提供的另一个有效工作区）
    const root2 = workspaceWithCycles(true);
    const viaSessions = mk({
      registry: { list: (): unknown[] => { throw new Error('registry not mounted'); } },
      sessions: { list: (): { header?: { cwd?: string } }[] => [{ header: { cwd: root2 } }] },
    });
    expect(ask(viaSessions.registered).status).toBe(200);
    expect(wsOf(ask(viaSessions.registered))).toBe(root2);

    // ③ 两者皆无 → process.cwd（用无 .cycles 的临时目录作 cwd → 404 且 workspace=cwd）
    const emptyCwd = mkdtempSync(join(tmpdir(), 'anic-empty-'));
    const origCwd = process.cwd();
    process.chdir(emptyCwd);
    try {
      const viaCwd = mk({ registry: { list: (): unknown[] => { throw new Error('registry not mounted'); } } });
      delete (viaCwd.ctx as Record<string, unknown>).sessions;
      const c3 = ask(viaCwd.registered);
      expect(c3.status).toBe(404);
      expect((JSON.parse(c3.body ?? '{}') as { workspace: string }).workspace).toBe(emptyCwd);
    } finally {
      process.chdir(origCwd);
      rmSync(emptyCwd, { recursive: true, force: true }); // F-T2：原先泄漏 anic-empty-*
    }
  });

  it('构建器抛错 → 500 且带 error 字段（响亮失败，不静默 200）', () => {
    const root = workspaceWithCycles(true);
    // workflow-graph.yaml 是目录 → readFileSync EISDIR（existsSync 通过而读取抛错）
    mkdirSync(join(root, '.cycles', 'workflow-graph.yaml'));
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler({}, res);
    expect(captured.status).toBe(500);
    expect(String((JSON.parse(captured.body ?? '{}') as { error: string }).error)).toMatch(/EISDIR|EPERM|operation/i);
  });
});

describe('V-1 ETag 条件请求（cycle-38 · doc11 §5 承诺收口）', () => {
  const reqWithInm = (etag: string | null): unknown =>
    etag === null ? { headers: {} } : { headers: { 'if-none-match': `"${etag}"` } };

  /** 拉一次完整响应，学得 ETag 与 digest（两者同指纹）。 */
  function firstFetch(root: string): { ctx: unknown; registered: RegisteredDef[]; etag: string } {
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler({}, res);
    const etag = String(captured.headers?.['ETag'] ?? '').replace(/^"|"$/g, '');
    return { ctx, registered, etag };
  }

  it('200 响应带 ETag 头（与 X-ANIC-Snapshot-Digest 同指纹，双通道一致）', () => {
    const root = workspaceWithCycles(true);
    const { etag } = firstFetch(root);
    expect(etag).toMatch(/^[0-9a-f]{16}$/);
  });

  it('If-None-Match 命中 → 304 空体 + ETag/Workspace 头保留（条件请求语义收益本体）', () => {
    const root = workspaceWithCycles(true);
    const { registered, etag } = firstFetch(root);
    const { res, captured } = makeRes();
    registered[0]?.handler(reqWithInm(etag), res);
    expect(captured.status).toBe(304);
    expect(captured.body).toBe('null'); // sendJson JSON.stringify(null)——空体形态（不重发快照）
    expect(String(captured.headers?.['ETag'])).toBe(`"${etag}"`);
    expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(root);
  });

  it('指纹稳定：两次请求（generatedAt 必不同）的 ETag 全等——语义指纹排除时间戳', () => {
    const root = workspaceWithCycles(true);
    const a = firstFetch(root);
    const { res, captured } = makeRes();
    a.registered[0]?.handler({}, res);
    const etag2 = String(captured.headers?.['ETag'] ?? '').replace(/^"|"$/g, '');
    expect(etag2).toBe(a.etag); // generatedAt 不同但指纹相同（304 短路的前提）
  });

  it('If-None-Match 不匹配（数据已变）→ 200 全量响应（条件请求不吞数据更新）', () => {
    const root = workspaceWithCycles(true);
    const { registered } = firstFetch(root);
    const { res, captured } = makeRes();
    registered[0]?.handler(reqWithInm('deadbeefdeadbeef'), res);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? '{}') as { counts: { nodes: number } };
    expect(body.counts.nodes).toBeGreaterThan(0);
  });

  it('数据真变（ledger 追加）→ 指纹变 → 旧 ETag 不再命中（缓存失效诚实）', () => {
    const root = workspaceWithCycles(true);
    const a = firstFetch(root);
    // 追加账本事件 → 快照多一个 event 节点 → 语义指纹必变
    mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), JSON.stringify({ entries: [
      { gate: 'G0', result: 'PASS' }, { gate: 'G1', result: 'PASS' },
    ] }));
    const { res, captured } = makeRes();
    a.registered[0]?.handler(reqWithInm(a.etag), res);
    expect(captured.status).toBe(200); // 旧指纹不命中 → 全量
    const etag2 = String(captured.headers?.['ETag'] ?? '').replace(/^"|"$/g, '');
    expect(etag2).not.toBe(a.etag);
  });

  it('无 If-None-Match 头 → 永远 200（老客户端零行为变化）', () => {
    const root = workspaceWithCycles(true);
    const { registered } = firstFetch(root);
    for (const req of [{}, { headers: {} }, { headers: { 'if-none-match': '' } }, undefined]) {
      const { res, captured } = makeRes();
      registered[0]?.handler(req, res);
      expect(captured.status).toBe(200);
    }
  });
});

describe('X-ANIC-Workspace 请求头（P2 桌面多会话纠偏）', () => {
  const reqWith = (ws: string | null): unknown =>
    ws === null ? {} : { headers: { 'x-anic-workspace': encodeURIComponent(ws) } };

  it('请求头声明的已知工作区被采信（优先于 registry 首条）', () => {
    const first = workspaceWithCycles(true);
    const second = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root: first });
    // sessions 额外知道第二个工作区 → 头声明的 second 命中合法集
    (ctx as Record<string, unknown>).sessions = { list: (): { header?: { cwd?: string } }[] => [{ header: { cwd: second } }] };
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler(reqWith(second), res);
    expect(captured.status).toBe(200);
    expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(second);
  });

  it('头声明未知路径但确实含 .cycles → 采信（单会话宿主 registry 只报一个的场景）', () => {
    const known = workspaceWithCycles(true);
    const claimed = workspaceWithCycles(true); // registry/sessions 均不知道它
    const { ctx, registered } = makeCtx({ root: known });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler(reqWith(claimed), res);
    expect(captured.status).toBe(200);
    expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(claimed);
  });

  it('头声明未知路径且无 .cycles → 静默回落 registry（不是任意路径入口）', () => {
    const known = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root: known });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler(reqWith('Z:\\__anic_nonexistent__'), res);
    expect(captured.status).toBe(200);
    expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(known);
  });

  it('无头 / 空头 → 原解析链不变（向后兼容）', () => {
    const root = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    for (const req of [undefined, {}, { headers: {} }, { headers: { 'x-anic-workspace': '' } }]) {
      const { res, captured } = makeRes();
      registered[0]?.handler(req, res);
      expect(captured.status).toBe(200);
      expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(root);
    }
  });

  it('头值数组形态取首个（Node IncomingMessage 的罕见但合法形态）', () => {
    const root = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root });
    registerSnapshotRoute(ctx);
    const { res, captured } = makeRes();
    registered[0]?.handler({ headers: { 'x-anic-workspace': [encodeURIComponent(root)] } }, res);
    expect(captured.status).toBe(200);
    expect(decodeURIComponent(String(captured.headers?.['X-ANIC-Workspace']))).toBe(root);
  });
});

describe('宿主入口 apply', () => {
  /** 全部路由（M1 四条 + M2-a 九条 + M2-b 四条 + M4 一条 + M5 四条 + M5-a 四条 + M7 四条 + M8 四条 + cycle-97 一条 + cycle-72 闭环体检一条）。 */
  const ALL_ROUTES = [
    SNAPSHOT_ROUTE, STEP_TRACE_ROUTE, SELF_CHECK_ROUTE, SELF_INIT_ROUTE,
    // cycle-97 动态白盒数据面
    '/anic/api/invocations/live',
    // cycle-72 T-7207 闭环体检（注册↔生产↔消费 三态矩阵）只读面
    '/anic/api/closure-audit',
    // cycle-80：热更新重载运维通道（POST /anic/api/reload，ctx.hmr 的 HTTP 消费面）
    '/anic/api/reload',
    '/anic/cycle/init', '/anic/cycle/advance', '/anic/cycle/close', '/anic/cycle/state', '/anic/cycle/list',
    '/anic/api/ledger', '/anic/api/ledger/append', '/anic/api/ledger/verify',
    '/anic/api/stack-probe',
    '/anic/api/seg-ledger', '/anic/api/seg-ledger/append', '/anic/api/seg-ledger/verify', '/anic/api/seg-ledger/init',
    '/anic/review',
    '/anic/api/trust', '/anic/api/autonomy', '/anic/api/breakers', '/anic/api/tech-debt',
    // cycle-16 G-C3：tech-debt 消费侧（GET list 读面 + consume 记账写面）
    '/anic/api/tech-debt/list', '/anic/api/tech-debt/consume',
    // R3 阶段 1 余量：证据化自主级回退（技能 cmdAutoFallback 插件等价物）
    '/anic/autonomy/downgrade',
    '/anic/governance/archive', '/anic/governance/budget', '/anic/governance/sweep', '/anic/governance/prune',
    // M7 自举闭环
    '/anic/self/evaluate', '/anic/self/gate-check', '/anic/self/iterate', '/anic/self/status',
    // M8 跨项目技能调用
    '/anic/skill/list', '/anic/skill/invoke', '/anic/evaluate', '/anic/iterate',
    // M11 技能内联 + 原生脚本；cycle-19 eco P0 新增 repair（doctor 语义并入 status）
    '/anic/skill/install', '/anic/skill/status', '/anic/skill/repair',
    // cycle-20 P3：技能健康观测面（FlowTracker 调用历史 → analyzeSkillHealth）
    '/anic/skill/health',
    '/anic/hitl-audit', '/anic/band-detect', '/anic/org-status', '/anic/fact-base', '/anic/plan-sync', '/anic/multi-agent-gate', '/anic/fix-loop',
    // M11 双向自举
    '/anic/self/dual-evaluate', '/anic/self/dual-advance', '/anic/self/dual-status',
    // M11 真实性审计
    '/anic/api/truth-audit',
    // cycle-16 G-C5：跨项目路由响应新增 bootstrapSync 字段（路由本身既有，此注释标记行为变化）
    // R3 阶段 2：flows 域（流程状态流转机观测面 + 运行面）
    '/anic/flows', '/anic/flows/status', '/anic/flows/state', '/anic/flows/gate-check/run',
    '/anic/flows/macro-phase/status', '/anic/flows/macro-phase/advance',
    '/anic/flows/archive/run',
    '/anic/flows/hitl/run',
    '/anic/flows/auto-fix/run',
  ];

  it('有 effect：setup 经 effect 执行并带 label；effect 的返回 disposer 由宿主承接', () => {
    const root = workspaceWithCycles(true);
    const { ctx, registered, webServerDisposer } = makeCtx({ root });
    const effect = vi.fn((fn: () => unknown, label?: string): unknown => {
      const routeDisposer = fn() as unknown;
      return (): void => { if (typeof routeDisposer === 'function') (routeDisposer as () => void)(); };
    });
    (ctx as Record<string, unknown>).effect = effect;
    apply(ctx);
    // cycle-74：5 层 = skill(cycle-97) + routes + tools + flows(R3 阶段 2) + 工具面按需加载接线。
    // 末层在默认 full 模式下**不注册任何监听器**（内部直接返回），零行为变更。
    // cycle-80：+1 = 热更新握手（finalize in-flight + 冷启动 staleness 记录）⇒ 6 层。
    expect(effect).toHaveBeenCalledTimes(6);
    // label 必须点明是聚合注册（少一层即功能面缺失）
    expect(effect.mock.calls[0]?.[1]).toContain('dsh-anic: runtime skill');
    expect(effect.mock.calls[1]?.[1]).toContain('dsh-anic: routes');
    // cycle-74 P0：路由改由独立子 fiber 承接（label 随实现更新）；子插件内部仍走聚合器。
    expect(effect.mock.calls[1]?.[1]).toContain('child fiber');
    expect(effect.mock.calls[3]?.[1]).toContain('dsh-anic: builtin flows');
    expect(effect.mock.calls[4]?.[1]).toContain('dsh-anic: tool disclosure');
    // cycle-80：末层是热更新握手——它必须独立成层，不能塞进工具面接线（观测性 ≠ 功能开关）。
    expect(effect.mock.calls[5]?.[1]).toContain('hot-reload handshake');
    // M1 全功能面：四条路由一次注册齐（少一条即功能面缺失）
    expect(registered.map((r) => r.path).sort()).toEqual([...ALL_ROUTES].sort());
    // effect 返回的清理被宿主拿走：调用 ROUTES 层（results[1]）必须**逐个**清掉
    // 全部注册，而不是只清第一条（聚合器 filter 掉 null 后逐个调用）。
    // results[0] 是 cycle-97 的技能注册层（stub 宿主无 skills → 空清理，另有断言）。
    (effect.mock.results[1]?.value as () => void)();
    expect(webServerDisposer).toHaveBeenCalledTimes(ALL_ROUTES.length);
    // 技能层清理可安全调用（registerRuntimeSkill 返回 null 时不得产生"非函数"爆炸）
    expect(() => { (effect.mock.results[0]?.value as () => void)(); }).not.toThrow();
    // flows 层清理同样安全（registerBuiltinFlows 返回 disposer；重复清理幂等）
    expect(() => { (effect.mock.results[3]?.value as () => void)(); }).not.toThrow();
  });

  it('无 effect：直接注册（不静默丢弃，异常宿主形态兜底）', () => {
    const root = workspaceWithCycles(true);
    const { ctx, registered } = makeCtx({ root });
    apply(ctx);
    expect(registered).toHaveLength(ALL_ROUTES.length);
    expect(registered.map((r) => r.path).sort()).toEqual([...ALL_ROUTES].sort());
  });
});
