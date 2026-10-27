/**
 * 配置编辑器契约守卫（cycle-82）—— 写路径串的**行为级**证据。
 *
 * ## 被守卫的失败形态（都真实存在于同类实现里）
 *
 * 1. **备份没落盘就写正文**：中途失败后用户拿不回原文；
 * 2. **写了就宣布成功**：手术刀切错行时文件字节变了、语义没变，而响应说 ok
 *    （`autonomyActions.ts` 的文件头正是这条缺口的原始记录）；
 * 3. **回读失败不回滚**：磁盘停在半套配置上，比没改更危险；
 * 4. **.bak 无限堆积**把目录塞满，或在清理时误删用户自己的文件；
 * 5. **dryRun 与真写走不同实现**：预览说改一行、实际改五行；
 * 6. **路由直读 req.body**：真实宿主 body 是流（P0-BODY），参数静默丢弃。
 *
 * ## 纪律
 *
 * - 反向自检：每条"守卫生效"的断言都配一个"守卫失效会怎样"的对照；
 * - 扫描集非空：备份清单、变更清单都要有下限断言（空集上的相等毫无意义）；
 * - 真实文件系统：真目录 + 真 atomicWrite（mock fs 测不出 rename/权限语义）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_KEEP,
  BACKUP_PREFIX,
  applyConfigPatch,
  backupFileName,
  compactStamp,
  listBackups,
  pruneBackups,
} from '../../src/host/configEdit/configWriter.ts';
import { commentLines, splitLines } from '../../src/host/configEdit/yamlText.ts';
import { diffStats } from '../../src/host/configEdit/yamlDiff.ts';
import { planPatch } from '../../src/host/configEdit/yamlPatch.ts';
import { readFieldValue } from '../../src/host/configEdit/configRead.ts';
import { fieldById } from '../../src/host/configEdit/configSchema.ts';
import { registerConfigRoute, CONFIG_ROUTE } from '../../src/host/routes/configRoute.ts';
import type { RouteReq } from '../../src/host/routes/routeContext.ts';

const TMP = mkdtempSync(join(tmpdir(), 'anic-config-contract-'));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理竞态容忍 */ } });

const CONFIG_SAMPLE = [
  'project:',
  '  name: "demo"',
  '  tech_stack: ["typescript"]',
  '',
  'macro_cycle:',
  '  # 为什么显式写预算：默认值会让「超预算」淹没在告警疲劳里',
  '  autonomy_level: L4',
  '  complexity_budget: 100',
  '',
  'build:',
  '  build_cmd: "node scripts/build.mjs"',
  '  test_cmd: node scripts/run-tests.mjs',
  '',
].join('\n');

function makeCycles(tag: string, content = CONFIG_SAMPLE): string {
  const dir = join(TMP, `ws-${tag}`, '.cycles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), content, 'utf-8');
  return dir;
}

describe('write 串一：备份先于正文，且 .bak 只留最近 3 份', () => {
  it('成功后生成 .bak，内容是**改动前**的原文', () => {
    const cycles = makeCycles('backup');
    const original = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const out = applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L3' });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.backupPath).not.toBeNull();
    expect(readFileSync(out.backupPath as string, 'utf-8')).toBe(original);
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toContain('autonomy_level: L3');
  });

  it('连写 5 次 → 只在 3 份（按名排序删最旧）', () => {
    const cycles = makeCycles('prune');
    for (let i = 0; i < 5; i += 1) {
      // 每次写不同值，确保有真实变化（幂等会跳过写）
      const out = applyConfigPatch(cycles, { 'macro_cycle.complexity_budget': 100 + i }, { now: new Date(Date.UTC(2026, 9, 27, 3, 0, i)) });
      expect(out.ok).toBe(true);
    }
    const backups = listBackups(cycles);
    expect(backups).toHaveLength(BACKUP_KEEP);
    // 最旧的两份（...030000 / ...030001）被删，留下最近三次写入的备份
    // 时间戳保留毫秒（同秒连写不撞名的前提）⇒ 形如 20261027T030002000Z
    expect(backups[0]).toContain('20261027T030002000Z');
    expect(backups[2]).toContain('20261027T030004000Z');
    // 反向自检：被删的那两份真的不在（不是"碰巧只有 5 份"）
    expect(backups.some((n) => n.includes('030000000Z'))).toBe(false);
    expect(backups.some((n) => n.includes('030001000Z'))).toBe(false);
  });

  it('清理只删自己的前缀，绝不删用户文件', () => {
    const cycles = makeCycles('keepuser');
    // 用户自己的备份命名（不是我们造的）
    writeFileSync(join(cycles, 'config.yml.old-my-backup'), 'user-owned', 'utf-8');
    writeFileSync(join(cycles, 'config.yml.bak_NOT_MINE'), 'user-owned-2', 'utf-8');
    for (let i = 0; i < 5; i += 1) {
      applyConfigPatch(cycles, { 'macro_cycle.complexity_budget': 200 + i }, { now: new Date(Date.UTC(2026, 9, 27, 4, 0, i)) });
    }
    expect(listBackups(cycles)).toHaveLength(BACKUP_KEEP);
    // 用户的文件都还在
    expect(existsSync(join(cycles, 'config.yml.old-my-backup'))).toBe(true);
    expect(existsSync(join(cycles, 'config.yml.bak_NOT_MINE'))).toBe(true);
    // 反向自检：前缀判定不是"含 bak 就算"——`config.yml.bak_NOT_MINE` 不被 listBackups 认领
    expect(listBackups(cycles).some((n) => n.includes('NOT_MINE'))).toBe(false);
  });

  it('备份命名可排序：紧凑时间戳单调（含毫秒，Windows 文件名安全）', () => {
    const a = backupFileName(new Date('2026-10-27T11:12:21.123Z'));
    const b = backupFileName(new Date('2026-10-27T11:12:21.999Z'));
    expect(compactStamp(new Date('2026-10-27T11:12:21.123Z'))).toBe('20261027T111221123Z');
    // 同一秒内：毫秒差仍能排序（去掉毫秒就会撞名 → 清理无法区分新旧）
    expect(a < b).toBe(true);
    expect(a.startsWith(BACKUP_PREFIX)).toBe(true);
    // Windows 文件名禁用字符一个都不许出现
    expect(a).not.toMatch(/[:*?"<>|]/);
    // 同毫秒多次写入：序号后缀兜底，仍可排序且不撞名
    expect(backupFileName(new Date('2026-10-27T11:12:21.123Z'), 1)).not.toBe(a);
    expect(a < backupFileName(new Date('2026-10-27T11:12:21.123Z'), 1)).toBe(true);
  });

  it('pruneBackups 在 keep 大于总数时不动任何文件', () => {
    const cycles = makeCycles('prune-noop');
    writeFileSync(join(cycles, backupFileName(new Date('2026-01-01T00:00:00Z'))), 'x', 'utf-8');
    const r = pruneBackups(cycles, 3);
    expect(r.deleted).toEqual([]);
    expect(r.kept).toHaveLength(1);
  });
});

describe('write 串二：回读断言与回滚', () => {
  it('正常写入：回读值与目标值一致（observed 非空）', () => {
    const cycles = makeCycles('readback-ok');
    const out = applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' });
    expect(out.ok).toBe(true);
    expect(out.observed?.['macro_cycle.autonomy_level']).toBe('L2');
    // loader 交叉确认项在场（证明回读真的走了 INV-25 唯一入口）
    expect(out.observed?.loader).toBeDefined();
    expect(out.observed?.loader).toMatchObject({ 'macro_cycle.autonomy_level': 'L2' });
  });

  it('回读不一致 → ok=false、回滚到原文、error 说清 mismatch', () => {
    const cycles = makeCycles('readback-fail');
    const original = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const out = applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L3' }, {
      // 注入：写完后把磁盘改回旧值（模拟"写了但没生效"——手术刀切错行的真实形态）
      beforeWrite: () => { writeFileSync(join(cycles, 'config.yml'), original, 'utf-8'); },
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.error).toContain('readback mismatch');
    expect(out.error).toContain('rolled back');
    // 磁盘事实 = 原文（回滚成功）
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(original);
    // .bak 仍在（用户仍能人工核对）
    expect(out.backupPath).not.toBeNull();
    expect(readFileSync(out.backupPath as string, 'utf-8')).toBe(original);
  });

  it('注入 verify 判失败也能触发回滚（断言失败不依赖具体实现细节）', () => {
    const cycles = makeCycles('verify-hook');
    const original = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const out = applyConfigPatch(cycles, { 'build.test_cmd': 'node other.mjs' }, {
      verify: () => ({ ok: false, observed: { probe: 'forced' }, error: 'forced mismatch' }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('forced mismatch');
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(original);
    expect(out.observed).toEqual({ probe: 'forced' });
  });

  it('非法值：零写入、零备份（连 .bak 都不该产生）', () => {
    const cycles = makeCycles('illegal');
    const before = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const out = applyConfigPatch(cycles, { 'project.name': 'a\n  evil: true' });
    expect(out.ok).toBe(false);
    expect(out.backupPath).toBeNull();
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(before);
    expect(listBackups(cycles)).toHaveLength(0);
  });

  it('无变化：ok=true / applied=false / 不产生备份（保存未修改的表单必须零副作用）', () => {
    const cycles = makeCycles('noop');
    const out = applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L4' });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.backupPath).toBeNull();
    expect(listBackups(cycles)).toHaveLength(0);
  });

  it('config.yml 缺失：ok=false 且明确指引（不静默创建空配置）', () => {
    const empty = join(TMP, 'ws-missing', '.cycles');
    mkdirSync(empty, { recursive: true });
    const out = applyConfigPatch(empty, { 'project.name': 'x' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('not found');
    expect(existsSync(join(empty, 'config.yml'))).toBe(false);
  });

  it('注释保留在**真实写入路径**上（不是只在 planPatch 里成立）', () => {
    const cycles = makeCycles('comment-write');
    const beforeComments = commentLines(splitLines(readFileSync(join(cycles, 'config.yml'), 'utf-8')));
    expect(beforeComments.length).toBeGreaterThan(0);
    applyConfigPatch(cycles, { 'macro_cycle.complexity_budget': 150, 'build.test_cmd': 'node t.mjs --fast' });
    const afterComments = commentLines(splitLines(readFileSync(join(cycles, 'config.yml'), 'utf-8')));
    expect(afterComments).toEqual(beforeComments);
  });
});

describe('契约：dryRun 与真写必须同源', () => {
  it('dryRun 的 after 与真写落盘内容逐字节相同', () => {
    const cycles = makeCycles('dryrun');
    const before = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const patch = { 'macro_cycle.autonomy_level': 'L2', 'build.test_cmd': 'node dry.mjs' };
    const planned = planPatch(before, patch);
    const out = applyConfigPatch(cycles, patch);
    expect(out.ok).toBe(true);
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(planned.after);
    // 差异行数 = 2 × 改动字段数（两个字段，都是原位替换）
    expect(diffStats(planned.before, planned.after)).toEqual({ changed: 4, added: 2, removed: 2 });
    expect(planned.changedFields).toHaveLength(2);
  });

  it('差异行数 != 改动字段数 ⇒ 说明手术刀切到了别的行（反向自检）', () => {
    const plan = planPatch(CONFIG_SAMPLE, { 'macro_cycle.autonomy_level': 'L3' });
    expect(diffStats(plan.before, plan.after).changed).toBe(2);
    // 人为多改一行：差异行数必须跟着变（比对不是恒真）
    const tampered = plan.after.replace('project:', 'project:  # x');
    expect(diffStats(plan.before, tampered).changed).toBe(4);
  });
});

// ── 路由层：真实 readBody 语义（桩宿主 body 对象 + 真实宿主流式） ──

type Handler = (req: unknown, res: unknown) => void;

function makeCtx(): { ctx: unknown; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  return {
    ctx: {
      webServer: {
        register(route: { kind: string; path: string; handler: Handler }) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    },
    routes,
  };
}

function makeRes() {
  const captured: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) { captured.status = status; },
    setHeader() { /* headers 不参与断言 */ },
    end(chunk?: string) {
      captured.body = typeof chunk === 'string' ? JSON.parse(chunk) : undefined;
    },
  };
  return { captured, res };
}

/** 流式假请求：真实宿主 IncomingMessage 的最小表面（无 body 字段，只有 on）。 */
function streamReq(url: string, method: string, chunks: string[]): RouteReq {
  const ee = new EventEmitter();
  Object.assign(ee, { url, method });
  queueMicrotask(() => {
    for (const c of chunks) ee.emit('data', Buffer.from(c, 'utf-8'));
    ee.emit('end');
  });
  return ee as unknown as RouteReq;
}

/** 造一个带 workspaceRegistry 的宿主 ctx（resolveWorkspaceRoots 的采信来源之一）。 */
function hostCtx(ws: string): ReturnType<typeof makeCtx> {
  const base = makeCtx();
  (base.ctx as Record<string, unknown>)['workspaceRegistry'] = { list: () => [{ path: ws }] };
  return base;
}

async function callRoute(routes: Map<string, Handler>, req: RouteReq): Promise<{ status: number; body: unknown }> {
  const handler = routes.get(CONFIG_ROUTE);
  if (!handler) throw new Error(`route not registered: ${CONFIG_ROUTE}`);
  const { captured, res } = makeRes();
  handler(req, res);
  // POST 路径走 readBody().then —— 让微任务队列排空
  await new Promise((r) => setTimeout(r, 5));
  return captured;
}

describe('路由：GET 事实 / POST dryRun / POST 真写', () => {
  const WS = join(TMP, 'ws-route');
  const cycles = join(WS, '.cycles');
  mkdirSync(cycles, { recursive: true });
  writeFileSync(join(cycles, 'config.yml'), CONFIG_SAMPLE, 'utf-8');
  const { ctx, routes } = hostCtx(WS);
  registerConfigRoute(ctx, {
    send: (res, status, body) => {
      const r = res as { writeHead(s: number): void; end(c?: string): void };
      r.writeHead(status);
      r.end(JSON.stringify(body));
    },
    getWorkspaceRoot: () => WS,
  });

  it('GET：返回 values + schema + paths + rawHash + warnings', async () => {
    const out = await callRoute(routes, { url: CONFIG_ROUTE, method: 'GET' } as RouteReq);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['workspace', 'values', 'schema', 'paths', 'warnings', 'rawHash', 'configFile', 'backups']));
    const values = body['values'] as Record<string, unknown>;
    expect(values['macro_cycle.autonomy_level']).toBe('L4');
    expect((body['schema'] as unknown[]).length).toBeGreaterThan(15);
    expect((body['rawHash'] as string)).toMatch(/^[0-9a-f]{16}$/);
    expect((body['paths'] as { entries: unknown[] }).entries.length).toBeGreaterThan(10);
  });

  it('GET ?probePath=：界外路径被拒且**不返回任何文件内容**', async () => {
    const out = await callRoute(routes, { url: `${CONFIG_ROUTE}?probePath=..%2Fsecret`, method: 'GET' } as RouteReq);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect((body['values'] as Record<string, unknown>)['project.name']).toBeUndefined();
    expect(JSON.stringify(body['warnings'])).toContain('..');
    expect((body['probe'] as { ok: boolean }).ok).toBe(false);
  });

  it('POST dryRun：不写盘，返回 diff 与统计', async () => {
    const before = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    // 真实宿主流式 body（req.body 恒 undefined）
    const out = await callRoute(routes, streamReq(CONFIG_ROUTE, 'POST', ['{"patch":{"macro_cycle.autonomy_level":', '"L2"},"dryRun":true}']));
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body['dryRun']).toBe(true);
    expect(body['applied']).toBe(false);
    expect(body['changedFields']).toEqual(['macro_cycle.autonomy_level']);
    expect((body['diff'] as unknown[]).length).toBe(2);
    expect(body['stats']).toEqual({ changed: 2, added: 1, removed: 1 });
    // 磁盘零变化
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(before);
  });

  it('POST 真写（桩宿主 body 对象形态）：applied=true + 备份 + 回读', async () => {
    const out = await callRoute(routes, {
      url: CONFIG_ROUTE, method: 'POST', body: { patch: { 'build.test_cmd': 'node t.mjs --fast' } },
    } as RouteReq);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body['applied']).toBe(true);
    expect(body['backupPath']).toBeTruthy();
    expect(body['afterHash']).not.toBe(body['beforeHash']);
    const disk = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    expect(disk).toContain('node t.mjs --fast');
    expect(readFieldValue(disk, fieldById('build.test_cmd') as never)).toBe('node t.mjs --fast');
  });

  it('POST 非法 patch：400 且零写入', async () => {
    const before = readFileSync(join(cycles, 'config.yml'), 'utf-8');
    const out = await callRoute(routes, {
      url: CONFIG_ROUTE, method: 'POST', body: { patch: { 'macro_cycle.autonomy_level': 'L9' } },
    } as RouteReq);
    expect(out.status).toBe(400);
    expect((out.body as Record<string, unknown>)['ok']).toBe(false);
    expect(readFileSync(join(cycles, 'config.yml'), 'utf-8')).toBe(before);
  });

  it('POST patch 不是对象：400 明确原因', async () => {
    const out = await callRoute(routes, { url: CONFIG_ROUTE, method: 'POST', body: { patch: 'nope' } } as RouteReq);
    expect(out.status).toBe(400);
    expect((out.body as Record<string, unknown>)['error']).toBe('ANIC_CONFIG_BAD_PATCH');
  });

  it('无工作区：404（不猜一个默认工作区写进去）', async () => {
    const empty = makeCtx();
    registerConfigRoute(empty.ctx, {
      send: (res, status, body) => {
        const r = res as { writeHead(s: number): void; end(c?: string): void };
        r.writeHead(status);
        r.end(JSON.stringify(body));
      },
      getWorkspaceRoot: () => null,
    });
    const handler = empty.routes.get(CONFIG_ROUTE) as Handler;
    const { captured, res } = makeRes();
    handler({ url: CONFIG_ROUTE, method: 'GET' }, res);
    expect(captured.status).toBe(404);
  });

  it('GET 无 config.yml：如实缺省（warnings 点名 + values 为空），不伪造值', async () => {
    const bare = join(TMP, 'ws-bare');
    mkdirSync(join(bare, '.cycles'), { recursive: true });
    const h = makeCtx();
    registerConfigRoute(h.ctx, {
      send: (res, status, body) => {
        const r = res as { writeHead(s: number): void; end(c?: string): void };
        r.writeHead(status);
        r.end(JSON.stringify(body));
      },
      getWorkspaceRoot: () => bare,
    });
    const handler = h.routes.get(CONFIG_ROUTE) as Handler;
    const { captured, res } = makeRes();
    handler({ url: CONFIG_ROUTE, method: 'GET' }, res);
    const body = captured.body as Record<string, unknown>;
    expect(captured.status).toBe(200);
    expect(body['values']).toEqual({});
    expect(body['rawHash']).toBeNull();
    expect(JSON.stringify(body['warnings'])).toContain('config.yml 不存在');
  });

  it('反向自检：备份清单扫描集非空（空集上的"只留 3 份"是假绿）', () => {
    const backups = readdirSync(cycles).filter((n) => n.startsWith(BACKUP_PREFIX));
    expect(backups.length).toBeGreaterThan(0);
  });
});
