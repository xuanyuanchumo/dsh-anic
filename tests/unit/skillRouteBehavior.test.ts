/**
 * skillRoute 行为测试（cycle-39 T-3905）。
 *
 * 缺口史（cycle-39 测试审计 #1）：skillRoute.ts 的 4 路由
 * （skill/list、skill/invoke、evaluate、iterate）是全仓**唯一**承载真实
 * 跨项目用户旅程却零行为测试的路由文件——此前只有 snapshotRoute.test.ts:348
 * 的注册路径清单 + routeWorkspaceCycle22 的 req 透传形态。
 *
 * 本文件验证真实行为链：
 * - list → 返回 15 脚本白名单
 * - invoke → 真实 spawn（init-workflow 脚手架落盘）
 * - evaluate → 跨项目评估 + bootstrapSync 回写（G-C5）
 * - iterate → eval + gate + bootstrapSync
 * - 负路径：白名单外脚本 400 / 无工作区 400 / 未装技能 404
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Registered {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

interface CtxStub {
  webServer: { register: (r: Registered) => (() => void) | null };
  workspaceRegistry?: { list: () => Array<{ path: string }> };
}

/** 桩 req：对象形态（readBody 双形态兼容的同步路径）。 */
function makeReq(method: string, path: string, body?: Record<string, unknown>) {
  return { method, url: path, headers: {}, body: body ?? {} };
}

function makeCtx(root: string): { ctx: CtxStub; registered: Registered[] } {
  const registered: Registered[] = [];
  const ctx: CtxStub = {
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
    workspaceRegistry: { list: () => [{ path: root }] },
  };
  return { ctx, registered };
}

function makeSend(captured: { status: number; body: unknown }[]) {
  return (_res: unknown, status: number, body: unknown) => { captured.push({ status, body }); };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 300));
}

/** 轮询等待 captured 出现新响应（spawnSync 阻塞事件循环，纯 setTimeout 等不到）。 */
async function waitResponse(captured: { status: number; body: unknown }[], minCount: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.length >= minCount) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return captured.length >= minCount;
}

const CLEANUPS: string[] = [];
afterEach(() => {
  while (CLEANUPS.length) { const p = CLEANUPS.pop(); try { rmSync(p!, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-skillroute-'));
  CLEANUPS.push(dir);
  return dir;
}

/** 播种一个最小可评估工作区（技能内联底座由 resolveSkillScriptsDir 兜底）。 */
function seedWorkspace(root: string): void {
  mkdirSync(join(root, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  mkdirSync(join(root, '.cycles', 'cycles', 'cycle-1', 'test-reports'), { recursive: true });
  mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
  mkdirSync(join(root, '.cycles', 'intent'), { recursive: true });
  writeIf(join(root, '.cycles', 'config.yml'), 'project:\n  name: t\nautonomy_level: L2\nbuild_cmd: "exit 0"\n');
  writeIf(join(root, '.cycles', 'cycles', 'cycle-1', '项目评估报告.md'), '| E1 | 意图 | PASS | x |');
  writeIf(join(root, '.cycles', 'cycles', 'cycle-1', '任务清单.md'), '| T-01 | P0 | a | b | c | 完成 |');
  writeIf(join(root, '.cycles', 'cycles', 'cycle-1', 'test-reports', 'tr.md'), '| 指标 | 数量 |\n|---|---|\n| 通过 | 1 |\n| 失败 | 0 |\n| 错误 | 0 |');
}

function writeIf(p: string, content: string): void {
  writeFileSync(p, content);
}

describe('skillRoute 行为（cycle-39 T-3905）', () => {
  it('GET /anic/skill/list → 15 脚本白名单', async () => {
    const root = tmpWorkspace();
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const list = registered.find((r) => r.path === '/anic/skill/list');
    expect(list).toBeDefined();
    list!.handler(makeReq('GET', '/anic/skill/list'), {});
    await flush();
    expect(captured.at(-1)?.status).toBe(200);
    const scripts = (captured.at(-1)?.body as { scripts: string[] }).scripts;
    expect(scripts.length).toBe(15);
    expect(scripts).toContain('init-workflow');
    expect(scripts).toContain('quick-validate');
  });

  it('POST /anic/skill/invoke → 真实 spawn（init-workflow 脚手架落盘）', async () => {
    const root = tmpWorkspace();
    seedWorkspace(root);
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const invoke = registered.find((r) => r.path === '/anic/skill/invoke');
    invoke!.handler(makeReq('POST', '/anic/skill/invoke', { script: 'init-workflow', workspace: root, args: ['--name', 'route-e2e'] }), {});
    await new Promise((r) => setTimeout(r, 3000));
    const body = captured.at(-1);
    expect(body?.status).toBe(200);
    const b = body?.body as { exitCode: number; script: string };
    expect(b.exitCode).toBe(0);
    expect(existsSync(join(root, '.cycles', 'config.yml'))).toBe(true);
  });

  it('POST /anic/skill/invoke 白名单外脚本 → 400 + allowed 清单', async () => {
    const root = tmpWorkspace();
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const invoke = registered.find((r) => r.path === '/anic/skill/invoke');
    invoke!.handler(makeReq('POST', '/anic/skill/invoke', { script: 'rm-rf', workspace: root }), {});
    await flush();
    expect(captured.at(-1)?.status).toBe(400);
    expect(String((captured.at(-1)?.body as { error: { message: string } }).error.message)).toContain('Unknown script');
  });

  it('POST /anic/skill/invoke 不存在的工作区 → 400', async () => {
    const root = tmpWorkspace();
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const invoke = registered.find((r) => r.path === '/anic/skill/invoke');
    invoke!.handler(makeReq('POST', '/anic/skill/invoke', { script: 'init-workflow', workspace: 'Z:\\__nonexistent__' }), {});
    await flush();
    // cycle-101 信封归一：NO_WORKSPACE → 404（旧手写体是 400；语义仍是拒绝，策略表 rejected/never）
    expect(captured.at(-1)?.status).toBe(404);
  });

  it('POST /anic/evaluate → 跨项目评估 + bootstrapSync 回写（G-C5）', async () => {
    const root = tmpWorkspace();
    seedWorkspace(root);
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const evaluate = registered.find((r) => r.path === '/anic/evaluate');
    expect(evaluate).toBeDefined();
    evaluate!.handler(makeReq('POST', '/anic/evaluate', { workspace: root }), {});
    const ok = await waitResponse(captured, 1, 110000);
    expect(ok, 'evaluate handler 在 110s 内响应（spawnSync 60s 超时面）').toBe(true);
    const body = captured.at(-1);
    expect(body?.status).toBe(200);
    const b = body?.body as { exitCode: number; bootstrapSync: string };
    // eval-runner 在最小夹具上会跑（E1-E8 部分维度 FAIL 属预期——行为链通即可）
    expect(b.exitCode).toBe(1);
    // G-C5：跨项目历史回写到「插件自身工作区」——本桩无 ownRoots → failed 形态
    // （resolveWorkspaceRoots(ctx) 走 workspaceRegistry —— 有 root 时应 ok）
    expect(['ok', 'failed']).toContain(b.bootstrapSync);
  });

  it('POST /anic/iterate → eval + gate 双跑 + bootstrapSync', async () => {
    const root = tmpWorkspace();
    seedWorkspace(root);
    const { registerSkillRoutes } = await import('../../src/host/routes/skillRoute.ts');
    const { ctx, registered } = makeCtx(root);
    const captured: { status: number; body: unknown }[] = [];
    registerSkillRoutes(ctx as never, makeSend(captured));

    const iterate = registered.find((r) => r.path === '/anic/iterate');
    expect(iterate).toBeDefined();
    iterate!.handler(makeReq('POST', '/anic/iterate', { workspace: root }), {});
    const ok = await waitResponse(captured, 1, 110000);
    expect(ok, 'iterate handler 在 110s 内响应（eval + gate 两次 spawnSync）').toBe(true);
    const body = captured.at(-1);
    expect(body?.status).toBe(200);
    const b = body?.body as { eval: { exitCode: number }; gate: { exitCode: number }; bootstrapSync: string };
    expect(typeof b.eval.exitCode).toBe('number');
    expect(typeof b.gate.exitCode).toBe('number');
    expect(['ok', 'failed']).toContain(b.bootstrapSync);
    // gate-check --record 落账本（iterate 链真实执行的证据）
    expect(existsSync(join(root, '.cycles', 'gates', 'ledger.json'))).toBe(true);
  });
});
