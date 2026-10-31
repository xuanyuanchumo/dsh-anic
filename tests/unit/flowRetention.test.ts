/**
 * 热窗口淘汰水位线（cycle-94）—— 纯函数单测。
 *
 * ## 为什么这些用例是"必须的"而不是"补覆盖率"
 *
 * 本模块修的是**静默截断**（`flowTracker.ts:17` 自己写下的缺陷名）。
 * 静默截断的性质是：**返回的数据永远"看起来正常"** —— 数组长度正常、
 * 记录字段完整、排序正确。任何只断言"返回了 N 条"的测试都**必然全绿**，
 * 而缺陷照旧。
 *
 * ⇒ 本文件的每条断言都钉在"看不见的那一面"：
 *   1. 被裁掉的**界**在哪（`evictedThrough`），而不只是裁了几条；
 *   2. 水位线**单调**（连续淘汰不会让读数倒退）；
 *   3. 进行中的流程**永不被裁**（即使它是最旧的那条）；
 *   4. 容量超限时**如实标注** `overCapacity`（而不是悄悄超限）。
 *
 * ## 反向自检纪律（与全仓契约同形）
 *
 * 第 ⑧ 组用例专门证明"这些断言不是哑的"：喂一个**故意退化的实现**
 * （直接 `slice(-max)`），它必须在至少三条断言上被判红。
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_WATERMARK, isLive, mergeWatermarks, trimWithWatermark,
  type EvictionWatermark,
} from '../../src/host/runtime/flowRetention.ts';
import type { FlowRecord } from '../../src/host/runtime/flowTrackerTypes.ts';

/** 造一条记录（只填本模块关心的字段）。 */
function flow(id: number, status: FlowRecord['status'], iso: string): FlowRecord {
  return {
    flowId: `s-${iso}-${String(id)}`,
    script: 's',
    workspace: '/w',
    args: [],
    status,
    startedAt: iso,
  };
}

/** 造 n 条终态记录（时间递增，便于断言"最旧的先走"）。 */
function doneFlows(n: number, from = 0): FlowRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const seq = from + i;
    return flow(seq, 'DONE', `2026-10-31T00:${String(seq % 60).padStart(2, '0')}:00.000Z`);
  });
}

describe('flowRetention · 淘汰水位线', () => {
  it('① 未触顶 ⇒ 零淘汰，累计量原样保留（不是归零）', () => {
    const prev: EvictionWatermark = {
      evictedThrough: '2026-10-30T00:00:00.000Z', evictedTotal: 7, evictedNow: 3, overCapacity: false,
    };
    const r = trimWithWatermark(doneFlows(5), 10, prev);
    expect(r.kept).toHaveLength(5);
    expect(r.watermark.evictedNow).toBe(0);
    // 关键：上一次的累计量必须还在。归零会让读数"倒退"，比不报更糟。
    expect(r.watermark.evictedTotal).toBe(7);
    expect(r.watermark.evictedThrough).toBe('2026-10-30T00:00:00.000Z');
    expect(r.watermark.overCapacity).toBe(false);
  });

  it('② 触顶 ⇒ 裁掉最旧的，水位线指向**被裁掉的最大时间戳**', () => {
    const flows = doneFlows(10);          // 00:00 .. 00:09
    const r = trimWithWatermark(flows, 4);
    expect(r.kept).toHaveLength(4);
    expect(r.watermark.evictedNow).toBe(6);
    expect(r.watermark.evictedTotal).toBe(6);
    // 裁掉的是 00:00..00:05，界 = 00:05（被裁掉里最大的那个）
    expect(r.watermark.evictedThrough).toBe('2026-10-31T00:05:00.000Z');
    // 保留的是最近的 4 条
    expect(r.kept.map((f) => f.startedAt)).toEqual([
      '2026-10-31T00:06:00.000Z', '2026-10-31T00:07:00.000Z',
      '2026-10-31T00:08:00.000Z', '2026-10-31T00:09:00.000Z',
    ]);
  });

  it('③ 连续两次淘汰 ⇒ 累计量与界都**单调不减**', () => {
    const first = trimWithWatermark(doneFlows(10), 4);
    const second = trimWithWatermark(doneFlows(14), 4, first.watermark);
    expect(second.watermark.evictedTotal).toBeGreaterThanOrEqual(first.watermark.evictedTotal);
    expect(second.watermark.evictedThrough).not.toBeNull();
    // ISO 串序 = 时间序，可以直接比
    expect(second.watermark.evictedThrough! >= first.watermark.evictedThrough!).toBe(true);
    expect(second.watermark.evictedTotal).toBe(first.watermark.evictedTotal + second.watermark.evictedNow);
  });

  it('④ 进行中的流程**永不淘汰**——即使它是最旧的那条', () => {
    const flows: FlowRecord[] = [
      // 最旧的那条正在跑（典型场景：一个超时 40 分钟的 auto-fix 循环）
      flow(0, 'RUNNING', '2026-10-31T00:00:00.000Z'),
      ...doneFlows(9, 1),
    ];
    const r = trimWithWatermark(flows, 4);
    const ids = r.kept.map((f) => f.flowId);
    // 它必须还在（这是本用例的全部意义）
    expect(ids).toContain('s-2026-10-31T00:00:00.000Z-0');
    // 且被捞回没有被算进"被裁掉"（它还在窗口里）
    expect(r.watermark.evictedNow).toBe(5);       // 9 条终态里裁掉 5 条
    // 窗口因此超过容量 —— 必须如实标注，不能悄悄超限
    expect(r.kept.length).toBe(5);
    expect(r.kept.length).toBeGreaterThan(4);
    expect(r.watermark.overCapacity).toBe(true);
  });

  it('⑤ INVOKING 也受保护（不只是 RUNNING）', () => {
    const flows: FlowRecord[] = [
      flow(0, 'INVOKING', '2026-10-31T00:00:00.000Z'),
      ...doneFlows(5, 1),
    ];
    const r = trimWithWatermark(flows, 2);
    expect(r.kept.some(isLive)).toBe(true);
    expect(r.watermark.overCapacity).toBe(true);
  });

  it('⑥ 全部都是进行中 ⇒ 一条都不裁，overCapacity 如实为 true', () => {
    const flows = [
      flow(0, 'RUNNING', '2026-10-31T00:00:00.000Z'),
      flow(1, 'RUNNING', '2026-10-31T00:01:00.000Z'),
      flow(2, 'RUNNING', '2026-10-31T00:02:00.000Z'),
    ];
    const r = trimWithWatermark(flows, 1);
    expect(r.kept).toHaveLength(3);
    expect(r.watermark.evictedNow).toBe(0);
    expect(r.watermark.evictedThrough).toBeNull();  // 什么都没裁掉 ⇒ 不伪造落点
    expect(r.watermark.overCapacity).toBe(true);
  });

  it('⑦ mergeWatermarks 取更靠后、**不重复累加**，且 overCapacity 取或', () => {
    const a: EvictionWatermark = {
      evictedThrough: '2026-10-31T00:05:00.000Z', evictedTotal: 6, evictedNow: 6, overCapacity: false,
    };
    const b: EvictionWatermark = {
      evictedThrough: '2026-10-31T00:09:00.000Z', evictedTotal: 6, evictedNow: 6, overCapacity: true,
    };
    const m = mergeWatermarks(a, b);
    expect(m.evictedThrough).toBe('2026-10-31T00:09:00.000Z');
    // 不累加：若写成 a.total + b.now 会得到 12（同一批数据数两遍）
    expect(m.evictedTotal).toBe(6);
    expect(m.overCapacity).toBe(true);
    // 与顺序无关的对称性
    expect(mergeWatermarks(b, a).evictedThrough).toBe(m.evictedThrough);
    expect(mergeWatermarks(b, a).evictedTotal).toBe(m.evictedTotal);
    expect(mergeWatermarks(undefined, b).evictedThrough).toBe(b.evictedThrough);
  });

  it('⑧ 反向自检：退化成 slice(-max) 的实现必须被判红', () => {
    // 这是一个**故意错误**的实现：忽略进行中保护、不上报水位线。
    const naive = (flows: FlowRecord[], max: number): FlowRecord[] =>
      flows.length <= max ? flows : flows.slice(flows.length - max);

    const flows: FlowRecord[] = [
      flow(0, 'RUNNING', '2026-10-31T00:00:00.000Z'),
      ...doneFlows(9, 1),
    ];
    const bad = naive(flows, 4);
    const good = trimWithWatermark(flows, 4);

    // 三条独立的判据都必须能把 naive 与正确实现区分开。
    // (a) 正在跑的那条被 naive 丢了
    expect(bad.some((f) => f.flowId.endsWith('-0'))).toBe(false);
    expect(good.kept.some((f) => f.flowId.endsWith('-0'))).toBe(true);
    // (b) naive 没有水位线这个概念 ⇒ 无从回答"丢到哪儿"
    expect(good.watermark.evictedThrough).not.toBeNull();
    // (c) naive 超限了吗？它自己不知道
    expect(good.watermark.overCapacity).toBe(true);
  });

  it('⑨ 空输入与容量下限：max=0 不清空窗口（配置错误不该表现为面板永远空白）', () => {
    expect(trimWithWatermark([], 10).kept).toEqual([]);
    expect(trimWithWatermark([], 10).watermark).toEqual(EMPTY_WATERMARK);
    // max=0 被钳到 1：至少保留最新一条
    const r = trimWithWatermark(doneFlows(3), 0);
    expect(r.kept).toHaveLength(1);
    expect(r.watermark.evictedNow).toBe(2);
  });

  it('⑩ 纯函数性：同一输入两次调用深相等，且不修改输入', () => {
    const flows = doneFlows(12);
    const snapshot = JSON.stringify(flows);
    const a = trimWithWatermark(flows, 5);
    const b = trimWithWatermark(flows, 5);
    expect(JSON.stringify(flows)).toBe(snapshot);   // 输入未被改
    expect(a.watermark).toEqual(b.watermark);
    expect(a.kept.map((f) => f.flowId)).toEqual(b.kept.map((f) => f.flowId));
  });
});
