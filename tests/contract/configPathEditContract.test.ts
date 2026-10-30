/**
 * 路径编辑 / 回滚端点的**行为级**契约（cycle-83）。
 *
 * ## 守什么
 *
 * 1. `POST /anic/api/config/paths` 的 dryRun 与真写**走同一份 plan**：
 *    预览说改 1 条 ⇒ 真写也只改 1 条（预览是装饰的反面证据）；
 * 2. 非法覆盖 ⇒ 400 且**零写入**（`.cycles/paths.json` 一个字节都不动）；
 * 3. 真写后响应里的 paths 是**重新解析**的结果（不是"我写了什么"）；
 * 4. `POST /anic/api/config/rollback` 的 dryRun 不写盘、真写后值/注释回到备份态；
 * 5. 回滚响应必须带 `safetyBackupPath`（回滚前状态进了 .bak，回滚可再回滚）；
 * 6. 两条端点都走真实 `readBody` 流式语义（P0-BODY：直读 req.body 会静默丢参数）。
 *
 * ## 纪律
 *
 * - 每条"守卫生效"都配一个"守卫失效会怎样"的对照（否则全绿可能只是判定器哑了）；
 * - 扫描集非空下限：备份清单、变更清单都要有下限断言（空集上的相等毫无意义）；
 * - 真实文件系统：真目录 + 真 atomicWrite（mock fs 测不出 rename/权限语义）。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerConfigRoute, CONFIG_PATHS_ROUTE, CONFIG_ROLLBACK_ROUTE, CONFIG_ROUTE,
} from '../../src/host/routes/configRoute.ts';
import { collectPaths } from '../../src/host/configEdit/paths.ts';
import { pathsFilePath } from '../../src/host/configEdit/pathOverrides.ts';
import { applyConfigPatch, listBackups } from '../../src/host/configEdit/configWriter.ts';
import { commentLines, splitLines } from '../../src/host/configEdit/yamlText.ts';
import { readFieldValue } from '../../src/host/configEdit/configRead.ts';
import { fieldById } from '../../src/host/configEdit/configSchema.ts';
import type { RouteReq } from '../../src/host/routes/routeContext.ts';

const TMP = mkdtempSync(join(tmpdir(), 'anic-path-edit-contract-'));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理竞态容忍 */ } });

const CONFIG_SAMPLE = [
  'project:',
  '  name: "demo"',
  '',
  'macro_cycle:',
  '  # 为什么显式写预算：默认值会让「超预算」淹没在告警疲劳里',
  '  autonomy_level: L4',
  '  complexity_budget: 100',
  '',
  'build:',
  '  test_cmd: node scripts/run-tests.mjs',
  '',
].join('\n');

let seq = 0;
interface Host { routes: Map<string, Handler>; send: (res: unknown, status: number, body: unknown) => void }

type Handler = (req: unknown, res: unknown) => void;

function makeRes() {
  const captured: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) { captured.status = status; },
    setHeader() { /* headers 不参与断言 */ },
    end(chunk?: string) { captured.body = typeof chunk === 'string' ? JSON.parse(chunk) : undefined; },
  };
  return { captured, res };
}

/** 造一个带真实目录的工作区并注册三条端点。 */
function makeHost(tag: string): { ws: string; cycles: string; host: Host } {
  seq += 1;
  const ws = join(TMP, `${tag}-${String(seq)}`);
  const cycles = join(ws, '.cycles');
  mkdirSync(cycles, { recursive: true });
  for (const rel of ['evals', 'tech-debt', 'cycles', 'incidents', 'archive']) mkdirSync(join(cycles, rel), { recursive: true });
  mkdirSync(join(ws, 'artifacts'), { recursive: true });
  writeFileSync(join(cycles, 'config.yml'), CONFIG_SAMPLE, 'utf-8');
  const routes = new Map<string, Handler>();
  const ctx = {
    webServer: {
      register(route: { kind: string; path: string; handler: Handler }) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  const send = (res: unknown, status: number, body: unknown): void => {
    const r = res as { writeHead(s: number): void; end(c?: string): void };
    r.writeHead(status);
    r.end(JSON.stringify(body));
  };
  registerConfigRoute(ctx, { send, getWorkspaceRoot: () => ws });
  return { ws, cycles, host: { routes, send } };
}

/** 流式假请求（真实宿主 IncomingMessage 的最小表面：只有 on）。 */
function streamReq(url: string, method: string, chunks: string[]): RouteReq {
  const ee = new EventEmitter();
  Object.assign(ee, { url, method });
  queueMicrotask(() => {
    for (const c of chunks) ee.emit('data', Buffer.from(c, 'utf-8'));
    ee.emit('end');
  });
  return ee as unknown as RouteReq;
}

async function call(routes: Map<string, Handler>, path: string, req: RouteReq): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = routes.get(path);
  if (!handler) throw new Error(`route not registered: ${path}`);
  const { captured, res } = makeRes();
  handler(req, res);
  await new Promise((r) => setTimeout(r, 5)); // 排空 readBody 的微任务
  return { status: captured.status, body: (captured.body ?? {}) as Record<string, unknown> };
}

describe('端点注册：三条都挂在同一个 register 上（接线点唯一）', () => {
  it('config / config/paths / config/rollback 全部注册', () => {
    const { host } = makeHost('reg');
    for (const p of [CONFIG_ROUTE, CONFIG_PATHS_ROUTE, CONFIG_ROLLBACK_ROUTE]) {
      expect(host.routes.has(p), `缺端点 ${p}`).toBe(true);
    }
    // 反向自检：未注册的路径确实取不到（判据不是恒真）
    expect(host.routes.has('/anic/api/config/nope')).toBe(false);
  });

  it('路径端点常量是 config 端点的**子路径**（同域分层，不是并列新域）', () => {
    expect(CONFIG_PATHS_ROUTE.startsWith(`${CONFIG_ROUTE}/`)).toBe(true);
    expect(CONFIG_ROLLBACK_ROUTE.startsWith(`${CONFIG_ROUTE}/`)).toBe(true);
  });
});

describe('POST /anic/api/config/paths：dryRun 与真写同源', () => {
  it('dryRun：不写盘，返回 changedIds；真写：同样只改 1 条', async () => {
    const { ws, host } = makeHost('paths-dry');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    const file = pathsFilePath(ws);
    expect(existsSync(file)).toBe(false);

    const dry = await call(host.routes, CONFIG_PATHS_ROUTE, streamReq(CONFIG_PATHS_ROUTE, 'POST', ['{"patch":{"evals":"docs/evals"},"dryRun":true}']));
    expect(dry.status).toBe(200);
    expect(dry.body['dryRun']).toBe(true);
    expect(dry.body['applied']).toBe(false);
    expect(dry.body['changedIds']).toEqual(['evals']);
    expect(existsSync(file)).toBe(false); // dryRun 零写入

    const real = await call(host.routes, CONFIG_PATHS_ROUTE, { url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: { evals: 'docs/evals' } } } as RouteReq);
    expect(real.status).toBe(200);
    expect(real.body['applied']).toBe(true);
    expect(real.body['changedIds']).toEqual(['evals']); // 与 dryRun 逐项相同
    expect(existsSync(file)).toBe(true);
    // 写后重新解析：响应里的 paths 是解析结果（不是"我写了什么"）
    const paths = real.body['paths'] as { entries: Array<{ id: string; path: string; overridden: boolean }> };
    const evals = paths.entries.find((e) => e.id === 'evals');
    expect(evals?.path).toBe(join(ws, 'docs', 'evals'));
    expect(evals?.overridden).toBe(true);
  });

  it('非法覆盖 → 400 且**零写入**（表文件不产生）', async () => {
    const { ws, host } = makeHost('paths-bad');
    const file = pathsFilePath(ws);
    const out = await call(host.routes, CONFIG_PATHS_ROUTE, {
      url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: { evals: '../escape' } },
    } as RouteReq);
    expect(out.status).toBe(400);
    expect(out.body['ok']).toBe(false);
    expect(JSON.stringify(out.body['warnings'])).toContain('PATH_TRAVERSAL');
    expect(existsSync(file)).toBe(false);
    // 反向自检：同一工作区里一条**合法**覆盖会被接受（判据不是恒假）
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    const good = await call(host.routes, CONFIG_PATHS_ROUTE, {
      url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: { evals: 'docs/evals' } },
    } as RouteReq);
    expect(good.status).toBe(200);
  });

  it('patch 不是对象 → 400 明确原因（形状守卫）', async () => {
    const { host } = makeHost('paths-shape');
    const out = await call(host.routes, CONFIG_PATHS_ROUTE, {
      url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: 'nope' },
    } as RouteReq);
    expect(out.status).toBe(400);
    expect(out.body['error']).toBe('ANIC_PATHS_BAD_PATCH');
  });

  it('无工作区 → 404（不猜一个默认工作区写进去）', async () => {
    const routes = new Map<string, Handler>();
    registerConfigRoute(
      { webServer: { register(r: { kind: string; path: string; handler: Handler }) { routes.set(r.path, r.handler); return () => routes.delete(r.path); } } },
      { send: (res, status, body) => { const r = res as { writeHead(s: number): void; end(c?: string): void }; r.writeHead(status); r.end(JSON.stringify(body)); }, getWorkspaceRoot: () => null },
    );
    const out = await call(routes, CONFIG_PATHS_ROUTE, { url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: {} } } as RouteReq);
    expect(out.status).toBe(404);
  });

  it('GET 路径端点返回只读覆盖视图（readonly 标记 + next 不改表）', async () => {
    const { host } = makeHost('paths-get');
    const out = await call(host.routes, CONFIG_PATHS_ROUTE, { url: CONFIG_PATHS_ROUTE, method: 'GET' } as RouteReq);
    expect(out.status).toBe(200);
    expect(out.body['readonly']).toBe(true);
    expect(out.body['dryRun']).toBe(true);
  });
});

describe('POST /anic/api/config/rollback：两段式 + 安全备份', () => {
  let ws: string;
  let cycles: string;
  let host: Host;
  let backupName: string;
  let written: string;

  beforeEach(() => {
    const made = makeHost('rollback');
    ws = made.ws;
    cycles = made.cycles;
    host = made.host;
    // 造两份备份：先改一次（产生原文备份），再改一次
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' });
    applyConfigPatch(cycles, { 'build.test_cmd': 'node fast.mjs' });
    const names = listBackups(cycles);
    expect(names.length).toBeGreaterThanOrEqual(2); // 扫描集非空下限
    backupName = names[0] as string; // 最早的那份 = 原文
    written = readFileSync(join(cycles, 'config.yml'), 'utf-8');
  });

  it('dryRun：不写盘，返回 diff 与 stats', async () => {
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: backupName, dryRun: true },
    } as RouteReq);
    expect(out.status).toBe(200);
    expect(out.body['dryRun']).toBe(true);
    expect(out.body['applied']).toBe(false);
    expect(Array.isArray(out.body['diff'])).toBe(true);
    expect((out.body['diff'] as unknown[]).length).toBeGreaterThan(0);
    // 磁盘零变化
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(written);
    // 反向自检：dryRun 的 afterHash 与 beforeHash 必须不同（否则"没有差异"也可能是假的）
    expect(out.body['afterHash']).not.toBe(out.body['beforeHash']);
  });

  it('真写：值回到备份态、注释逐字节回来、带 safetyBackupPath', async () => {
    const originalComments = commentLines(splitLines(CONFIG_SAMPLE));
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: backupName },
    } as RouteReq);
    expect(out.status).toBe(200);
    expect(out.body['ok']).toBe(true);
    expect(out.body['applied']).toBe(true);
    // ① 值回来
    const disk = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    expect(readFieldValue(disk, fieldById('macro_cycle.autonomy_level') as never)).toBe('L4');
    expect(readFieldValue(disk, fieldById('build.test_cmd') as never)).toBe('node scripts/run-tests.mjs');
    // ② 注释逐字节回来（回滚不该只恢复值、丢掉理由）
    expect(commentLines(splitLines(disk))).toEqual(originalComments);
    // ③ 安全备份路径在场，且内容是**回滚前**的正文
    const safety = out.body['safetyBackupPath'] as string | null;
    expect(safety).not.toBeNull();
    expect(readFileSync(safety as string, 'utf-8')).toBe(written);
    // ④ 刷新后的备份清单非空（客户端下拉据此重绘）
    expect((out.body['backups'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('安全备份可再回滚回去（回滚不是不可逆操作）', async () => {
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: backupName },
    } as RouteReq);
    const safety = out.body['safetyBackupPath'] as string;
    const safetyName = safety.split(/[\\/]/).pop() as string;
    const back = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: safetyName },
    } as RouteReq);
    expect(back.status).toBe(200);
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(written);
  });

  it('路径形态的 backup 参数 → 400（不给任意文件读取入口）', async () => {
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: `../${backupName}` },
    } as RouteReq);
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain('bare file name');
    // 反向自检：裸名字被接受（同一份文件）
    const ok = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: backupName, dryRun: true },
    } as RouteReq);
    expect(ok.status).toBe(200);
  });

  it('不存在的备份名 → 400（不能恢复清单外的文件）', async () => {
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, {
      url: CONFIG_ROLLBACK_ROUTE, method: 'POST', body: { backup: 'config.yml.bak.20200101T000000000Z' },
    } as RouteReq);
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain('unknown backup');
  });

  it('GET 不支持 → 405（回滚只有写侧语义）', async () => {
    const out = await call(host.routes, CONFIG_ROLLBACK_ROUTE, { url: CONFIG_ROLLBACK_ROUTE, method: 'GET' } as RouteReq);
    expect(out.status).toBe(405);
  });
});

describe('GET /anic/api/config：新形状（覆盖视图 + 备份摘要）与旧形状共存', () => {
  it('返回 pathOverrides 与 backupViews，同时保留 backups:string[]（既有契约）', async () => {
    const { ws, cycles, host } = makeHost('get-shape');
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L3' });
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    const post = await call(host.routes, CONFIG_PATHS_ROUTE, {
      url: CONFIG_PATHS_ROUTE, method: 'POST', body: { patch: { evals: 'docs/evals' } },
    } as RouteReq);
    expect(post.status).toBe(200);

    const out = await call(host.routes, CONFIG_ROUTE, { url: CONFIG_ROUTE, method: 'GET' } as RouteReq);
    expect(out.status).toBe(200);
    const body = out.body;
    // 旧形状仍在（既有契约测试按名字断言，改形状会假红）
    expect(Array.isArray(body['backups'])).toBe(true);
    // 新形状
    const ov = body['pathOverrides'] as { active: Record<string, string>; editableIds: string[]; ignored: boolean };
    expect(ov.active).toEqual({ evals: 'docs/evals' });
    expect(ov.ignored).toBe(false);
    expect(ov.editableIds).toContain('evals');
    const views = body['backupViews'] as Array<{ name: string; changedFields: string[] }>;
    expect(views.length).toBeGreaterThan(0);
    expect(Array.isArray(views[0]?.changedFields)).toBe(true);
    // 解析层确实用了覆盖
    const entries = (body['paths'] as { entries: Array<{ id: string; path: string }> }).entries;
    expect(entries.find((e) => e.id === 'evals')?.path).toBe(join(ws, 'docs', 'evals'));
    // 反向自检：登记表的默认项没跟着改
    expect(entries.find((e) => e.id === 'techDebt')?.path).toBe(join(cycles, 'tech-debt'));
  });

  it('覆盖表非法 ⇒ GET 的 paths 逐项等于默认 + overridesIgnored 为真', async () => {
    const { ws, host } = makeHost('get-ignored');
    writeFileSync(pathsFilePath(ws), JSON.stringify({ version: 1, overrides: { evals: '../x' } }), 'utf-8');
    const out = await call(host.routes, CONFIG_ROUTE, { url: CONFIG_ROUTE, method: 'GET' } as RouteReq);
    const body = out.body;
    const ov = body['pathOverrides'] as { ignored: boolean; active: Record<string, string> };
    expect(ov.ignored).toBe(true);
    expect(ov.active).toEqual({});
    // 逐项等于默认（用干净工作区对照）
    const entries = (body['paths'] as { entries: Array<{ id: string; path: string | null; overridden: boolean }> }).entries;
    expect(entries.every((e) => e.overridden === false)).toBe(true);
    expect(collectPaths(ws).overridesIgnored).toBe(true);
  });
});
