/**
 * 调用归属（cycle-71 T-10501）单元测试 —— 白盒四元组「流程流向」元的 join key。
 *
 * 被测面：
 *  - `invocationAttribution.ts`：工作区解析（session cwd → 唯一候选 → 否则不填）、
 *    真夹具读盘、降级（缺失/损坏/类型不对）、TTL 缓存、抛错兜底；
 *  - `invocationFeed.ts`：`recordCall` 的 attribution 落字段（空值不落）；
 *  - `invocationFeedAttach.ts`：事件到达时解析并落字段（含解析器抛错不断流）。
 *
 * 纪律钉（INV-27 宁缺勿猜）：
 *  - **反例优先**：「工作区不可解析」必须返回 undefined 且不抛 —— 归属的可信度
 *    全靠这条；一旦有人加 `process.cwd()` 兜底，这些用例立刻红。
 *  - 既有语义零回归：过滤 / drop-oldest / 配对 / orphan 阈值 / 副本语义各 ≥1 钉。
 *  - 向后兼容：无归属字段的旧记录仍能序列化并被消费方形状接受。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTRIBUTION_TTL_MS,
  attributionFor,
  createInvocationAttributor,
  readAttributionFromDisk,
  workspaceOfSession,
  type InvocationAttribution,
} from '../../src/host/runtime/invocationAttribution.ts';
import { createInvocationFeed, type InvocationFeed } from '../../src/host/runtime/invocationFeed.ts';
import { attachInvocationFeed } from '../../src/host/runtime/invocationFeedAttach.ts';
import { registerInvocationRoute } from '../../src/host/routes/invocationRoute.ts';

/* ------------------------------------------------------------------ */
/* 夹具：真实 .cycles/workflow-state.json 形状（本机 cycle-71/build）    */
/* ------------------------------------------------------------------ */

const TMPS: string[] = [];

afterEach(() => {
  while (TMPS.length > 0) {
    const d = TMPS.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 并行竞态忽略 */ }
  }
});

/** 建一个工作区夹具目录（可选写入 workflow-state.json 的原始文本）。 */
function mkWorkspace(raw?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-attr-'));
  TMPS.push(dir);
  mkdirSync(join(dir, '.cycles'), { recursive: true });
  if (raw !== undefined) writeFileSync(join(dir, '.cycles', 'workflow-state.json'), raw, 'utf-8');
  return dir;
}

/** 真夹具：本机实测形状（currentCycle=cycle-71 / currentPhase=build）。 */
function realStateRaw(over: { currentCycle?: string | null; currentPhase?: string | null } = {}): string {
  return JSON.stringify({
    currentPhase: over.currentPhase === undefined ? 'build' : over.currentPhase,
    currentCycle: over.currentCycle === undefined ? 'cycle-71' : over.currentCycle,
    phaseHistory: [{ note: 'cycle-42 漂移校正', at: '2026-10-21T13:40:00+08:00' }],
    nodeStatus: {},
    createdAt: '2026-10-18T07:40:17.328Z',
    updatedAt: '2026-10-21T21:31:47.075Z',
  });
}

/** session 形状：官方 SessionHeader.cwd（asar 实测）在 header 下。 */
function sessionAt(cwd: string | undefined): unknown {
  return cwd === undefined ? {} : { header: { cwd } };
}

/* ------------------------------------------------------------------ */
/* 1. 工作区解析（含降级语义）                                            */
/* ------------------------------------------------------------------ */

describe('workspaceOfSession（工作区解析：不猜）', () => {
  it('session.header.cwd 优先（正常路径）', () => {
    const ws = mkWorkspace();
    expect(workspaceOfSession(sessionAt(ws), {})).toBe(ws);
  });
  it('无 session cwd → 宿主已知工作区唯一候选才采信（registry ∪ sessions）', () => {
    const only = mkWorkspace();
    expect(workspaceOfSession({}, { sessions: { list: () => [{ header: {} }] }, workspaceRegistry: { list: () => [{ path: only }] } })).toBe(only);
    // sessions 侧的 cwd 与 registry 侧同一路径 → 去重后仍唯一
    expect(workspaceOfSession({}, { sessions: { list: () => [{ header: { cwd: only } }] }, workspaceRegistry: { list: () => [{ path: only }] } })).toBe(only);
  });
  it('多会话歧义（去重后 ≥2）→ null：绝不按「首条」猜（归错工作区 = 伪造）', () => {
    const a = mkWorkspace();
    const b = mkWorkspace();
    expect(workspaceOfSession({}, { workspaceRegistry: { list: () => [{ path: a }, { path: b }] } })).toBeNull();
    // session cwd 在场时不受歧义影响（有明确答案就不叫歧义）
    expect(workspaceOfSession(sessionAt(a), { workspaceRegistry: { list: () => [{ path: a }, { path: b }] } })).toBe(a);
  });
  it('无候选（0 个）→ null：不用 process.cwd() 兜底', () => {
    expect(workspaceOfSession({}, {})).toBeNull();
    expect(workspaceOfSession({}, { workspaceRegistry: { list: () => [] }, sessions: { list: () => [] } })).toBeNull();
  });
  it('宿主面 list() 抛错 / 返回非数组 → 不抛，按无候选处理', () => {
    expect(workspaceOfSession({}, { workspaceRegistry: { list: () => { throw new Error('boom'); } } })).toBeNull();
    expect(workspaceOfSession({}, { sessions: { list: () => { throw new Error('boom'); } } })).toBeNull();
  });
  it('session header 形状畸形（cwd 非字符串/空串）→ 不采信该值', () => {
    expect(workspaceOfSession({ header: { cwd: 42 } }, {})).toBeNull();
    expect(workspaceOfSession({ header: { cwd: '' } }, {})).toBeNull();
    expect(workspaceOfSession(null, {})).toBeNull();
    expect(workspaceOfSession(undefined, {})).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2. 真夹具读盘：归属字段被填上                                         */
/* ------------------------------------------------------------------ */

describe('readAttributionFromDisk（真夹具：cycle/phase）', () => {
  it('标准夹具 → { cycle: "cycle-71", phase: "build" }', () => {
    const ws = mkWorkspace(realStateRaw());
    expect(readAttributionFromDisk(ws)).toEqual({ cycle: 'cycle-71', phase: 'build' });
  });
  it('只有 currentPhase → 只填 phase（缺的字段不伪造）', () => {
    const ws = mkWorkspace(JSON.stringify({ currentPhase: 'test', currentCycle: null }));
    expect(readAttributionFromDisk(ws)).toEqual({ phase: 'test' });
  });
  it('只有 currentCycle 是字符串 → 只填 cycle', () => {
    const ws = mkWorkspace(JSON.stringify({ currentCycle: 'cycle-71' }));
    expect(readAttributionFromDisk(ws)).toEqual({ cycle: 'cycle-71' });
  });
});

/* ------------------------------------------------------------------ */
/* 3. 降级路径（至少 3 个：缺失 / 损坏 JSON / 类型不对 —— 全部不抛不填）   */
/* ------------------------------------------------------------------ */

describe('readAttributionFromDisk 降级（宁缺勿猜）', () => {
  it('workflow-state.json 缺失 → null（不抛）', () => {
    const ws = mkWorkspace(); // .cycles 存在但无状态文件
    expect(() => readAttributionFromDisk(ws)).not.toThrow();
    expect(readAttributionFromDisk(ws)).toBeNull();
  });
  it('JSON 损坏 → null（不抛）', () => {
    const ws = mkWorkspace('{broken json');
    expect(() => readAttributionFromDisk(ws)).not.toThrow();
    expect(readAttributionFromDisk(ws)).toBeNull();
  });
  it('形状不对（非对象 / 字段类型不对 / 空串）→ null 或只填合法的字段', () => {
    expect(readAttributionFromDisk(mkWorkspace('"just a string"'))).toBeNull();
    expect(readAttributionFromDisk(mkWorkspace('null'))).toBeNull();
    expect(readAttributionFromDisk(mkWorkspace(JSON.stringify({ currentPhase: 7, currentCycle: {} })))).toBeNull();
    expect(readAttributionFromDisk(mkWorkspace(JSON.stringify({ currentPhase: '', currentCycle: '' })))).toBeNull();
  });
  it('工作区目录本身不存在 → null（不抛）', () => {
    expect(readAttributionFromDisk(join(tmpdir(), '__anic_attr_missing__'))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. TTL 缓存（命中不重复读盘；过期重读）                                 */
/* ------------------------------------------------------------------ */

describe('createInvocationAttributor（TTL 缓存）', () => {
  it('同一工作区连续解析命中缓存：读盘计数不增（TTL 内）', () => {
    let reads = 0;
    const attr = createInvocationAttributor({}, {
      read: (): InvocationAttribution => { reads++; return { cycle: 'cycle-71', phase: 'build' }; },
      now: () => 1000,
    });
    for (let i = 0; i < 5; i++) attr(sessionAt('/ws/a'));
    expect(reads).toBe(1); // 5 次事件 → 1 次读盘
  });
  it('超过 TTL → 重新读盘（边界：正好 TTL 时命中，TTL+1 时读）', () => {
    let reads = 0;
    let clock = 0;
    const attr = createInvocationAttributor({}, {
      read: (): InvocationAttribution => { reads++; return { phase: 'build' }; },
      now: () => clock,
    });
    attr(sessionAt('/ws/a'));
    clock = ATTRIBUTION_TTL_MS - 1;
    attr(sessionAt('/ws/a'));
    expect(reads).toBe(1); // TTL 内命中
    clock = ATTRIBUTION_TTL_MS;
    attr(sessionAt('/ws/a'));
    expect(reads).toBe(2); // 恰好到期 → 重读
  });
  it('不同工作区分键：各自读一次（互不污染）', () => {
    const seen: string[] = [];
    const attr = createInvocationAttributor({}, {
      read: (ws: string): InvocationAttribution => { seen.push(ws); return { cycle: `c:${ws}` }; },
      now: () => 0,
    });
    attr(sessionAt('/ws/a'));
    attr(sessionAt('/ws/b'));
    attr(sessionAt('/ws/a'));
    expect(seen).toEqual(['/ws/a', '/ws/b']);
    expect(attr(sessionAt('/ws/b'))?.cycle).toBe('c:/ws/b');
  });
  it('负结果也缓存（缺失/损坏不每个事件重读盘）', () => {
    let reads = 0;
    const attr = createInvocationAttributor({}, { read: (): InvocationAttribution | null => { reads++; return null; }, now: () => 0 });
    expect(attr(sessionAt('/ws/a'))).toBeNull();
    expect(attr(sessionAt('/ws/a'))).toBeNull();
    expect(reads).toBe(1);
  });
  it('工作区不可解析 → 直接 null，且不读盘（不缓存「猜」的结果）', () => {
    let reads = 0;
    const attr = createInvocationAttributor({}, { read: (): InvocationAttribution | null => { reads++; return { cycle: 'x' }; } });
    expect(attr({})).toBeNull();
    expect(reads).toBe(0);
  });
  it('注入的 read 抛错 → 不抛、返回 null；且失败不缓存（下次重试而不是钉成 2s 假阴性）', () => {
    let reads = 0;
    const attr = createInvocationAttributor({}, {
      read: (): InvocationAttribution | null => { reads++; throw new Error('io'); },
      now: () => 0,
    });
    expect(() => attr(sessionAt('/ws/a'))).not.toThrow();
    expect(attr(sessionAt('/ws/a'))).toBeNull();
    expect(reads).toBe(2); // 失败未缓存 → 每个事件都重试（同一时刻也不会被缓存吞掉）
  });
  it('读取器先坏后好：失败不缓存，恢复后立刻拿到归属（无需等 TTL）', () => {
    let reads = 0;
    let broken = true;
    const attr = createInvocationAttributor({}, {
      read: (): InvocationAttribution | null => { reads++; if (broken) throw new Error('io'); return { cycle: 'cycle-71' }; },
      now: () => 0, // 时钟不动：若失败被缓存，下面的成功读数永远拿不到
    });
    expect(attr(sessionAt('/ws/a'))).toBeNull(); // 坏
    broken = false;
    expect(attr(sessionAt('/ws/a'))?.cycle).toBe('cycle-71'); // 同刻恢复即生效
    expect(reads).toBe(2);
  });
  it('默认接线（无注入）用真 fs 读夹具', () => {
    const ws = mkWorkspace(realStateRaw());
    const attr = createInvocationAttributor({});
    expect(attr(sessionAt(ws))).toEqual({ cycle: 'cycle-71', phase: 'build' });
  });
});

describe('attributionFor（事件路径包装）', () => {
  it('解析器缺失 → null；解析器抛错 → null（归属永不阻断调用流）', () => {
    expect(attributionFor(sessionAt('/ws'), undefined)).toBeNull();
    expect(attributionFor(sessionAt('/ws'), () => { throw new Error('boom'); })).toBeNull();
  });
  it('解析器返回 undefined → null（统一空语义）', () => {
    expect(attributionFor(sessionAt('/ws'), () => undefined as unknown as InvocationAttribution)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 5. feed 落字段（含空值不落 / 终态不改写）                               */
/* ------------------------------------------------------------------ */

describe('InvocationRecord 归属字段（feed 侧）', () => {
  it('recordCall 落 cycle/phase；随快照序列化', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}', attribution: { cycle: 'cycle-71', phase: 'build' } });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.cycle).toBe('cycle-71');
    expect(rec?.phase).toBe('build');
  });
  it('attribution 为 null/undefined → 字段**不存在**（不是空串占位）', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}' });
    feed.recordCall({ callId: 'c2', name: 'anic_status', arguments: '{}', attribution: null });
    const [c2, c1] = feed.snapshot().invocations;
    for (const rec of [c1, c2]) {
      expect(rec && 'cycle' in rec).toBe(false);
      expect(rec && 'phase' in rec).toBe(false);
    }
  });
  it('归属部分缺失 → 只落真实存在的那个字段', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}', attribution: { phase: 'build' } });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.phase).toBe('build');
    expect(rec && 'cycle' in rec).toBe(false);
  });
  it('终态不改写归属（归属 = 调用发生时的坐标）', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}', attribution: { cycle: 'cycle-71', phase: 'build' } });
    feed.recordResult('c1', { isError: false });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.status).toBe('done');
    expect(rec?.cycle).toBe('cycle-71');
    expect(rec?.phase).toBe('build');
  });
});

/* ------------------------------------------------------------------ */
/* 6. 接线：事件到达时解析（方案 A′ 的端到端形态）                          */
/* ------------------------------------------------------------------ */

function makeEventCtx(): { ctx: unknown; emit: (name: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const ctx = { on: (name: string, handler: (...a: unknown[]) => void): void => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } };
  return { ctx, emit: (name: string, ...args: unknown[]) => { for (const h of handlers.get(name) ?? []) h(...args); } };
}

describe('attachInvocationFeed 归属接线（方案 A′）', () => {
  it('session/event 第一参 session 的 cwd → 归属落到该调用', () => {
    const ws = mkWorkspace(realStateRaw());
    const { ctx, emit } = makeEventCtx();
    const feed = attachInvocationFeed(ctx, createInvocationFeed(), { resolveAttribution: createInvocationAttributor({}) });
    emit('session/event', sessionAt(ws), { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'a1', name: 'anic_status', arguments: '{}' } });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.cycle).toBe('cycle-71');
    expect(rec?.phase).toBe('build');
  });
  it('拿不到工作区 → 字段不落（降级），既有过滤/配对语义不变', () => {
    const { ctx, emit } = makeEventCtx();
    const feed = attachInvocationFeed(ctx, createInvocationFeed(), { resolveAttribution: createInvocationAttributor({}) });
    emit('session/event', {}, { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'a1', name: 'anic_status', arguments: '{}' } });
    emit('tools/result', { callId: 'a1', name: 'anic_status' }, { isError: false, content: [] });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.status).toBe('done'); // 配对语义不变
    expect(rec && 'cycle' in rec).toBe(false);
    expect(feed.diagnostics?.().anicResults).toBe(1);
  });
  it('解析器抛错 → 不抛、调用仍进流（归属不得阻断调用流）', () => {
    const { ctx, emit } = makeEventCtx();
    const feed = attachInvocationFeed(ctx, createInvocationFeed(), { resolveAttribution: () => { throw new Error('resolver boom'); } });
    expect(() => emit('session/event', sessionAt('/ws'), { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'a1', name: 'anic_status', arguments: '{}' } })).not.toThrow();
    expect(feed.snapshot().total).toBe(1);
  });
  it('未注入解析器（旧调用形态）→ 行为与 cycle-71 之前一致，仅无归属', () => {
    const { ctx, emit } = makeEventCtx();
    const feed = attachInvocationFeed(ctx, createInvocationFeed());
    emit('session/event', sessionAt(mkWorkspace(realStateRaw())), { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'a1', name: 'anic_status', arguments: '{}' } });
    const rec = feed.snapshot().invocations[0];
    expect(rec?.name).toBe('anic_status');
    expect(rec && 'cycle' in rec).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 既有语义零回归钉 + 向后兼容钉                                      */
/* ------------------------------------------------------------------ */

describe('既有语义零回归（归属是纯观测元数据）', () => {
  it('过滤面不变：无关工具/其他技能/非 tool/call 仍被过滤', () => {
    const ws = mkWorkspace(realStateRaw());
    const { ctx, emit } = makeEventCtx();
    const feed = attachInvocationFeed(ctx, createInvocationFeed(), { resolveAttribution: createInvocationAttributor({}) });
    emit('session/event', sessionAt(ws), { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'x1', name: 'read', arguments: '{}' } });
    emit('session/event', sessionAt(ws), { type: 'tool/call', seq: 0, time: Date.now(), data: { callId: 'x2', name: 'skill', arguments: '{"name":"ponytail"}' } });
    emit('session/event', sessionAt(ws), { type: 'turn/start', seq: 0, time: Date.now(), data: {} });
    expect(feed.snapshot().total).toBe(0);
    expect(feed.diagnostics?.().sessionToolCalls).toBe(2);
    expect(feed.diagnostics?.().anicCalls).toBe(0);
  });
  it('drop-oldest 不变：上限 3 逐出最旧，被逐出者不再可配对（归属也不残留）', () => {
    const feed = createInvocationFeed(3);
    for (let i = 0; i < 4; i++) {
      feed.recordCall({ callId: `c${String(i)}`, name: 'anic_status', arguments: '', attribution: { cycle: `cycle-${String(i)}` } });
    }
    const snap = feed.snapshot();
    expect(snap.invocations.map((r) => r.callId)).toEqual(['c3', 'c2', 'c1']);
    expect(snap.invocations.map((r) => r.cycle)).toEqual(['cycle-3', 'cycle-2', 'cycle-1']);
    expect(feed.recordResult('c0', { isError: false })).toBe(false);
  });
  it('配对语义不变：结束先于开始不伪造；同 callId 重复 call 不覆盖首见归属', () => {
    const feed = createInvocationFeed();
    expect(feed.recordResult('ghost', { isError: false })).toBe(false);
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '', attribution: { phase: 'build' } });
    feed.recordResult('c1', { isError: false });
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '', attribution: { phase: 'test' } }); // 迟到重放
    expect(feed.snapshot().total).toBe(1);
    expect(feed.snapshot().invocations[0]?.phase).toBe('build');
  });
  it('orphan 阈值不变：>15 分钟才标记 possiblyOrphaned，且归属不影响判定', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '', attribution: { cycle: 'cycle-71' } });
    expect(feed.snapshot(Date.now() + 60 * 1000).invocations[0]?.possiblyOrphaned).toBeFalsy();
    expect(feed.snapshot(Date.now() + 16 * 60 * 1000).invocations[0]?.possiblyOrphaned).toBe(true);
  });
  it('快照副本语义不变：改副本的归属不影响内部记录', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '', attribution: { cycle: 'cycle-71' } });
    const copy = feed.snapshot();
    copy.invocations[0]!.cycle = 'cycle-999';
    expect(feed.snapshot().invocations[0]?.cycle).toBe('cycle-71');
  });
});

describe('registerInvocationRoute 归属透传（形状即响应形状）', () => {
  function capturedRes(): { res: unknown; out: { status: number | null; body: string | null } } {
    const out = { status: null as number | null, body: null as string | null };
    return { out, res: { writeHead: (s: number): void => { out.status = s; }, end: (b?: string): void => { out.body = b ?? null; } } };
  }
  function registerWith(feed: InvocationFeed | null): (req: unknown, res: unknown) => void {
    let handler: (req: unknown, res: unknown) => void = (): void => {};
    const ctx = { webServer: { register: (def: { handler: (req: unknown, res: unknown) => void }): (() => void) => { handler = def.handler; return (): void => {}; } } };
    const d = registerInvocationRoute(ctx, { send: (res, status, body) => { const r = res as { writeHead: (s: number) => void; end: (b?: string) => void }; r.writeHead(status); r.end(JSON.stringify(body)); }, feed });
    expect(d).toBeTypeOf('function');
    return handler;
  }

  it('路由响应**透传**归属字段（响应形状 = 快照形状，不补算不改写）', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}', attribution: { cycle: 'cycle-71', phase: 'build' } });
    const { res, out } = capturedRes();
    registerWith(feed)({ headers: { 'x-anic-workspace': '/some/other/ws' } }, res);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body ?? '{}') as { invocations: Array<Record<string, unknown>> };
    // 关键：即使请求头声明了别的工作区，响应里的归属仍是**事件发生时的坐标**
    // （归属由 feed 在事件到达时落盘，路由无工作区依赖、不做任何补算）。
    expect(body.invocations[0]?.cycle).toBe('cycle-71');
    expect(body.invocations[0]?.phase).toBe('build');
  });
  it('无归属的记录经路由后仍**无该键**（不是 null/空串占位）', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'c1', name: 'anic_status', arguments: '{}' });
    const { res, out } = capturedRes();
    registerWith(feed)({}, res);
    const rec = (JSON.parse(out.body ?? '{}') as { invocations: Array<Record<string, unknown>> }).invocations[0]!;
    expect('cycle' in rec).toBe(false);
    expect('phase' in rec).toBe(false);
  });
});

describe('向后兼容（旧记录无归属字段）', () => {
  it('整条记录 JSON 序列化只含既有键——消费方形状（可选字段）零破坏', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'old1', name: 'anic_evaluate', arguments: '{}', turn: 1, step: 2 });
    feed.recordResult('old1', { isError: false, resultPreview: 'ok' });
    const rec = feed.snapshot().invocations[0]!;
    const keys = Object.keys(JSON.parse(JSON.stringify(rec)) as Record<string, unknown>).sort();
    expect(keys).toEqual(['argumentsPreview', 'callId', 'durationMs', 'endedAt', 'name', 'resultPreview', 'startedAt', 'status', 'step', 'turn']);
    // 归属字段是**新增可选**：旧记录缺它仍序列化成功、仍是合法记录
    expect(JSON.parse(JSON.stringify(rec))).toMatchObject({ callId: 'old1', status: 'done' });
  });
  it('归属字段可选：新记录也能被「只认既有字段」的消费方安全消费（忽略未知字段）', () => {
    const feed = createInvocationFeed();
    feed.recordCall({ callId: 'new1', name: 'anic_status', arguments: '{}', attribution: { cycle: 'cycle-71', phase: 'build' } });
    const raw = JSON.parse(JSON.stringify(feed.snapshot())) as { invocations: Array<Record<string, unknown>> };
    // 模拟旧消费方：只读已知字段，不认识 cycle/phase
    const consumed = raw.invocations.map((r) => ({ callId: r.callId, status: r.status, resultPreview: r.resultPreview }));
    expect(consumed).toEqual([{ callId: 'new1', status: 'in-flight', resultPreview: undefined }]);
  });
});
