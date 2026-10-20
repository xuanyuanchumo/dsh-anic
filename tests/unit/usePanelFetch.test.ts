/**
 * usePanelFetch 钩子生命周期测试（cycle-33 测试深挖第二轮）。
 *
 * 覆盖面板数据拉取统一钩子的核心契约：防抖（inFlight 不重入）、
 * 三分类降级（http/malformed/network → onFail）、成功恢复（onRecover）、
 * 暂停语义（pollMs<=0 只首拍）、manualKey 重拍、取消清理（unmount 后不 apply）、
 * 无 fetch 环境（smoke 沙盒形态）一次都不拉、getHeaders 引用安全。
 *
 * 环境注记：vitest 默认 node 环境无 DOM——本文件声明 jsdom（本地依赖已有
 * jsdom 30.1.2），用 react-dom/client createRoot 挂最小宿主组件跑钩子，
 * fetch 用全局 stub。React 19 的 act 从 'react' 直接导出。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { usePanelFetch, type PanelFetchTarget } from '../../src/client/components/usePanelFetch.ts';

/** act 里渲染一个消费钩子的组件；返回控制句柄（bumpKey 重拍 manualKey）。（模块级：两个 describe 共用） */
async function mount(
  makeTargets: () => PanelFetchTarget[],
  pollMs: number,
  manualKey: number,
): Promise<{ unmount: () => void; bumpKey: () => Promise<void> }> {
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  const root = createRoot(host);
  let key = manualKey;
  let targets = makeTargets;
  let ms = pollMs;
  const probe = (): ReactElement => createElement(Probe, { makeTargets: targets, pollMs: ms, manualKey: key });
  function Probe(): null {
    usePanelFetch(targets(), ms, key, () => ({ 'X-Test': '1' }));
    return null;
  }
  await act(async () => { root.render(probe()); });
  return {
    unmount: () => { act(() => { root.unmount(); }); },
    bumpKey: async () => {
      key += 1;
      await act(async () => { root.render(probe()); });
    },
  };
}

describe('usePanelFetch —— 生命周期契约（React act 驱动）', () => {
  type FetchCall = { url: string; headers: Record<string, string> };
  let calls: FetchCall[];
  let responders: Array<(url: string) => { ok: boolean; status: number; json: unknown } | Promise<Response>>;
  let timers: Array<() => void>;

  function fakeFetch(url: string, init: { headers: Record<string, string> }): Promise<Response> {
    calls.push({ url, headers: init.headers });
    const respond = responders[Math.min(calls.length - 1, responders.length - 1)]!;
    const r = respond(url);
    if (r instanceof Promise) return r;
    return Promise.resolve({
      ok: r.ok, status: r.status,
      json: () => Promise.resolve(r.json),
      headers: { get: () => null },
    } as unknown as Response);
  }

  beforeEach(() => {
    calls = [];
    responders = [];
    timers = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(fakeFetch);
  });
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('成功路径：guard 过 → apply + onRecover；headers 经 getHeaders() 取', async () => {
    const applied: unknown[] = [];
    const recovered: number[] = [];
    responders = [() => ({ ok: true, status: 200, json: { v: 1 } })];
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: (v) => (v as { v?: number }).v === 1,
      apply: (v) => { applied.push(v); },
      onRecover: () => { recovered.push(1); },
    }];
    const h = await mount(targets, 0, 0);
    expect(applied).toHaveLength(1);
    expect(recovered).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ 'X-Test': '1' });
    h.unmount();
  });

  it('畸形降级：guard 不过 → onFail(malformed)，不 apply', async () => {
    const failures: string[] = [];
    const applied: unknown[] = [];
    responders = [() => ({ ok: true, status: 200, json: { wrong: true } })];
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: () => false,
      apply: (v) => { applied.push(v); },
      onFail: (f) => { failures.push(f.kind); },
    }];
    const h = await mount(targets, 0, 0);
    expect(failures).toEqual(['malformed']);
    expect(applied).toHaveLength(0);
    h.unmount();
  });

  it('HTTP 降级：非 2xx → onFail(http, status)；静默形态（无 onFail）不炸', async () => {
    const failures: Array<{ kind: string; status?: number }> = [];
    responders = [() => ({ ok: false, status: 503, json: {} })];
    const targets = (): PanelFetchTarget[] => [
      { url: '/anic/a', guard: () => true, apply: () => {}, onFail: (f) => { failures.push({ kind: f.kind, status: f.kind === 'http' ? f.status : undefined }); } },
      { url: '/anic/b', guard: () => true, apply: () => {} }, // 静默形态
    ];
    const h = await mount(targets, 0, 0);
    expect(failures).toEqual([{ kind: 'http', status: 503 }]);
    h.unmount();
  });

  it('网络降级：fetch 抛错 → onFail(network, message)', async () => {
    const failures: Array<{ kind: string; message?: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(() => Promise.reject(new Error('boom-net')));
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: () => true, apply: () => {},
      onFail: (f) => { failures.push({ kind: f.kind, message: f.kind === 'network' ? f.message : undefined }); },
    }];
    const h = await mount(targets, 0, 0);
    expect(failures).toEqual([{ kind: 'network', message: 'boom-net' }]);
    h.unmount();
  });

  it('json() 抛错也走 network 分类（解析失败的网络面语义）', async () => {
    const failures: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.reject(new Error('bad json')),
    } as unknown as Response));
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: () => true, apply: () => {},
      onFail: (f) => { failures.push(f.kind); },
    }];
    const h = await mount(targets, 0, 0);
    expect(failures).toEqual(['network']);
    h.unmount();
  });

  it('暂停语义：pollMs<=0 只首拍（不再排 setTimeout 轮询）', async () => {
    responders = [() => ({ ok: true, status: 200, json: { v: 1 } })];
    const applied: unknown[] = [];
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    expect(calls).toHaveLength(1);
    h.unmount();
  });

  it('取消语义：unmount 后迟到响应不 apply', async () => {
    let releaseJson: ((v: unknown) => void) | null = null;
    const applied: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(() => new Promise<Response>((resolve) => {
      releaseJson = (v: unknown) => { resolve(v as Response); };
    }));
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    expect(applied).toHaveLength(0);
    h.unmount();
    releaseJson?.({ ok: true, status: 200, json: () => Promise.resolve({ v: 9 }) } as unknown as Response);
    await act(async () => { await Promise.resolve(); });
    expect(applied).toHaveLength(0); // unmount 后 cancelled → 不 apply
  });

  it('无 fetch 环境（smoke 沙盒形态）：一次都不拉、不炸', async () => {
    delete (globalThis as { fetch?: unknown }).fetch;
    const applied: unknown[] = [];
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    expect(applied).toHaveLength(0);
    expect(calls).toHaveLength(0);
    h.unmount();
  });

  it('onResponse 暴露原始响应（学头等副作用通道）', async () => {
    const seen: unknown[] = [];
    responders = [() => ({ ok: true, status: 200, json: { v: 1 } })];
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: () => true, apply: () => {},
      onResponse: (res) => { seen.push(res); },
    }];
    const h = await mount(targets, 0, 0);
    expect(seen).toHaveLength(1);
    h.unmount();
  });
});

describe('usePanelFetch —— cycle-38 V-1 ETag 条件请求 + 隐藏暂停（TanStack Query 轮询纪律吸收）', () => {
  /** 带可编程 ETag 的响应工厂（headers.get 支持任意名字）。 */
  function res200(json: unknown, etag: string | null): Response {
    return {
      ok: true, status: 200,
      json: () => Promise.resolve(json),
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
    } as unknown as Response;
  }

  it('V-1 学习与回带：首轮 200 带 ETag → 次轮请求带 If-None-Match（manualKey 重拍触发）', async () => {
    const seq: Array<Record<string, string>> = [];
    let call = 0;
    (globalThis as { fetch?: unknown }).fetch = vi.fn((_url: string, init: { headers: Record<string, string> }): Promise<Response> => {
      call += 1;
      seq.push(init.headers);
      // 首轮给 ETag；次轮（带 If-None-Match 且值匹配）回 304。
      const inm = init.headers['If-None-Match'] ?? init.headers['if-none-match'];
      if (call === 1) return Promise.resolve(res200({ v: 1 }, '"abc123"'));
      if (inm === '"abc123"') {
        return Promise.resolve({ ok: false, status: 304, headers: { get: () => '"abc123"' } } as unknown as Response);
      }
      return Promise.resolve(res200({ v: 2 }, '"abc123"'));
    });
    const applied: unknown[] = [];
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/snap', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    expect(applied).toEqual([{ v: 1 }]);
    expect(seq[0]?.['If-None-Match']).toBeUndefined();
    // 手动重拍（manualKey bump）→ 第二轮带条件头
    await h.bumpKey();
    expect(applied).toEqual([{ v: 1 }]); // 304 → 不重放 apply（结构共享语义）
    expect(seq[1]?.['If-None-Match']).toBe('"abc123"');
    h.unmount();
  });

  it('304 不计失败、触发 onRecover（数据未变是健康形态）', async () => {
    let call = 0;
    const failures: string[] = [];
    const recovered: number[] = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn((_url: string, init: { headers: Record<string, string> }): Promise<Response> => {
      call += 1;
      const inm = init.headers['If-None-Match'];
      if (call === 1) return Promise.resolve(res200({ v: 1 }, '"e1"'));
      return Promise.resolve({ ok: false, status: 304, headers: { get: () => (inm ? inm : null) } } as unknown as Response);
    });
    const applied: unknown[] = [];
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/snap', guard: () => true, apply: (v) => { applied.push(v); },
      onFail: (f) => { failures.push(f.kind); },
      onRecover: () => { recovered.push(1); },
    }];
    const h = await mount(targets, 0, 0);
    await h.bumpKey();
    expect(failures).toEqual([]);
    expect(applied).toEqual([{ v: 1 }]); // 只有首轮 200 落过数据
    expect(recovered.length).toBeGreaterThanOrEqual(2); // 200 与 304 都算成功恢复
    h.unmount();
  });

  it('ETag 变化（服务端数据更新）→ 200 全量重放 apply（正常数据流不因缓存丢失）', async () => {
    let call = 0;
    (globalThis as { fetch?: unknown }).fetch = vi.fn((_url: string, _init: { headers: Record<string, string> }): Promise<Response> => {
      call += 1;
      return Promise.resolve(call === 1 ? res200({ v: 1 }, '"old"') : res200({ v: 2 }, '"new"'));
    });
    const applied: unknown[] = [];
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/snap', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    await h.bumpKey();
    expect(applied).toEqual([{ v: 1 }, { v: 2 }]);
    h.unmount();
  });

  it('无 ETag 响应 → 不带条件头（老宿主/无 ETag 端点零行为变化）', async () => {
    const seq: Array<Record<string, string>> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn((_url: string, init: { headers: Record<string, string> }): Promise<Response> => {
      seq.push(init.headers);
      return Promise.resolve(res200({ v: 1 }, null));
    });
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: () => {} }];
    const h = await mount(targets, 0, 0);
    await h.bumpKey();
    expect(seq[0]?.['If-None-Match']).toBeUndefined();
    expect(seq[1]?.['If-None-Match']).toBeUndefined();
    h.unmount();
  });

  it('隐藏暂停：document.hidden → 跳过拉取且不发 fetch；恢复可见 → 正常补拍', async () => {
    let n = 0;
    (globalThis as { fetch?: unknown }).fetch = vi.fn((): Promise<Response> => {
      n += 1;
      return Promise.resolve(res200({ v: n }, null));
    });
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: () => {} }];
    // 首拍发生在可见态（jsdom 默认 visible）
    const h = await mount(targets, 0, 0);
    expect(n).toBe(1);
    // 切隐藏 → manualKey 重拍不产生 fetch
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await h.bumpKey();
      expect(n).toBe(1); // 隐藏：跳过本轮
      // 恢复可见 → 再 bump 即补拍
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      await h.bumpKey();
      expect(n).toBe(2); // 可见：正常拉取
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
    h.unmount();
  });
});

describe('usePanelFetch —— cycle-40：AbortController + inFlight 复位 + 失败指数退避', () => {
  function res200(json: unknown): Response {
    return {
      ok: true, status: 200,
      json: () => Promise.resolve(json),
      headers: { get: () => null },
    } as unknown as Response;
  }

  it('刷新不被吞：手动刷新撞上 in-flight 拍 → 新 effect 立即首拍（旧实现的真时序 bug）', async () => {
    let call = 0;
    const applied: unknown[] = [];
    // 悬挂的 fetch：永不 resolve——模拟慢响应撞上手动刷新
    (globalThis as { fetch?: unknown }).fetch = vi.fn((): Promise<Response> => {
      call += 1;
      return call === 1 ? new Promise<Response>(() => {}) : Promise.resolve(res200({ v: 99 }));
    });
    const targets = (): PanelFetchTarget[] => [{ url: '/anic/x', guard: () => true, apply: (v) => { applied.push(v); } }];
    const h = await mount(targets, 0, 0);
    expect(applied).toHaveLength(0); // 首拍悬挂中
    await h.bumpKey(); // 手动刷新：旧 effect abort（悬挂请求作废），新 effect 立即首拍
    expect(applied).toEqual([{ v: 99 }]); // 修复前：新 tick 被 inFlightRef 拦截 → 刷新被吞
    h.unmount();
  });

  it('abort 不计失败：手动刷新触发的取消不进 onFail 网络通道', async () => {
    const failures: string[] = [];
    // call 1：真实尊重 signal 的 fetch——abort 事件触发 AbortError reject；
    // 刷新后的新拍（call 2+）永不 settle（不产生任何失败信号）。
    (globalThis as { fetch?: unknown }).fetch = vi.fn(
      (_url: string, init: { signal?: AbortSignal }): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init.signal;
          if (sig) {
            if (sig.aborted) reject(new Error('already aborted'));
            else sig.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            }, { once: true });
          }
          // 无 abort 则悬挂（模拟慢响应）
        }),
    );
    const targets = (): PanelFetchTarget[] => [{
      url: '/anic/x', guard: () => true, apply: () => {},
      onFail: (f) => { failures.push(f.kind); },
    }];
    const h = await mount(targets, 0, 0);
    await h.bumpKey(); // 触发旧 effect abort → call 1 以 AbortError reject
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(failures).toEqual([]); // abort 不是失败（旧实现会把 AbortError 计入 network 失败）
    h.unmount();
  });

  it('失败指数退避：连续网络失败 ×2（封顶 8×），成功复位（pollMs>0 轮询路径）', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const failures: string[] = [];
      (globalThis as { fetch?: unknown }).fetch = vi.fn((): Promise<Response> => {
        call += 1;
        return Promise.reject(new Error(`net-down-${call}`));
      });
      const targets = (): PanelFetchTarget[] => [{
        url: '/anic/x', guard: () => true, apply: () => {},
        onFail: (f) => { failures.push(f.kind); },
      }];
      const h = await mount(targets, 4000, 0);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(call).toBe(1); // 首拍立即失败（streak=1 → backoff 2× → 下拍 t=8000）
      // 退避 2×：t=8000 才第二拍（原 4s 节奏被 ×2）
      await act(async () => { await vi.advanceTimersByTimeAsync(7999); });
      expect(call).toBe(1); // t=7999：仍在 8s 退避窗口
      await act(async () => { await vi.advanceTimersByTimeAsync(2); });
      expect(call).toBe(2); // t=8001：第二拍（streak=2 → backoff 4× → 下拍 t=24000）
      // 退避 4×：t=24000 第三拍
      await act(async () => { await vi.advanceTimersByTimeAsync(15998); });
      expect(call).toBe(2); // t=23999：仍在 16s 退避窗口
      await act(async () => { await vi.advanceTimersByTimeAsync(2); });
      expect(call).toBe(3); // t=24001：第三拍（streak=3 → backoff 8× 封顶）
      expect(failures.every((k) => k === 'network')).toBe(true);
      h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
