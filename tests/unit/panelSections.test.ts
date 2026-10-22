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
import { LiveInvocationsSection, LedgerSection, StepTraceSection, ToolbarStatusLine, CyclesSection, DiagnosticsSection, OrgSection, SkillHealthSection, TechDebtSection, FlowsSection, HitlSection, BudgetSection } from '../../src/client/components/panelSections.ts';
import { renderFoldableSection } from '../../src/client/components/sectionShell.ts';
import { writeFoldPref } from '../../src/client/features/prefs/foldPrefs.ts';
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

describe('cycle-104 折叠默认策略（用户要求核心：默认只展开 live）', () => {
  /** 十个静态分区装配渲染（与 panelAssemblyContract 同款顺序）。 */
  function renderAllSections(): string {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    return renderToStaticMarkup(createElement('div', null,
      createElement(CyclesSection, { store }),
      createElement(StepTraceSection, { store, enabled: true }),
      createElement(DiagnosticsSection, { store, enabled: true }),
      createElement(OrgSection, { store }),
      createElement(SkillHealthSection, { store }),
      createElement(TechDebtSection, { store }),
      createElement(FlowsSection, { store, enabled: true }),
      createElement(LedgerSection, { store, onShowMore: () => {} }),
      createElement(HitlSection, { store, enabled: true }),
      createElement(BudgetSection, { store }),
    ));
  }

  it('只有 diagnostics 与 hitl 默认展开（兜底观测面），其余八区默认收纳', () => {
    const html = renderAllSections();
    const openIds = [...html.matchAll(/data-anic-fold="([^"]+)"[^>]*?data-anic-fold-state="open"/g)].map((m) => m[1]);
    expect(openIds.sort()).toEqual(['diagnostics', 'hitl']);
    // 反向：每个收纳分区都带 closed 标记（不是"标记缺失=恰好也是收纳"）
    const closed = [...html.matchAll(/data-anic-fold="([^"]+)"[^>]*?data-anic-fold-state="closed"/g)].map((m) => m[1]);
    expect(closed.sort()).toEqual(['budget', 'cycles', 'flows', 'ledger', 'org', 'skillHealth', 'stepTrace', 'techDebt']);
    // 非空下限：真的渲染了十个分区（否则上面两条是在比空数组）
    expect([...html.matchAll(/data-anic-fold="/g)].length).toBe(10);
  });

  it('live 分区默认展开形态不受本策略影响（它不是折叠壳分区，自带 turn 组 details）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement(LiveInvocationsSection, { store, autoRefreshOn: true }));
    expect(html).not.toContain('data-anic-fold=');
    expect(html).toContain('data-anic-invocations="section"');
  });

  it('用户折叠记忆覆盖默认：写入 diagnostics=false 后该区渲染 closed（受控 value 与记忆同步）', () => {
    // 直接驱动 sectionShell（分区组件是纯装配），断言记忆优先于 defaultOpen。
    writeFoldPref('diagnostics', false);
    try {
      const html = renderToStaticMarkup(renderFoldableSection({ id: 'diagnostics', title: 'T', children: null, defaultOpen: true }));
      expect(html).toContain('data-anic-fold-state="closed"');
      expect(html).not.toContain('open=""');
    } finally {
      writeFoldPref('diagnostics', true); // 还原：本次会话内 diagnostics 默认仍是展开
    }
  });
});

describe('ToolbarStatusLine（cycle-45 T-4502a：fetchLine 顶层切片直测——12 分区包装组件中曾无直测者）', () => {
  it('初始态渲染 `ANIC · 构建期快照` 来源行（fetchLine 订阅接线）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement(ToolbarStatusLine, { store }));
    expect(html).toContain('ANIC · ');
    expect(html).toContain('构建期快照');
    expect(html).toContain('role="status"');
  });

  it('fetchLine 写入后状态行跟进（aria-live polite 异步反馈可感知）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    store.setState({ fetchSource: 'live', fetchLine: '实时 2026-10-21T12:00:00.000Z · 188 节点 / 292 边' });
    const html = renderToStaticMarkup(createElement(ToolbarStatusLine, { store }));
    expect(html).toContain('实时 2026-10-21T12:00:00.000Z · 188 节点 / 292 边');
    expect(html).toContain('aria-live="polite"');
  });

  it('fetchSource 单独变化不牵动状态行内容（扁平化隔离语义——行只订 line）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const lineBefore = '实时 T1 · 10 节点 / 20 边';
    store.setState({ fetchSource: 'live', fetchLine: lineBefore });
    store.setState({ fetchSource: 'embedded' }); // 只动 source
    const html = renderToStaticMarkup(createElement(ToolbarStatusLine, { store }));
    expect(html).toContain(lineBefore); // 行内容不受 source 切片影响
  });
});

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
