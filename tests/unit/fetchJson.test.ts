/**
 * fetchJson 数据面小工具直测（cycle-33 测试深挖第二轮）。
 *
 * fetchJsonGuarded 是 org/flows 分区的拉取原语：非 2xx / 网络失败 / 形状不符
 * 三路全部收敛到 null（不抛、不伪造）。isObjectLike/isFlowStatus 是守卫；
 * syncTelemetryCounts 是 J0「渲染=遥测」不变量的同步跳（cycle-10 实录）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJsonGuarded, isObjectLike, isFlowStatus, syncTelemetryCounts } from '../../src/client/features/live/fetchJson.ts';

function jsonResponse(json: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(json) } as unknown as Response;
}

describe('fetchJsonGuarded —— 三路收敛 null', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('成功：2xx + 形状合法 → 返回解析值', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ flows: [1] }))));
    const v = await fetchJsonGuarded('/anic/flows-status', isFlowStatus, {});
    expect(v).toEqual({ flows: [1] });
  });

  it('形状不符 → null（不抛不伪造）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ other: true }))));
    const v = await fetchJsonGuarded('/x', isFlowStatus, {});
    expect(v).toBe(null);
  });

  it('非 2xx → null（不做 json 解析）', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json } as unknown as Response)));
    expect(await fetchJsonGuarded('/x', isFlowStatus, {})).toBe(null);
    expect(json).not.toHaveBeenCalled();
  });

  it('网络失败（fetch reject）→ null', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('net'))));
    expect(await fetchJsonGuarded('/x', isFlowStatus, {})).toBe(null);
  });

  it('headers 原样透传给 fetch', async () => {
    const fn = vi.fn(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal('fetch', fn);
    await fetchJsonGuarded('/x', isObjectLike, { 'X-ANIC-Workspace': 'ws' });
    expect(fn.mock.calls[0]?.[1]).toEqual({ headers: { 'X-ANIC-Workspace': 'ws' } });
  });
});

describe('形状守卫', () => {
  it('isObjectLike：对象过（宽松守卫——数组也过，与旧直接 cast 语义一致）；null/原始值不过', () => {
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike({ a: 1 })).toBe(true);
    expect(isObjectLike([1])).toBe(true); // typeof [] === 'object'：宽松守卫的既定语义（doc 注记）
    expect(isObjectLike(null)).toBe(false);
    expect(isObjectLike(undefined)).toBe(false);
    expect(isObjectLike('s')).toBe(false);
    expect(isObjectLike(42)).toBe(false);
  });
  it('isFlowStatus：flows 数组是唯一硬契约', () => {
    expect(isFlowStatus({ flows: [] })).toBe(true);
    expect(isFlowStatus({ flows: [1, 2] })).toBe(true);
    expect(isFlowStatus({ flows: 'x' })).toBe(false);
    expect(isFlowStatus({})).toBe(false);
    expect(isFlowStatus(null)).toBe(false);
  });
});

describe('syncTelemetryCounts —— 渲染=遥测同步跳', () => {
  it('window.__ANIC_TAB_SPIKE__ 存在 → 计数更新为实际渲染面', () => {
    const spike = { nodes: 169, edges: 217 };
    (window as unknown as { __ANIC_TAB_SPIKE__?: { nodes: number; edges: number } }).__ANIC_TAB_SPIKE__ = spike;
    syncTelemetryCounts(175, 228);
    expect(spike).toEqual({ nodes: 175, edges: 228 });
    delete (window as unknown as { __ANIC_TAB_SPIKE__?: { nodes: number; edges: number } }).__ANIC_TAB_SPIKE__;
  });
  it('spike 未注册（宿主未注入）→ 静默无操作', () => {
    expect(() => syncTelemetryCounts(1, 2)).not.toThrow();
  });
});
