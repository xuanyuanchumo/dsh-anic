/**
 * 热更新重载契约（cycle-80 WS-1）：in-flight 握手 + 重载史 + reloadSelf + 路由。
 *
 * ## 被守卫的缺口（实测，不是推测）
 * 宿主 desktop profile 的 `@deepseek-ai/dsh-hmr` 已 active，`ctx.hmr.runExclusive/reconcileProfile`
 * 能把「linked package targets 里磁盘已变」的插件换掉；本插件又是 `link:` 安装 ⇒ dist 就是命中面。
 * 但本仓 `grep ctx.hmr src/` 零命中——能力注册了从不消费，于是改代码只能人工重启宿主。
 *
 * ## 本文件钉死的三件事（对应三条设计铁律）
 * 1. **顺序**：触发重载那一刻，史账里必须**已经**有 in-flight 条目（否则实例被杀后无人能写）。
 * 2. **串行化**：必须经 `runExclusive` 包裹，且恰好一次；直接调 `reconcileProfile` 不合格。
 * 3. **诚实降级**：无 hmr 服务 → `unavailable` 且**零写入**；dist 已最新 → `refused` 且零写入。
 *
 * 反向自检用「本地破坏版实现」驱动同一判定器：把顺序对调、去掉 runExclusive 包裹后，判定器
 * 必须返回 false —— 证明上面的断言不是"怎么写都绿"的装饰（守卫有牙）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeBuildRevision, buildFreshness, probeHmr, readReloadHistory, appendReloadHistory,
  finalizeInFlight, reloadSelf, reloadSummary, RELOAD_HISTORY_FILE,
  type ReloadHistoryEntry, type ReloadSelfOptions,
} from '../../src/host/runtime/hotReload.ts';
import { registerHotReloadRoute, RELOAD_STATUS } from '../../src/host/routes/hotReloadRoute.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CLEANUPS: string[] = [];
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 夹具插件根：dist 两产物 + src 一个 .ts，用显式 mtime 控制 stale。
 * stale=true → src 比 dist 新（需要重载）；false → dist 更新（已是最新构建）。
 */
function mkPluginRoot(stale: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-hr-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'dist', 'host.js'), 'host-bundle');
  writeFileSync(join(root, 'dist', 'client.js'), 'client-bundle');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const now = Date.now();
  const distAt = new Date(now - 30_000);
  utimesSync(join(root, 'dist', 'host.js'), distAt, distAt);
  utimesSync(join(root, 'dist', 'client.js'), distAt, distAt);
  const srcAt = new Date(stale ? now : now - 60_000);
  utimesSync(join(root, 'src', 'a.ts'), srcAt, srcAt);
  CLEANUPS.push(root);
  return root;
}

interface StubHmr {
  ctx: { get: (key: string, strict?: boolean) => unknown };
  calls: string[];
  atTrigger: ReloadHistoryEntry[][];
}

/** 桩 hmr：记录调用序，并在 reconcileProfile 进入的一瞬快照史账（顺序证据）。 */
function mkHmrCtx(cyclesDir: string): StubHmr {
  const calls: string[] = [];
  const atTrigger: ReloadHistoryEntry[][] = [];
  const hmr = {
    runExclusive: async (op: () => Promise<unknown>): Promise<unknown> => {
      calls.push('runExclusive');
      const out = await op();
      calls.push('runExclusive:done');
      return out;
    },
    reconcileProfile: async (ids?: readonly string[]): Promise<unknown> => {
      calls.push('reconcileProfile:' + String(ids?.length ?? 0));
      atTrigger.push(readReloadHistory(cyclesDir).entries);
      return { warnings: [], pending: [] };
    },
  };
  const ctx = {
    get: (key: string): unknown => {
      calls.push('get:' + key);
      return key === 'hmr' ? hmr : undefined;
    },
  };
  return { ctx, calls, atTrigger };
}

function baseOpts(root: string, over: Partial<ReloadSelfOptions> = {}): ReloadSelfOptions {
  return { cyclesDir: join(root, '.cycles'), pluginRoot: root, reason: 'test reload', actor: 'test', ...over };
}

const historyFile = (root: string): string => join(root, '.cycles', RELOAD_HISTORY_FILE);

describe('cycle-80 热更新重载：in-flight 握手与诚实降级', () => {
  it('① 桩 hmr：runExclusive 恰一次、内部调 reconcileProfile；触发瞬间史账已有 in-flight', async () => {
    const root = mkPluginRoot(true);
    const { ctx, calls, atTrigger } = mkHmrCtx(join(root, '.cycles'));
    const rev = computeBuildRevision(root);
    const res = await reloadSelf(ctx, baseOpts(root, { requiredIds: ['ani'] }));
    expect(res.action).toBe('scheduled');
    expect(res.handshake).toBe(true);
    expect(res.fromRevision).toBe(rev?.revision ?? null);
    await sleep(80);
    // 调用序：探测 → runExclusive → reconcileProfile（串行化包裹）→ runExclusive 收尾
    expect(calls).toEqual(['get:hmr', 'runExclusive', 'reconcileProfile:1', 'runExclusive:done']);
    // 顺序铁律：真正触发重载的那一刻，磁盘上必须已有 in-flight（事后没人能补写）
    expect(atTrigger).toHaveLength(1);
    const seen = atTrigger[0]?.[0];
    expect(seen?.status).toBe('in-flight');
    expect(seen?.staleAtRequest).toBe(true);
    expect(seen?.fromRevision).toBe(rev?.revision ?? null);
    // 实例存活时自行落定握手（被替换时由新实例 finalize 接手）
    const after = readReloadHistory(join(root, '.cycles'));
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]?.status).toBe('reloaded');
    expect(after.entries[0]?.finalizedAt).toBeDefined();
  });

  it('② 无 hmr 服务 → unavailable、reason 点名、零写入（史账文件都不存在）', async () => {
    const root = mkPluginRoot(true);
    const res = await reloadSelf({ get: (): unknown => undefined }, baseOpts(root));
    expect(res.action).toBe('unavailable');
    expect(res.reason).toContain('hmr service not provided (headless/SDK profile)');
    expect(existsSync(historyFile(root))).toBe(false);
    // 连 ctx.get 都没有的宿主形态同样诚实降级，不炸
    const noGet = await reloadSelf({}, baseOpts(root));
    expect(noGet.action).toBe('unavailable');
    expect(existsSync(historyFile(root))).toBe(false);
  });

  it('③ dist 已最新 → refused 零写入；force:true 才允许调度（另一条路径）', async () => {
    const root = mkPluginRoot(false); // dist 比 src 新
    const { ctx } = mkHmrCtx(join(root, '.cycles'));
    const refused = await reloadSelf(ctx, baseOpts(root));
    expect(refused.action).toBe('refused');
    expect(refused.reason).toContain('dist is up to date');
    expect(refused.handshake).toBe(false);
    expect(existsSync(historyFile(root))).toBe(false); // 零写入
    const forced = await reloadSelf(ctx, baseOpts(root, { force: true }));
    expect(forced.action).toBe('scheduled');
    expect(readReloadHistory(join(root, '.cycles')).entries).toHaveLength(1);
  });

  it('④ finalizeInFlight：改 reloaded + toRevision=当前指纹；再调 null 且文件字节不变', () => {
    const root = mkPluginRoot(true);
    const cyclesDir = join(root, '.cycles');
    const entry: ReloadHistoryEntry = {
      at: new Date().toISOString(), actor: 'anic_reload_self', reason: 'handshake', status: 'in-flight',
      fromRevision: 'old0000000000000', toRevision: null, staleAtRequest: true,
      warnings: [], pending: [], restartReason: null, error: null,
    };
    expect(appendReloadHistory(cyclesDir, entry).ok).toBe(true);
    const rev = computeBuildRevision(root)?.revision ?? null;
    const done = finalizeInFlight(cyclesDir, rev);
    expect(done?.status).toBe('reloaded');
    expect(done?.toRevision).toBe(rev);
    expect(done?.finalizedAt).toBeDefined();
    const bytes = readFileSync(historyFile(root), 'utf8');
    expect(finalizeInFlight(cyclesDir, rev)).toBeNull(); // 幂等：最后一条已不是 in-flight
    expect(readFileSync(historyFile(root), 'utf8')).toBe(bytes); // 零写入（字节级）
  });

  it('⑤ readReloadHistory：坏 JSON 响亮 error 且不抛；缺失 → 空数组 + error null', () => {
    const root = mkPluginRoot(true);
    const cyclesDir = join(root, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });
    expect(readReloadHistory(cyclesDir)).toEqual({ entries: [], error: null });
    writeFileSync(historyFile(root), '{ not json');
    const bad = readReloadHistory(cyclesDir);
    expect(bad.entries).toEqual([]);
    expect(bad.error).toContain('corrupt');
    // 追加时先备份 .corrupt 再重建——覆盖允许，静默销毁证据不允许
    expect(appendReloadHistory(cyclesDir, { ...entryOf('after-corrupt') }).ok).toBe(true);
    expect(existsSync(`${historyFile(root)}.corrupt`)).toBe(true);
    expect(readReloadHistory(cyclesDir).entries).toHaveLength(1);
  });

  it('⑥ 有界 FIFO：写 51 条 → 保留 50、dropped≥1，且丢的是最旧那条', () => {
    const root = mkPluginRoot(true);
    const cyclesDir = join(root, '.cycles');
    let last = { ok: false, dropped: 0 };
    for (let i = 0; i < 51; i += 1) last = appendReloadHistory(cyclesDir, entryOf(`r${String(i)}`));
    const { entries } = readReloadHistory(cyclesDir);
    expect(entries).toHaveLength(50);
    expect(last.dropped).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.reason).toBe('r1'); // r0 被 FIFO 丢弃
    expect(entries[49]?.reason).toBe('r50');
  });

  it('⑦ 反向自检：顺序对调 / 去掉 runExclusive 包裹 → 判定器必须返回 false（守卫有牙）', async () => {
    const root = mkPluginRoot(true);
    /** 每次判定用**全新**史账目录：上一轮的条目会污染「触发瞬间」快照（假阳性来源）。 */
    const freshCycles = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'anic-hr-hist-'));
      CLEANUPS.push(dir);
      return dir;
    };
    /** 判定器 A：触发瞬间史账里是否已有 in-flight。 */
    const orderPredicate = async (impl: (ctx: unknown, opts: ReloadSelfOptions) => Promise<unknown>): Promise<boolean> => {
      const cyclesDir = freshCycles();
      const { ctx, atTrigger } = mkHmrCtx(cyclesDir);
      await impl(ctx, { ...baseOpts(root), cyclesDir });
      await sleep(60);
      return atTrigger[0]?.some((e) => e.status === 'in-flight') === true;
    };
    /** 判定器 B：reconcileProfile 是否被 runExclusive 包裹。 */
    const wrappedPredicate = async (impl: (ctx: unknown, opts: ReloadSelfOptions) => Promise<unknown>): Promise<boolean> => {
      const cyclesDir = freshCycles();
      const { ctx, calls } = mkHmrCtx(cyclesDir);
      await impl(ctx, { ...baseOpts(root), cyclesDir });
      await sleep(60);
      const i = calls.indexOf('runExclusive');
      return i >= 0 && calls.indexOf('reconcileProfile:0') > i;
    };
    /** 破坏版 1：**同步先触发**、后落 in-flight（真·顺序对调；真实场景里此刻本实例已被杀）。 */
    const sabotagedOrder = async (ctx: unknown, opts: ReloadSelfOptions): Promise<unknown> => {
      const hmr = (ctx as { get: (k: string) => unknown }).get('hmr') as {
        runExclusive: (op: () => Promise<unknown>) => Promise<unknown>;
        reconcileProfile: () => Promise<unknown>;
      };
      await hmr.runExclusive(async () => hmr.reconcileProfile());
      appendReloadHistory(opts.cyclesDir, entryOf('late-in-flight'));
      return { action: 'scheduled' };
    };
    /** 破坏版 2：直接调 reconcileProfile（去掉 runExclusive 包裹）。 */
    const unwrapped = async (ctx: unknown, opts: ReloadSelfOptions): Promise<unknown> => {
      const hmr = (ctx as { get: (k: string) => unknown }).get('hmr') as { reconcileProfile: () => Promise<unknown> };
      appendReloadHistory(opts.cyclesDir, entryOf('unwrapped'));
      setTimeout(() => { void hmr.reconcileProfile(); }, 0);
      return { action: 'scheduled' };
    };
    // 真实实现两关全过；两个破坏版各自在对应判定器上判 false（=①里的断言会红）
    expect(await orderPredicate(reloadSelf)).toBe(true);
    expect(await orderPredicate(sabotagedOrder)).toBe(false);
    expect(await wrappedPredicate(reloadSelf)).toBe(true);
    expect(await wrappedPredicate(unwrapped)).toBe(false);
  });

  it('⑧ 路由：桩宿主真调 handler → 200/action=scheduled 且体含 fromRevision；409/412 同表', async () => {
    const root = mkPluginRoot(true);
    const hmrCtx = mkHmrCtx(join(root, '.cycles'));
    const registered: { path: string; handler: (req: unknown, res: unknown) => void }[] = [];
    const c = {
      webServer: { register: (d: { path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(d); return (): void => undefined; } },
      get: hmrCtx.ctx.get,
    };
    const disposers = registerHotReloadRoute(c, { send: mkSend(), getWorkspaceRoot: () => root, resolveRoot: () => root });
    expect(disposers).toHaveLength(1);
    const route = registered[0];
    expect(route?.path).toBe('/anic/api/reload');
    const res = await callRoute(route, { method: 'POST', url: '/anic/api/reload', body: JSON.stringify({ reason: 'deploy new dist' }) });
    expect(res.status).toBe(RELOAD_STATUS.scheduled);
    expect(res.status).toBe(200);
    expect(res.body?.action).toBe('scheduled');
    expect(typeof res.body?.fromRevision).toBe('string');
    // 无工作区 → 404（与其余路由同口径）
    const noWs = registerHotReloadRoute(c, { send: mkSend(), getWorkspaceRoot: () => null, resolveRoot: () => root });
    expect(noWs).toHaveLength(1);
    const res404 = await callRoute(registered[1], { method: 'POST', url: '/anic/api/reload', body: '{}' });
    expect(res404.status).toBe(404);
    // unavailable → 409；refused → 412（映射表与文档同一张）
    expect(RELOAD_STATUS.unavailable).toBe(409);
    expect(RELOAD_STATUS.refused).toBe(412);
  });

  it('⑨ 真实仓库：computeBuildRevision 有值（16 位指纹 + ISO builtAt）且 reloadSummary 只读', () => {
    const rev = computeBuildRevision(ROOT);
    expect(rev).not.toBeNull();
    expect(rev?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(rev?.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rev?.host).toMatch(/^[0-9a-f]{64}$/);
    const fresh = buildFreshness(ROOT);
    expect(typeof fresh.stale).toBe('boolean');
    const summary = reloadSummary(join(ROOT, '.cycles', 'none-such-cycle'), ROOT);
    expect(summary.revision).toBe(rev?.revision ?? null);
    expect(summary.historyCount).toBe(0);
    expect(summary.error).toBeNull();
    // 只读：查询一次不改动仓库（用 mtime 代理判断"没写历史文件"）
    expect(existsSync(join(ROOT, '.cycles', 'none-such-cycle', RELOAD_HISTORY_FILE))).toBe(false);
  });
});

/** 构造一条判别用条目（reason 用于 FIFO 断言）。 */
function entryOf(reason: string): ReloadHistoryEntry {
  return {
    at: new Date().toISOString(), actor: 'test', reason, status: 'in-flight',
    fromRevision: null, toRevision: null, staleAtRequest: true,
    warnings: [], pending: [], restartReason: null, error: null,
  };
}

interface Captured { status: number | null; body: Record<string, unknown> | null }

/** 最小 send：记录状态码与解析后的体（路由用 writeHead/end 两段）。 */
function mkSend(): (res: unknown, status: number, body: unknown) => void {
  return (res, status, body) => {
    (res as { __status?: number }).__status = status;
    (res as { __body?: unknown }).__body = body;
  };
}

/** 调 handler 并等到 async 分支落定（handler 内部 void run()，故需让出事件循环）。 */
async function callRoute(
  route: { handler: (req: unknown, res: unknown) => void } | undefined,
  req: unknown,
): Promise<Captured> {
  const res = {};
  route?.handler(req, res);
  await sleep(80);
  return {
    status: (res as { __status?: number }).__status ?? null,
    body: ((res as { __body?: Record<string, unknown> }).__body ?? null),
  };
}
