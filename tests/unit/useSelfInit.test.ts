/**
 * useSelfInit 自举按钮状态机直测（cycle-33 测试深挖第二轮）。
 *
 * 四态语义（P0-2：原 void fetch 零反馈改造）：
 *   idle → running → ok / failed
 * 特殊分支：409 + ANIC_ROUTE_SELF_INIT_ALREADY = 「已初始化」成功语义
 * （refuse-to-rerun 对按钮视角是目标已达成）；running 期间双击防抖。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSelfInit, type SelfInitState } from '../../src/client/features/selfinit/useSelfInit.ts';

function jsonResponse(json: unknown, status: number): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(json) } as unknown as Response;
}

/** 挂载消费组件，捕获最新 hook 输出（每次渲染刷新）。 */
async function mountProbe(): Promise<{ state: () => SelfInitState; unmount: () => void }> {
  let latest: SelfInitState | null = null;
  function Probe(): null {
    latest = useSelfInit();
    return null;
  }
  const host = document.createElement('div');
  const root: Root = createRoot(host);
  await act(async () => { root.render(createElement(Probe) as ReactElement); });
  return {
    state: () => latest as unknown as SelfInitState,
    unmount: () => { act(() => { root.unmount(); }); },
  };
}

describe('useSelfInit —— 四态反馈状态机', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('初始 idle，note 空', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const p = await mountProbe();
    expect(p.state().phase).toBe('idle');
    expect(p.state().note).toBe('');
    p.unmount();
  });

  it('200 成功 → ok + 成功文案（含状态码 detail）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}, 200))));
    const p = await mountProbe();
    await act(async () => { await p.state().onSelfInit(); });
    expect(p.state().phase).toBe('ok');
    expect(p.state().note).toContain('200');
    p.unmount();
  });

  it('409 + ANIC_ROUTE_SELF_INIT_ALREADY → ok 幂等语义（不是失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: { code: 'ANIC_ROUTE_SELF_INIT_ALREADY' } }, 409))));
    const p = await mountProbe();
    await act(async () => { await p.state().onSelfInit(); });
    expect(p.state().phase).toBe('ok');
    p.unmount();
  });

  it('409 + 其他错误码 → failed（HTTP 409 文案）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: { code: 'OTHER' } }, 409))));
    const p = await mountProbe();
    await act(async () => { await p.state().onSelfInit(); });
    expect(p.state().phase).toBe('failed');
    expect(p.state().note).toContain('409');
    p.unmount();
  });

  it('500 → failed + HTTP 500 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}, 500))));
    const p = await mountProbe();
    await act(async () => { await p.state().onSelfInit(); });
    expect(p.state().phase).toBe('failed');
    expect(p.state().note).toContain('500');
    p.unmount();
  });

  it('网络异常 → failed + 异常 message 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('conn refused'))));
    const p = await mountProbe();
    await act(async () => { await p.state().onSelfInit(); });
    expect(p.state().phase).toBe('failed');
    expect(p.state().note).toContain('conn refused');
    p.unmount();
  });

  it('running 期间重入被防抖（第二次调用直接返回）', async () => {
    let release: ((r: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const p = await mountProbe();
    let first: Promise<void> = Promise.resolve();
    await act(async () => { first = p.state().onSelfInit(); }); // 启动（act 退出时 running 态已渲染）
    expect(p.state().phase).toBe('running');
    const fetchCountBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => { await p.state().onSelfInit(); }); // running 中重入
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCountBefore);
    release?.(jsonResponse({}, 200));
    await act(async () => { await first; });
    expect(p.state().phase).toBe('ok');
    p.unmount();
  });
});
