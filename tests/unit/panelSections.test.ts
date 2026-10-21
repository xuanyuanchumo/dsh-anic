/**
 * panelSections 分区订阅薄组件测试（cycle-42 Top2 / T-4204）。
 *
 * 命题：
 *   1. 各分区经 store 驱动渲染（renderToStaticMarkup 路径下 usePanelSlice
 *      走 getServerSnapshot——订阅接线的正确性可静态验证）；
 *   2. LedgerSection 的 hasMore 自算（entries.length < total → 显示更多按钮）；
 *   3. LiveInvocationsSection 的 deferred 陈旧指示标记（data-anic-live-deferred）
 *      —— static 渲染下 useDeferredValue 直通，恒为 fresh；标记存在性钉死
 *      （真机滞后路径由 Chrome DevTools 用户旅程覆盖）；
 *   4. 门控分区（enabled=false）渲染禁用形态（INV-30 关闭如实呈现契约）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createPanelStore } from '../../src/client/components/panelStore.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import { LiveInvocationsSection, LedgerSection, StepTraceSection } from '../../src/client/components/panelSections.ts';
import type { LedgerListJson, LedgerEntryJson } from '../../src/client/features/ledger/renderLedger.ts';
import type { InvocationsJson, InvocationJson } from '../../src/client/features/live/renderInvocations.ts';
import type { PanelDataStore } from '../../src/client/panelState.ts';

function entry(i: number): LedgerEntryJson {
  return { gate: `G${i % 4}`, gateName: '基线门', result: 'PASS', detail: 'ok', timestamp: `2026-10-21T00:00:${String(i).padStart(2, '0')}Z`, previousHash: null, hash: `h${i}` };
}

function inv(over: Partial<InvocationJson>): InvocationJson {
  return { callId: 'c1', name: 'anic_evaluate', argumentsPreview: '{}', startedAt: 1, status: 'done', ...over };
}

function snap(invocations: InvocationJson[]): InvocationsJson {
  return { invocations, total: invocations.length, generatedAt: '2026-10-21T00:00:00.000Z' };
}

describe('LiveInvocationsSection（store 订阅 + deferred 指示）', () => {
  it('null 数据：pending 形态（不伪造空态），deferred 标记恒 fresh（static 渲染直通）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement(LiveInvocationsSection, { store, autoRefreshOn: true }));
    expect(html).toContain('data-anic-live-deferred="fresh"');
    expect(html).toContain('data-anic-invocations-pending');
  });

  it('store 写入调用流数据后渲染三态卡片（订阅接线的数据面验证）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    store.setState({ invocations: snap([
      inv({ callId: 'a', status: 'done', durationMs: 1200 }),
      inv({ callId: 'b', status: 'in-flight', turn: 3, step: 7 }),
    ]) });
    const html = renderToStaticMarkup(createElement(LiveInvocationsSection, { store, autoRefreshOn: true }));
    expect(html).toContain('data-anic-invocation="a"');
    expect(html).toContain('data-anic-invocation-status="done"');
    expect(html).toContain('data-anic-invocation-status="in-flight"');
    expect(html).toContain('t3/s7');
  });

  it('pollError 写入后如实呈现（保留陈旧数据 + 错误行）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    store.setState({ invocations: snap([inv({ callId: 'a' })]), invocationsError: '路由不可用 (503)' });
    const html = renderToStaticMarkup(createElement(LiveInvocationsSection, { store, autoRefreshOn: false }));
    expect(html).toContain('data-anic-invocation="a"');
    expect(html).toContain('路由不可用 (503)');
  });
});

describe('LedgerSection（hasMore 自算 + 分页按钮）', () => {
  it('entries < total：渲染「显示更多」按钮（data-anic-ledger-more 契约标记）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const list: LedgerListJson = { total: 30, entries: Array.from({ length: 12 }, (_, i) => entry(i)) };
    store.setState({ ledgerList: list });
    const html = renderToStaticMarkup(createElement(LedgerSection, { store, onShowMore: () => {} }));
    expect(html).toContain('data-anic-ledger-more="true"');
    expect(html).toContain('data-anic-ledger-entry="PASS"');
  });

  it('entries === total：不渲染「显示更多」（分页尽头）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const list: LedgerListJson = { total: 5, entries: Array.from({ length: 5 }, (_, i) => entry(i)) };
    store.setState({ ledgerList: list });
    const html = renderToStaticMarkup(createElement(LedgerSection, { store, onShowMore: () => {} }));
    expect(html).not.toContain('data-anic-ledger-more');
  });
});

describe('StepTraceSection（门控形态）', () => {
  it('enabled=false：分区标题在、内容为禁用说明（INV-30 关闭如实呈现）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement(StepTraceSection, { store, enabled: false }));
    expect(html).toContain('data-anic-steptrace-disabled');
    expect(html).toContain('data-anic-fold="stepTrace"');
  });

  it('enabled=true 且 trace 为 null：分区壳 + 未加载降级文案', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement(StepTraceSection, { store, enabled: true }));
    expect(html).toContain('data-anic-steptrace-wrap');
    expect(html).toContain('未加载');
  });
});
