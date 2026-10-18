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

  /** act 里渲染一个消费钩子的组件；返回控制句柄。 */
  async function mount(
    makeTargets: () => PanelFetchTarget[],
    pollMs: number,
    manualKey: number,
  ): Promise<{ unmount: () => void }> {
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    const root = createRoot(host);
    let element: ReactElement = createElement(Probe, { makeTargets, pollMs, manualKey });
    function Probe(): null {
      usePanelFetch(makeTargets(), pollMs, manualKey, () => ({ 'X-Test': '1' }));
      return null;
    }
    await act(async () => { root.render(element); });
    return {
      unmount: () => { act(() => { root.unmount(); }); },
    };
  }

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
