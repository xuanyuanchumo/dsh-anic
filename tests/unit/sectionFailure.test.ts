/**
 * 分区失败行契约（cycle-71 T-7117：消除「4s 档分区静默空体」）。
 *
 * ## 命题（用户可感知的最大剩余缺口）
 *
 * 4s 档 10 端点此前**全部无 `onFail`** + 各 render 对 `null` 返回 `null`
 * → 端点挂掉时**分区只剩标题、正文静默空掉**：用户分不清「路由挂了」与
 * 「这个工作区确实没有数据」。本套件钉死修复后的四态语义。
 *
 * ## 四态（数据优先，失败必说）
 *
 *   | 数据 | 失败 | 渲染 |
 *   |---|---|---|
 *   | 无 | 无 | null（交上层未加载降级——**既有行为零回归**） |
 *   | 无 | 有 | 失败行（含分类原因，替代静默空体） |
 *   | 有 | 无 | 数据本身（零额外节点） |
 *   | 有 | 有 | 数据 + 陈旧失败行（不把旧数据伪装新鲜） |
 *
 * ## 三条守卫纪律
 *
 *   ① 反向自检：先证明「失败行**确实缺席**」的负例（null 数据 + 无失败记录）
 *      不会被误判为有失败——否则本套件会在实现恒真时假绿；
 *   ② 零通知不变式：同内容重复 mark 不产生新对象（否则每 4s tick 都通知全场）；
 *   ③ 渲染隔离：某 key 的失败不牵动**其它**分区（单切片按 id 取值的核心收益）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createPanelStore } from '../../src/client/components/panelStore.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import { bindPanelActions } from '../../src/client/components/panelActions.ts';
import { bodyOrFailure, renderSectionFailure } from '../../src/client/components/sectionFailure.ts';
import { BudgetSection, CyclesSection, FlowsSection, HitlSection, LedgerSection, OrgSection, SkillHealthSection, TechDebtSection } from '../../src/client/components/panelSections.ts';
import type { PanelDataStore } from '../../src/client/panelState.ts';

function freshStore(): PanelDataStore {
  return createPanelStore(createInitialPanelState());
}

/** 单分区静态渲染（store 驱动）。 */
function renderSection(store: PanelDataStore, node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe('失败行渲染（renderSectionFailure 四态）', () => {
  it('无失败记录 → null（不渲染任何节点——「取不到」与「没失败」可辨）', () => {
    expect(renderSectionFailure('x', null, false)).toBeNull();
    expect(renderSectionFailure('x', null, true)).toBeNull();
  });

  it('有失败 + 无数据 → 渲染失败行且锚点带分区 id（红字警告色）', () => {
    const el = renderSectionFailure('budget', '路由不可用 (500)', false);
    expect(el).not.toBeNull();
    const html = renderToStaticMarkup(el!);
    expect(html).toContain('data-anic-failed-budget="true"');
    // 文案含分类后的原因（用户据此区分「服务端说没有」与「问不到服务端」）
    expect(html).toContain('路由不可用 (500)');
  });

  it('有失败 + 有数据 → 用**陈旧**文案（不把旧数据伪装成新鲜）', () => {
    const html = renderToStaticMarkup(renderSectionFailure('budget', '网络异常', true)!);
    // 两句文案不同：stale 版明说「以下为上次成功的数据」
    expect(html).toContain('上次成功');
    expect(html).not.toContain('本节数据取不到');
  });

  it('守卫纪律①反向自检：无失败时两种 hasData 都为 null（防「永远渲染失败行」的假绿）', () => {
    // 若实现把 null 失败也渲染出来，上面第一条断言会红；这里再显式证一次
    // 「null 失败」与「非空失败」是可区分的两个分支。
    expect(renderSectionFailure('a', null, false)).toBeNull();
    expect(renderSectionFailure('a', 'E', false)).not.toBeNull();
  });
});

describe('bodyOrFailure 四态组装（数据优先，失败必说）', () => {
  const body = createElement('div', { 'data-test-body': 'true' }, '数据');
  const bodyHtml = renderToStaticMarkup(body);

  it('无数据 + 无失败 → null（交上层未加载降级，既有行为零回归）', () => {
    expect(bodyOrFailure(null, 's', null)).toBeNull();
  });

  it('无数据 + 有失败 → 只渲染失败行（替代静默空体）', () => {
    const html = renderToStaticMarkup(createElement('div', null, bodyOrFailure(null, 's', '拉取失败 (x)') as never));
    expect(html).toContain('data-anic-failed-s="true"');
    expect(html).not.toContain('data-test-body');
  });

  it('有数据 + 无失败 → 数据本身（零额外包装节点）', () => {
    const out = bodyOrFailure(body, 's', null);
    expect(renderToStaticMarkup(out as never)).toBe(bodyHtml);
  });

  it('有数据 + 有失败 → 数据 + 陈旧失败行（数据保留不丢）', () => {
    const html = renderToStaticMarkup(createElement('div', null, bodyOrFailure(body, 's', 'E') as never));
    expect(html).toContain('data-anic-failed-with-data="s"');
    expect(html).toContain('data-test-body'); // 数据仍在
    expect(html).toContain('data-anic-failed-s="true"'); // 失败如实标注
  });
});

describe('失败通道写入语义（panelActions.markFetchFailure / clearFetchFailure）', () => {
  it('mark 记录分类文案（http → routeUnavailable 含状态码）', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    expect(store.getState().failures['budget']).toContain('500');
  });

  it('mark 分类：malformed 与 network 各走各自文案', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    a.markFetchFailure('a', { kind: 'malformed' });
    a.markFetchFailure('b', { kind: 'network', message: 'boom' });
    expect(store.getState().failures['a']).not.toBe(store.getState().failures['b']);
    expect(store.getState().failures['b']).toBe('boom'); // network 原样
  });

  it('守卫纪律②零通知不变式：同内容重复 mark 不通知（否则每 4s tick 都全场重渲）', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    let notified = 0;
    const unsub = store.subscribe(() => { notified++; });
    // 同一条失败连续 mark 三次——4s 档每轮都失败的常态
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    expect(notified, '同内容重复 mark 必须零通知').toBe(0);
    unsub();
  });

  it('守卫纪律②（清除侧）：无记录时 clear 零通知；有记录时清除并通知一次', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    let notified = 0;
    const unsub = store.subscribe(() => { notified++; });
    a.clearFetchFailure('nope'); // 无记录
    expect(notified).toBe(0);
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    expect(notified).toBe(1);
    a.clearFetchFailure('budget');
    expect(notified).toBe(2);
    expect(store.getState().failures['budget']).toBeUndefined();
    unsub();
  });

  it('内容变化才通知（先记 500 再记 404 → 文案不同 → 通知）', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    let notified = 0;
    const unsub = store.subscribe(() => { notified++; });
    a.markFetchFailure('budget', { kind: 'http', status: 404 });
    expect(notified).toBe(1);
    unsub();
  });

  it('守卫纪律③隔离：mark 一个 key 不影响其它 key 的记录', () => {
    const store = freshStore();
    const a = bindPanelActions(store);
    a.markFetchFailure('budget', { kind: 'http', status: 500 });
    a.markFetchFailure('hitlAudit', { kind: 'malformed' });
    a.clearFetchFailure('budget');
    expect(store.getState().failures['budget']).toBeUndefined();
    expect(store.getState().failures['hitlAudit']).toBeDefined(); // 邻居不受影响
  });
});

describe('分区级失败的端到端渲染（store → 分区 → DOM）', () => {
  it('budget：端点失败后分区不再静默——失败行出现在 DOM', () => {
    const store = freshStore();
    const actions = bindPanelActions(store);
    actions.markFetchFailure('budget', { kind: 'http', status: 503 });
    const html = renderSection(store, createElement(BudgetSection, { store }));
    expect(html).toContain('data-anic-failed-budget="true"');
    expect(html).toContain('503');
  });

  it('cycles：两端点 key 聚合——任一端失败即如实呈现（多端点分区不静默）', () => {
    const store = freshStore();
    const actions = bindPanelActions(store);
    actions.markFetchFailure('cycleList', { kind: 'http', status: 500 });
    const html = renderSection(store, createElement(CyclesSection, { store }));
    expect(html).toContain('data-anic-failed-cycles="true"');
  });

  it('cycles：另一端点失败同样聚合命中（cycleState）', () => {
    const store = freshStore();
    const actions = bindPanelActions(store);
    actions.markFetchFailure('cycleState', { kind: 'network', message: 'net-down' });
    const html = renderSection(store, createElement(CyclesSection, { store }));
    expect(html).toContain('data-anic-failed-cycles="true"');
    expect(html).toContain('net-down');
  });

  it('ledger：list/verify 两端点分别失败都聚合到分区', () => {
    for (const key of ['ledgerList', 'ledgerVerify']) {
      const store = freshStore();
      bindPanelActions(store).markFetchFailure(key, { kind: 'http', status: 500 });
      const html = renderSection(store, createElement(LedgerSection, { store, onShowMore: () => {} }));
      expect(html, `${key} 应聚合命中`).toContain('data-anic-failed-ledger="true"');
    }
  });

  it('org / skillHealth / techDebt：三区失败均如实呈现（此前全部静默）', () => {
    // 锚点 id 小写（data-* 属性名大小写不敏感，且须守全仓小写 kebab 约定）。
    const cases: Array<[string, string]> = [
      ['orgStatus', 'org'],
      ['skillHealth', 'skillhealth'],
      ['techDebt', 'techdebt'],
    ];
    for (const [key, anchorId] of cases) {
      const store = freshStore();
      bindPanelActions(store).markFetchFailure(key, { kind: 'http', status: 502 });
      const node = anchorId === 'org' ? createElement(OrgSection, { store })
        : anchorId === 'skillhealth' ? createElement(SkillHealthSection, { store })
        : createElement(TechDebtSection, { store });
      expect(renderSection(store, node), `${anchorId} 应呈现失败行`).toContain(`data-anic-failed-${anchorId}="true"`);
    }
  });

  it('无失败记录 → 分区不出现失败行（既有渲染零回归）', () => {
    const store = freshStore();
    const html = renderSection(store, createElement(BudgetSection, { store }));
    expect(html).not.toContain('data-anic-failed-budget');
  });

  it('恢复语义：mark 后 clear → 失败行消失（恢复即如实撤销）', () => {
    const store = freshStore();
    const actions = bindPanelActions(store);
    actions.markFetchFailure('budget', { kind: 'http', status: 500 });
    expect(renderSection(store, createElement(BudgetSection, { store }))).toContain('data-anic-failed-budget="true"');
    actions.clearFetchFailure('budget');
    expect(renderSection(store, createElement(BudgetSection, { store }))).not.toContain('data-anic-failed-budget');
  });

  it('关闭形态优先于失败行：flows/hitl 门控关闭时渲染禁用说明而非失败行', () => {
    const store = freshStore();
    bindPanelActions(store).markFetchFailure('flowsStatus', { kind: 'http', status: 500 });
    const flowsHtml = renderSection(store, createElement(FlowsSection, { store, enabled: false }));
    expect(flowsHtml).toContain('data-anic-flowsview-disabled');
    expect(flowsHtml).not.toContain('data-anic-failed-flows');

    const store2 = freshStore();
    bindPanelActions(store2).markFetchFailure('hitlAudit', { kind: 'http', status: 500 });
    const hitlHtml = renderSection(store2, createElement(HitlSection, { store: store2, enabled: false }));
    expect(hitlHtml).toContain('data-anic-approvals-disabled');
    expect(hitlHtml).not.toContain('data-anic-failed-hitl');
  });

  it('门控开启时失败行恢复可见（关闭==抑制展示，不是丢弃证据）', () => {
    const store = freshStore();
    bindPanelActions(store).markFetchFailure('flowsStatus', { kind: 'http', status: 500 });
    const html = renderSection(store, createElement(FlowsSection, { store, enabled: true }));
    expect(html).toContain('data-anic-failed-flows="true"');
  });
});
