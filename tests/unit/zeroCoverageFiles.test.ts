/**
 * 零直测文件第三轮收口（cycle-36）——真实缺口 5 文件的行为级直测。
 *
 * 摸底结论（T-3601）：skillInvokerAsync 已由 invokeSkillAsync.test.ts 覆盖（cycle-30）；
 * gateTypes 是纯类型文件；truthAuditChecks 正路径已由 truthAudit.test.ts 覆盖（真插件目录），
 * 本文件补负路径夹具。真实缺口：
 *  - graphDataTable / workflowGraphData（图形域文本替代 + 嵌入快照契约）
 *  - gateCheckRunners（script 侧解析 + native 入账去重 + env 覆盖优先级）
 *  - truthAuditChecks（负路径：目录/文件缺失、超长文件、无注册路由）
 *  - flowsRoute（9 路由观测面 + 参数校验 + 状态码语义）
 *  - selfBootstrapRoute（4 路由：evaluate/gate-check/iterate/status 状态机推进）
 *
 * 测试基建注意：resolveSkillScriptsDir 的回落链含 process.cwd() 候选——本仓库
 * 自身装有 .dsh/skills（cycle-31 实弹安装），「技能目录缺失」路径在 cwd 环境下
 * 不可达（这是真实生产行为，不是缺陷）；因此缺失面改为验证 env 覆盖优先级
 * （ANIC_SKILL_DIR 候选 0 最先）。selfBootstrapRoute 走 resolveWorkspaceRoots，
 * 必须用 ctx.workspaceRegistry 钉住临时工作区，否则回落到真实 dsh-anic 工作区
 * 会跑 60s 真实 eval-runner（首版实测 60s 超时的根因）。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { renderGraphDataTable, type GraphTableData } from '../../src/client/features/graph/graphDataTable.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowNode } from '../../src/client/workflowGraphData.ts';
import { runScriptSide, recordNative, CONVERGENCE_GATE_NAMES, type EngineSide } from '../../src/host/flows/gateCheckRunners.ts';
import { auditTruthfulness, auditStructure, auditLogic } from '../../src/host/evolution/truthAuditChecks.ts';
import { registerFlowsRoute } from '../../src/host/routes/flowsRoute.ts';
import { registerSelfBootstrapRoutes } from '../../src/host/routes/selfBootstrapRoute.ts';
import { registerBuiltinFlows } from '../../src/host/flows/builtin.ts';
import { loadLedger } from '../../src/host/runtime/ledger.ts';

/* ------------------------------------------------------------------ */
/* 通用测试基建                                                        */
/* ------------------------------------------------------------------ */

const TMPS: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  TMPS.push(dir);
  return dir;
}

afterEach(() => {
  while (TMPS.length > 0) {
    const d = TMPS.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 并行竞态忽略 */ }
  }
});

/** 捕获型 res 桩：writeHead 记 status/headers，end 解析 JSON body。 */
function makeRes() {
  const captured: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  return {
    captured,
    res: {
      writeHead(status: number, headers?: Record<string, string>) {
        captured.status = status;
        if (headers) for (const [k, v] of Object.entries(headers)) captured.headers[k] = String(v);
      },
      setHeader(k: string, v: string) { captured.headers[k] = v; },
      end(chunk?: unknown) {
        if (typeof chunk === 'string') {
          try { captured.body = JSON.parse(chunk); } catch { captured.body = chunk; }
        } else if (chunk !== undefined) {
          captured.body = chunk;
        }
      },
    },
  };
}

/** SendFn 实现：writeHead + JSON.stringify end（与宿主 sendJson 同消费面）。 */
function sendFn(res: unknown, code: number, body: unknown): void {
  const r = res as { writeHead(s: number, h?: Record<string, string>): void; end(c?: unknown): void };
  r.writeHead(code, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify(body));
}

/** 最小 webServer ctx：register 收集路由，disposer 可回收。 */
function makeCtx() {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  const disposers: Array<() => void> = [];
  return {
    ctx: {
      webServer: {
        register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) {
          routes.set(route.path, route.handler);
          const d = () => { routes.delete(route.path); };
          disposers.push(d);
          return d;
        },
      },
    } as Parameters<typeof registerFlowsRoute>[0],
    routes,
    disposers,
  };
}

/** 带工作区注册表的 ctx（selfBootstrapRoute 的 resolveWorkspaceRoots 消费面）。 */
function makeCtxWithWs(ws: string): ReturnType<typeof makeCtx> {
  const base = makeCtx();
  return {
    ...base,
    ctx: { ...base.ctx, workspaceRegistry: { list: () => [{ path: ws }] } } as unknown as ReturnType<typeof makeCtx>['ctx'],
  };
}

/**
 * 补齐自举前置（cycle-72）：`.cycles/config.yml` + 至少一个 `cycle-N/` 目录。
 *
 * 三个 self 端点现在走前置守卫，缺前置即 412——这些用例要测的是**裁决路径**，
 * 故必须先把环境准备好，否则测到的是守卫而不是被测语义（守卫本身另有专测）。
 */
function writeBootstrapPrereqs(ws: string): void {
  mkdirSync(join(ws, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(ws, '.cycles', 'config.yml'),
    'build_cmd: "echo build"\ntest_cmd: "echo ok"\nlint_cmd: "echo lint"\n', 'utf8');
}

/** 领域 gate-check 输出格式的假技能脚本（parseGateLines/parseGateVerdict 消费面）。 */
function writeFakeSkillScripts(ws: string, gateStdout: string, gateStderr = '', gateExit = 0): string {
  const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  // 哨兵：resolveSkillScriptsDir 靠 init-workflow.mjs 存在性认目录
  writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
  writeFileSync(join(scriptsDir, 'gate-check.mjs'), [
    `process.stdout.write(${JSON.stringify(gateStdout)});`,
    `process.stderr.write(${JSON.stringify(gateStderr)});`,
    `process.exit(${gateExit});`,
    '',
  ].join('\n'), 'utf8');
  return scriptsDir;
}

function flushMicrotasks(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 1. graphDataTable（P1-3 文本替代）+ workflowGraphData（嵌入快照）     */
/* ------------------------------------------------------------------ */

describe('graphDataTable（WCAG 1.1.1 等价数据表）', () => {
  const node = (id: string, type: WorkflowNode['type'], result?: string): WorkflowNode =>
    ({ id, type, label: `label-${id}`, x: 0, y: 0, ...(result !== undefined ? { result } : {}) });

  it('视觉隐藏容器 + table/caption/thead 原生语义（无 ARIA 补丁）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderGraphDataTable({ nodes: [node('n1', 'gate', 'PASS')] })));
    expect(html).toContain('class="anic-sr-only"');
    expect(html).toContain('data-anic-graph-table="true"');
    expect(html).toContain('<table>');
    expect(html).toContain('<caption>');
    expect(html).toContain('<thead>');
    expect(html).toContain('scope="col"');
  });

  it('每节点一行：id/type/归一裁决/label 四单元格（REJECT→fail 归一）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderGraphDataTable({ nodes: [
        node('g0', 'gate', 'PASS'),
        node('g1', 'gate', 'REJECT'),
        node('n2', 'micro-step'), // 无裁决 → em 破折号
      ] })));
    expect(html).toContain('data-anic-table-node="g0"');
    expect(html).toContain('data-anic-table-node="g1"');
    expect(html).toContain('data-anic-table-node="n2"');
    expect(html).toContain('pass');
    expect(html).toContain('fail');
    expect(html).toContain('—');
    expect(html).toContain('label-g0');
  });

  it('verdicts Map 覆盖优先于节点内嵌 result（投影数据胜过快照数据）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderGraphDataTable({ nodes: [node('g0', 'gate', 'PASS')] }, new Map([['g0', 'pending']]))));
    expect(html).toContain('pending');
    expect(html).not.toContain('>pass<');
  });

  it('与嵌入快照同源渲染：全部节点逐行投影（真实 WORKFLOW_SNAPSHOT）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderGraphDataTable({ nodes: WORKFLOW_SNAPSHOT.nodes })));
    expect((html.match(/data-anic-table-node=/g) ?? []).length).toBe(WORKFLOW_SNAPSHOT.nodes.length);
    expect(WORKFLOW_SNAPSHOT.nodes.length).toBeGreaterThanOrEqual(160);
  });
});

describe('workflowGraphData（嵌入快照契约）', () => {
  it('GENERATED 头注释 + 重新生成命令（防手工编辑纪律的可见提示）', () => {
    const src = readFileSync(resolve('src/client/workflowGraphData.ts'), 'utf8');
    expect(src).toContain('GENERATED FILE');
    expect(src).toContain('run snapshot');
  });

  it('counts 与实际数组长度自洽（nodes/edges/autonomy 字段在场）', () => {
    expect(WORKFLOW_SNAPSHOT.counts.nodes).toBe(WORKFLOW_SNAPSHOT.nodes.length);
    expect(WORKFLOW_SNAPSHOT.counts.edges).toBe(WORKFLOW_SNAPSHOT.edges.length);
    // cycle-43 场地自洽化：嵌入快照默认源=本仓自身 .cycles/（autonomy 由真实
    // config 判定，当前 L2）——不再钉死场地数据面的 L4。断言收紧为「合法自主级」。
    expect(['L1', 'L2', 'L3', 'L4']).toContain(WORKFLOW_SNAPSHOT.autonomy);
    expect(WORKFLOW_SNAPSHOT.edges.every((e) => typeof e.from === 'string' && typeof e.to === 'string')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. gateCheckRunners（script 侧解析 / native 入账去重 / env 优先级）   */
/* ------------------------------------------------------------------ */

describe('gateCheckRunners', () => {
  it('CONVERGENCE_GATE_NAMES 与技能 lib/ledger.mjs GATE_NAMES 同表（G0-G3 四门）', () => {
    expect(CONVERGENCE_GATE_NAMES.G0).toBe('评估收敛门');
    expect(CONVERGENCE_GATE_NAMES.G1).toBe('任务收敛门');
    expect(CONVERGENCE_GATE_NAMES.G2).toBe('测试收敛门');
    expect(CONVERGENCE_GATE_NAMES.G3).toBe('构建收敛门');
    expect(Object.keys(CONVERGENCE_GATE_NAMES)).toHaveLength(4);
  });

  it('script 侧：门禁行/质量行解析 + 无总裁决行时逐门禁统计（[FAIL] G1 → allPass=false）', () => {
    const ws = mkTmp('anic-gcr-script');
    // 故意不含 "All gates PASSED." 总裁决行——验证逐门禁行兜底路径
    writeFakeSkillScripts(ws, [
      '[PASS] G0: Evaluation report found in cycle-x (16 dimension rows)',
      '[FAIL] G1: No tasks found',
      '  [PASS] G0-Quality: Q1 pass',
      '  [FAIL] G1-Quality: Q2 fail',
    ].join('\n'));
    const out = runScriptSide(ws, 'all', true, false, 30000);
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.gates.G0?.pass).toBe(true);
    expect(out.gates.G1?.pass).toBe(false);
    expect(out.gates.G1?.detail).toBe('No tasks found');
    expect(out.quality.G0?.pass).toBe(true);
    expect(out.quality.G1?.pass).toBe(false);
    expect(out.quality.G1?.detail).toBe('Q2 fail');
    expect(out.allPass).toBe(false); // 逐门禁行含 FAIL → FAIL
    expect(out.exitCode).toBe(0); // 假脚本 exit 0——exitCode 只映射 0/1
  });

  it('script 侧：stderr 含 config 缺失标记 → fatal=CONFIG_MISSING', () => {
    const ws = mkTmp('anic-gcr-fatal');
    writeFakeSkillScripts(ws, '', 'No .cycles/config.yml found in', 1);
    const out = runScriptSide(ws, 'all', false, false, 5000);
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.fatal).toBe('CONFIG_MISSING');
  });

  it('resolver 优先级：ANIC_SKILL_DIR（候选 0）胜过工作区本地副本（候选 1）', () => {
    const ws = mkTmp('anic-gcr-prio-ws');
    writeFakeSkillScripts(ws, '[PASS] G0: workspace-copy\n');
    // env 副本输出不同 detail——证明胜出
    const envRoot = mkTmp('anic-gcr-prio-env');
    const envScripts = join(envRoot, 'scripts');
    mkdirSync(envScripts, { recursive: true });
    writeFileSync(join(envScripts, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
    writeFileSync(join(envScripts, 'gate-check.mjs'),
      `process.stdout.write('[PASS] G0: env-override\\n');process.exit(0);`, 'utf8');
    process.env.ANIC_SKILL_DIR = envRoot;
    try {
      const out = runScriptSide(ws, 'G0', false, false, 10000);
      expect('error' in out).toBe(false);
      if ('error' in out) return;
      expect(out.gates.G0?.detail).toBe('env-override');
    } finally {
      delete process.env.ANIC_SKILL_DIR;
    }
  });

  it('native 入账：同门最新一条 result+detail 相同则跳过（脚本 :204-214 同语义）', () => {
    const ws = mkTmp('anic-gcr-rec');
    const cyclesDir = join(ws, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });
    const gates: EngineSide['gates'] = {
      G0: { pass: true, detail: 'ok' },
      G1: { pass: true, detail: 'ok' },
    };
    const first = recordNative(cyclesDir, gates);
    expect(first.sort()).toEqual(['G0', 'G1']);
    // 完全相同的判定再入账 → 全部跳过（去重）
    const second = recordNative(cyclesDir, gates);
    expect(second).toEqual([]);
    // 判决翻转 → 重新入账
    const third = recordNative(cyclesDir, { G0: { pass: false, detail: 'now failing' } });
    expect(third).toEqual(['G0']);
    // 账本确已落盘（loadLedger 读回=磁盘事实）且条目形状完整
    const entries = loadLedger(cyclesDir);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => typeof e.gate === 'string' && typeof e.gateName === 'string' && typeof e.result === 'string' && typeof e.detail === 'string')).toBe(true);
    expect(entries[2]?.gateName).toBe('评估收敛门');
    expect(entries[2]?.result).toBe('FAIL');
  });
});

/* ------------------------------------------------------------------ */
/* 3. truthAuditChecks 负路径（真插件目录正路径已在 truthAudit.test.ts）  */
/* ------------------------------------------------------------------ */

describe('truthAuditChecks 负路径（夹具工作区）', () => {
  it('T1：目录/文件缺失 → fail 逐项报告 + score < 100 + passed=false', () => {
    const fake = mkTmp('anic-ta-neg');
    const r = auditTruthfulness(fake);
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(100);
    const missing = r.findings.filter((f) => f.status === 'fail');
    expect(missing.length).toBeGreaterThan(10);
    expect(missing.every((f) => f.detail === 'MISSING')).toBe(true);
    expect(missing.some((f) => f.check.startsWith('dir:'))).toBe(true);
    expect(missing.some((f) => f.check.startsWith('file:'))).toBe(true);
  });

  it('T3：>250 行的 .ts 文件 → 超长项 fail + modular compliance fail', () => {
    const fake = mkTmp('anic-ta-t3');
    mkdirSync(join(fake, 'src'), { recursive: true });
    writeFileSync(join(fake, 'src', 'big.ts'), 'x\n'.repeat(250) + 'x', 'utf8'); // 251 行（无尾换行）
    const r = auditStructure(fake);
    expect(r.passed).toBe(false);
    // collectTsFiles 以 src/ 为根做相对路径——check 是 file:big.ts
    const oversize = r.findings.find((f) => f.check === 'file:big.ts');
    expect(oversize?.status).toBe('fail');
    expect(oversize?.detail).toContain('251 lines');
    const mod = r.findings.find((f) => f.check === 'modular compliance');
    expect(mod?.status).toBe('fail');
  });

  it('T4：routes 目录文件无 register/reg 字样 → warn（routeContext.ts 白名单豁免）', () => {
    const fake = mkTmp('anic-ta-t4');
    const routesDir = join(fake, 'src', 'host', 'routes');
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, 'plain.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(routesDir, 'routeContext.ts'), 'export const y = 2;\n', 'utf8'); // 白名单
    writeFileSync(join(routesDir, 'realRoute.ts'), 'export function registerX() {}\n', 'utf8');
    const r = auditLogic(fake);
    const plain = r.findings.find((f) => f.check === 'route:plain.ts');
    expect(plain?.status).toBe('warn');
    expect(plain?.detail).toBe('no registration');
    // routeContext.ts 在白名单：无任何 finding 提及它
    expect(r.findings.some((f) => f.check === 'route:routeContext.ts')).toBe(false);
    const real = r.findings.find((f) => f.check === 'route:realRoute.ts');
    expect(real?.status).toBe('pass');
  });
});

/* ------------------------------------------------------------------ */
/* 4. flowsRoute（9 路由观测面 + 校验 + 状态码）                         */
/* ------------------------------------------------------------------ */

describe('flowsRoute', () => {
  // 注册表是模块级单例：builtin 5 流程须先注册（首个胜出——重复调用 no-op，安全）。
  beforeAll(() => { registerBuiltinFlows(); });

  it('注册 9 条路由 + 全部 disposer 可回收', () => {
    const { ctx, routes, disposers } = makeCtx();
    const got = registerFlowsRoute(ctx, sendFn, { getWorkspaceRoot: () => null });
    expect(routes.size).toBe(9);
    for (const p of [
      '/anic/flows', '/anic/flows/status', '/anic/flows/state',
      '/anic/flows/gate-check/run', '/anic/flows/macro-phase/status',
      '/anic/flows/macro-phase/advance', '/anic/flows/archive/run',
      '/anic/flows/hitl/run', '/anic/flows/auto-fix/run',
    ]) expect(routes.has(p)).toBe(true);
    for (const d of got) if (typeof d === 'function') d();
    expect(routes.size).toBe(0);
    expect(disposers).toHaveLength(9);
  });

  it('GET /anic/flows — 注册表可序列化投影（5 流程描述子）', () => {
    const { ctx, routes } = makeCtx();
    registerFlowsRoute(ctx, sendFn, { getWorkspaceRoot: () => null });
    const { captured, res } = makeRes();
    routes.get('/anic/flows')!({}, res);
    expect(captured.status).toBe(200);
    const body = captured.body as { flows: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(5);
    expect(body.flows[0]?.transitions).toBeDefined();
    expect(body.flows[0]?.states).toBeDefined();
  });

  it('GET /anic/flows/status — 无工作区时 flows 仍返回（projection=null 不伪造）', () => {
    const { ctx, routes } = makeCtx();
    registerFlowsRoute(ctx, sendFn, { getWorkspaceRoot: () => null });
    const { captured, res } = makeRes();
    routes.get('/anic/flows/status')!({}, res);
    expect(captured.status).toBe(200);
    const body = captured.body as { neverRun: number; total: number };
    expect(body.total).toBe(5);
    expect(body.neverRun).toBe(5);
  });

  it('GET /anic/flows/state?flow=bogus → 404 UNKNOWN_FLOW；合法 id → 200 投影面', () => {
    const ws = mkTmp('anic-flows-state');
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    const { ctx, routes } = makeCtx();
    registerFlowsRoute(ctx, sendFn, { getWorkspaceRoot: () => ws });
    let { captured, res } = makeRes();
    routes.get('/anic/flows/state')!({ url: '/anic/flows/state?flow=bogus' }, res);
    expect(captured.status).toBe(404);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_UNKNOWN_FLOW:bogus' });
    ({ captured, res } = makeRes());
    routes.get('/anic/flows/state')!({ url: '/anic/flows/state?flow=gate-check' }, res);
    expect(captured.status).toBe(200);
    expect((captured.body as Record<string, unknown>).flowId).toBe('gate-check');
  });

  it('POST gate-check/run：无工作区 500；非法 gate 400（有工作区时校验先于执行）', async () => {
    // 无工作区 → 500
    const a = makeCtx();
    registerFlowsRoute(a.ctx, sendFn, { getWorkspaceRoot: () => null });
    let { captured, res } = makeRes();
    a.routes.get('/anic/flows/gate-check/run')!({ body: {} }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(500);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_NO_WORKSPACE' });
    // 有工作区 + 非法 gate → 400
    const ws = mkTmp('anic-flows-gate');
    const b = makeCtx();
    registerFlowsRoute(b.ctx, sendFn, { getWorkspaceRoot: () => ws });
    ({ captured, res } = makeRes());
    b.routes.get('/anic/flows/gate-check/run')!({ body: { gate: 'G9' } }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_BAD_GATE:G9' });
  });

  it('POST macro-phase/advance：非法 target 400 带 validPhases；dryRun+script 400', async () => {
    const ws = mkTmp('anic-flows-macro');
    const { ctx, routes } = makeCtx();
    registerFlowsRoute(ctx, sendFn, { getWorkspaceRoot: () => ws });
    let { captured, res } = makeRes();
    routes.get('/anic/flows/macro-phase/advance')!({ body: { target: 'bogus' } }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_BAD_PHASE:bogus' });
    expect((captured.body as { validPhases: string[] }).validPhases).toContain('deploy');
    ({ captured, res } = makeRes());
    routes.get('/anic/flows/macro-phase/advance')!({ body: { dryRun: true, mode: 'script' } }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_DRYRUN_NATIVE_ONLY' });
  });

  it('POST hitl/run：非法 gate 400；auto-fix/run：无工作区 500', async () => {
    const ws = mkTmp('anic-flows-hitl');
    const a = makeCtx();
    registerFlowsRoute(a.ctx, sendFn, { getWorkspaceRoot: () => ws });
    let { captured, res } = makeRes();
    a.routes.get('/anic/flows/hitl/run')!({ body: { gate: 'H9' } }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'ANIC_ROUTE_BAD_HITL_GATE:H9' });
    // auto-fix 无工作区
    const b = makeCtx();
    registerFlowsRoute(b.ctx, sendFn, { getWorkspaceRoot: () => null });
    ({ captured, res } = makeRes());
    b.routes.get('/anic/flows/auto-fix/run')!({ body: {} }, res);
    await flushMicrotasks();
    expect(captured.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* 5. selfBootstrapRoute（4 路由自举状态机）                            */
/* ------------------------------------------------------------------ */

describe('selfBootstrapRoute', () => {
  it('注册 4 条路由（self/evaluate、self/gate-check、self/iterate、self/status）', () => {
    const { ctx, routes } = makeCtx();
    registerSelfBootstrapRoutes(ctx, sendFn);
    expect(routes.size).toBe(4);
    for (const p of ['/anic/self/evaluate', '/anic/self/gate-check', '/anic/self/iterate', '/anic/self/status']) {
      expect(routes.has(p)).toBe(true);
    }
  });

  it('GET /anic/self/status — 新工作区 → IDLE 初始态（round=0）', () => {
    const ws = mkTmp('anic-sb-status');
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/status')!({}, res);
    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.status).toBe('IDLE');
    expect(body.round).toBe(0);
  });

  it('POST /anic/self/evaluate — 假脚本全绿 → score=1 + 状态推进 EVALUATING', async () => {
    const ws = mkTmp('anic-sb-eval');
    writeBootstrapPrereqs(ws);
    const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
    writeFileSync(join(scriptsDir, 'eval-runner.mjs'),
      `process.stdout.write('All 15 evaluated dimension(s) passed.\\n');process.exit(0);`, 'utf8');
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/evaluate')!({}, res);
    await flushMicrotasks(50);
    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.score).toBe(1);
    expect(body.exitCode).toBe(0);
    // cycle-72：端点已接 FlowTracker——flowId 必须出现在响应体（旧实现零记账）
    expect(typeof body.flowId).toBe('string');
    const tracker = JSON.parse(readFileSync(join(ws, '.cycles', 'flow-tracker.json'), 'utf8'));
    expect(tracker.flows).toHaveLength(1);
    expect(tracker.flows[0].script).toBe('eval-runner');
    expect(tracker.flows[0].status).toBe('DONE');
    // 状态文件已推进（磁盘事实）
    const state = JSON.parse(readFileSync(join(ws, '.cycles', 'self-bootstrap.json'), 'utf8'));
    expect(state.status).toBe('EVALUATING');
    expect(state.lastEvalScore).toBe(1);
  });

  it('POST /anic/self/gate-check — 假脚本 PASSED → verdict=PASS + 状态推进 GATE_CHECKING', async () => {
    const ws = mkTmp('anic-sb-gate');
    writeBootstrapPrereqs(ws);
    writeFakeSkillScripts(ws, [
      '[PASS] G0: ok',
      '[PASS] G1: ok',
      '[PASS] G2: ok',
      '[PASS] G3: ok',
      'All gates PASSED.',
    ].join('\n'));
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/gate-check')!({}, res);
    await flushMicrotasks(50);
    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.verdict).toBe('PASS');
    // cycle-72：gate 调用同样记账
    const tracker = JSON.parse(readFileSync(join(ws, '.cycles', 'flow-tracker.json'), 'utf8'));
    expect(tracker.flows).toHaveLength(1);
    expect(tracker.flows[0].script).toBe('gate-check');
    const state = JSON.parse(readFileSync(join(ws, '.cycles', 'self-bootstrap.json'), 'utf8'));
    expect(state.status).toBe('GATE_CHECKING');
    expect(state.lastGateVerdict).toBe('PASS');
  });

  it('POST /anic/self/iterate — FAIL 路径写 tech-debt 提案（R-31 不自改代码）', async () => {
    const ws = mkTmp('anic-sb-iter');
    writeBootstrapPrereqs(ws);
    const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
    writeFileSync(join(scriptsDir, 'eval-runner.mjs'),
      `process.stdout.write('All 15 evaluated dimension(s) passed.\\n');process.exit(0);`, 'utf8');
    writeFileSync(join(scriptsDir, 'gate-check.mjs'),
      `process.stderr.write('Gate check FAILED.\\n');process.exit(1);`, 'utf8');
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/iterate')!({ body: { maxRounds: 2 } }, res);
    await flushMicrotasks(80);
    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.gateVerdict).toBe('FAIL');
    expect(body.fixApplied).toContain('tech-debt/self-bootstrap-round-1.json');
    expect(Array.isArray(body.techDebtProposals)).toBe(true);
    // cycle-72 取证补齐验收：iterate = eval + gate 两次调用 ⇒ flow-tracker ≥ 2 条
    expect(typeof body.evalFlowId).toBe('string');
    expect(typeof body.gateFlowId).toBe('string');
    const tracker = JSON.parse(readFileSync(join(ws, '.cycles', 'flow-tracker.json'), 'utf8'));
    expect(tracker.flows.length).toBeGreaterThanOrEqual(2);
    expect(tracker.flows.map((f: { script: string }) => f.script)).toEqual(
      expect.arrayContaining(['eval-runner', 'gate-check']),
    );
    // 提案文件确已落盘且声明 REVIEW_REQUIRED（R-31：自举不自改）
    const tdPath = join(ws, '.cycles', 'tech-debt', 'self-bootstrap-round-1.json');
    expect(existsSync(tdPath)).toBe(true);
    const proposal = JSON.parse(readFileSync(tdPath, 'utf8'));
    expect(proposal.action).toContain('REVIEW_REQUIRED');
    expect(proposal.source).toBe('self-bootstrap');
  });

  // cycle-72 P0：缺前置必须是**专用错误码**，不得折叠成 evalScore 0 / FAIL。
  // 这是两轮自举恒 0 分的根因（eval-runner 缺 config 即 exit 1），修复后必须
  // 在契约层钉死三者：HTTP 状态码、机器错误码、可执行修复指引。
  it('缺 .cycles 前置 → 412 + ANIC_BOOTSTRAP_PRECONDITION（不产 0 分提案）', async () => {
    const ws = mkTmp('anic-sb-preflight');
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);

    for (const p of ['/anic/self/evaluate', '/anic/self/gate-check', '/anic/self/iterate']) {
      const { captured, res } = makeRes();
      routes.get(p)!({ body: { maxRounds: 1 } }, res);
      await flushMicrotasks(80);
      expect(captured.status).toBe(412);
      const body = captured.body as { error?: { code?: string; preconditionCode?: string; remedy?: string } };
      expect(body.error?.code).toBe('ANIC_BOOTSTRAP_PRECONDITION');
      expect(body.error?.preconditionCode).toBe('CONFIG_MISSING');
      expect(body.error?.remedy).toContain('init-workflow');
    }
    // 关键断言：未产出任何 0 分 tech-debt 提案（旧缺陷的可见症状）
    expect(existsSync(join(ws, '.cycles', 'tech-debt'))).toBe(false);
    // 且状态文件未被写成 FAIL/0——守卫在动作之前拦截，而非事后纠正
    expect(existsSync(join(ws, '.cycles', 'self-bootstrap.json'))).toBe(false);
  });

  it('有 config 但无 cycle 目录 → 412 CYCLE_DIR_MISSING（与 CONFIG_MISSING 分开报）', async () => {
    const ws = mkTmp('anic-sb-nocycle');
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    writeFileSync(join(ws, '.cycles', 'config.yml'), 'test_cmd: "echo ok"\n', 'utf8');
    const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
    const { ctx, routes } = makeCtxWithWs(ws);
    registerSelfBootstrapRoutes(ctx, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/evaluate')!({}, res);
    await flushMicrotasks(30);
    expect(captured.status).toBe(412);
    const body = captured.body as { error?: { preconditionCode?: string; remedy?: string } };
    expect(body.error?.preconditionCode).toBe('CYCLE_DIR_MISSING');
    expect(body.error?.remedy).toContain('init-cycle');
  });
});
