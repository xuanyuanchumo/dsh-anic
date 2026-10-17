/**
 * P0-BODY 回归守卫 —— 真实宿主 POST 请求体是 Node 流，不是 req.body 对象。
 *
 * 缺陷史（cycle-6 发现）：dsh-host-webserver 的 handler 收到原始 IncomingMessage，
 * 没有任何 body 解析层（lib 源码逐字验证零命中）。旧 parseBody 只读 req.body，
 * 导致 11 个 POST 路由的体参数在真实宿主全部静默丢弃（mode/script/maxRounds/
 * gate/result…），而桩宿主测试直接挂 body 对象故全绿。本套件用流式形状的假 req
 * （on('data')/on('end')）钉死双形态兼容。
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readBody, parseBody, BODY_LIMIT_BYTES, type RouteReq } from '../../src/host/routes/routeContext.ts';
import { registerEvolutionRoute } from '../../src/host/routes/evolutionRoute.ts';

/** 流式假请求：真实宿主 IncomingMessage 的最小表面（无 body 字段，只有 on）。 */
function streamReq(chunks: string[], opts: { errorAfter?: boolean } = {}): RouteReq {
  const ee = new EventEmitter();
  const req = ee as unknown as RouteReq;
  // 注册下一拍投递（模拟网络分块到达）
  queueMicrotask(() => {
    for (const c of chunks) ee.emit('data', Buffer.from(c, 'utf-8'));
    if (opts.errorAfter) {
      ee.emit('error', new Error('socket reset'));
    } else {
      ee.emit('end');
    }
  });
  return req;
}

describe('readBody（真实宿主流式 / 桩宿主对象双形态）', () => {
  it('桩宿主：body 对象直接同步解析', async () => {
    const body = await readBody({ body: { mode: 'native' } });
    expect(body).toEqual({ mode: 'native' });
  });

  it('桩宿主：body 字符串 JSON.parse', async () => {
    const body = await readBody({ body: '{"gate":"G0","result":"PASS"}' });
    expect(body).toEqual({ gate: 'G0', result: 'PASS' });
  });

  it('真实宿主：跨多个 data 块分片到达的 JSON 完整重组', async () => {
    const body = await readBody(streamReq(['{"mo', 'de":"diff",', '"gate":"G2"}']));
    expect(body).toEqual({ mode: 'diff', gate: 'G2' });
  });

  it('真实宿主：error 事件后以已收块 settle（不悬挂）', async () => {
    const body = await readBody(streamReq(['{"a":1}'], { errorAfter: true }));
    expect(body).toEqual({ a: 1 });
  });

  it('真实宿主：无 on 无 body（防御形态）→ {}', async () => {
    expect(await readBody({})).toEqual({});
  });

  it('上限截断：超限后不等 end 立即 settle（不悬挂）', async () => {
    // 不发 end 事件的流 —— 只有上限能触发 settle；若实现只等 end 会永远悬挂（测试超时）
    const ee = new EventEmitter();
    const req = ee as unknown as RouteReq;
    queueMicrotask(() => {
      ee.emit('data', Buffer.from('{"a":1,"b":2}', 'utf-8')); // 12 字节 > limit 8
    });
    const body = await readBody(req, 8);
    expect(body).toEqual({ a: 1, b: 2 });
  });

  it('BODY_LIMIT_BYTES 默认 1MB', () => {
    expect(BODY_LIMIT_BYTES).toBe(1_000_000);
  });

  it('parseBody：损坏 JSON → {}（fail-safe）', () => {
    expect(parseBody({ body: '{broken' })).toEqual({});
  });
});

describe('路由级端到端：POST /anic/api/breakers 收到流式体', () => {
  it('流式体的 BreakerInput 字段真实进入熔断计算（修复前恒全零）', async () => {
    const registered: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const fakeCtx = {
      webServer: {
        register: (r: { path: string; handler: (req: unknown, res: unknown) => void }) => {
          registered.push(r);
          return () => { registered.pop(); };
        },
      },
    };
    let captured: { status: number; body: Record<string, unknown> } | null = null;
    const send = (_res: unknown, status: number, body: Record<string, unknown>): void => {
      captured = { status, body };
    };
    registerEvolutionRoute(fakeCtx as never, send);

    const h = registered.find((r) => r.path === '/anic/api/breakers');
    expect(h).toBeDefined();

    // 修复前：req.body undefined → 全字段静默退 0 → 永不熔断
    h!.handler(streamReq(['{"consecutiveFixFails":5,"hasDoubt":true}']), {});
    await new Promise((r) => setTimeout(r, 20));

    expect(captured).not.toBeNull();
    const breakers = (captured!.body.breakers as Array<{ id: string; tripped: boolean }>);
    expect(breakers.find((b) => b.id === 'consecutive_fix_fail')?.tripped).toBe(true);
    expect(breakers.find((b) => b.id === 'gate_doubt')?.tripped).toBe(true);
    expect(captured!.body.action).toBe('pause'); // 有熔断 → 至少 pause（governor 语义）
  });

  it('流式体分片到达不丢字段（gate 字段跨块）', async () => {
    const registered: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const fakeCtx = {
      webServer: {
        register: (r: { path: string; handler: (req: unknown, res: unknown) => void }) => {
          registered.push(r);
          return () => { registered.pop(); };
        },
      },
    };
    let captured: { status: number; body: Record<string, unknown> } | null = null;
    const send = (_res: unknown, status: number, body: Record<string, unknown>): void => {
      captured = { status, body };
    };
    registerEvolutionRoute(fakeCtx as never, send);

    const h = registered.find((r) => r.path === '/anic/api/tech-debt');
    expect(h).toBeDefined();

    // results 数组跨 4 块分片；E1 通过不产债务，E2 失败产 1 条（generateTechDebt 只对失败维度提案）
    h!.handler(
      streamReq(['{"results":[{"dimension":"E1","passed":t', 'rue,"score":0.5},{"dimension":"E2","passed"', ':false,"score":0.1}]}']),
      {},
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(captured).not.toBeNull();
    expect(captured!.body.count).toBe(1);
    const debts = captured!.body.techDebt as Array<{ dimension: string }>;
    expect(debts.map((d) => d.dimension)).toEqual(['E2']);
  });
});
