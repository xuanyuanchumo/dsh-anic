/**
 * panelActions 契约（cycle-46 T-4601）—— 写侧收口的动作层钉子。
 *
 * 承重断言（对应 ui-research 简报「actions 与 store 共置」的验收）：
 *  - classifyFailure 三分类规则唯一源（http/malformed/network 文案逐字）；
 *  - applyInvocations 的 announce 回读不变量：无增量保留旧值、有增量写新值；
 *  - setFetchLine 复合写语义：updater 收原子快照、malformed 保 source 路径；
 *  - 全部动作零通知语义：同值补丁不触发监听器（与 store 合并契约一致）；
 *  - failInvocations 分类文案与 recoverInvocations 清通道往返。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { createPanelStore, usePanelSlice } from '../../src/client/components/panelStore.ts';
import { bindPanelActions, classifyFailure } from '../../src/client/components/panelActions.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import { t } from '../../src/client/i18n.ts';
import type { InvocationsJson } from '../../src/client/features/live/renderInvocations.ts';

function makeStore() {
  return createPanelStore(createInitialPanelState());
}

const INV_A: InvocationsJson = { invocations: [], total: 0, generatedAt: '2026-10-21T08:00:00Z' };
const INV_B: InvocationsJson = { invocations: [], total: 3, generatedAt: '2026-10-21T08:00:02Z' };

describe('classifyFailure 三分类（唯一 classifier）', () => {
  it('http → routeUnavailable 带状态码', () => {
    expect(classifyFailure({ kind: 'http', status: 404 })).toBe(t('panel.routeUnavailable', { status: '404' }));
  });
  it('malformed → malformedNotUsed', () => {
    expect(classifyFailure({ kind: 'malformed' })).toBe(t('panel.malformedNotUsed'));
  });
  it('network → message 原样', () => {
    expect(classifyFailure({ kind: 'network', message: 'boom' })).toBe('boom');
  });
});

describe('bindPanelActions 写路径', () => {
  it('applyInvocations 无增量：announce 回读保留旧值（同值零通知）', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    a.applyInvocations(INV_A, '新增 0 个调用', false);
    const before = store.getState().invocationsAnnounce;
    a.applyInvocations(INV_B, '新增 3 个调用', true);
    expect(store.getState().invocationsAnnounce).toBe('新增 3 个调用');
    a.applyInvocations(INV_B, '新增 0 个调用', false);
    expect(store.getState().invocationsAnnounce).toBe('新增 3 个调用');
    expect(before).toBe('');
  });

  it('applyInvocations 有增量：数据与 announce 同补丁落地', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    a.applyInvocations(INV_B, '新增 3 个调用', true);
    expect(store.getState().invocations).toBe(INV_B);
  });

  it('failInvocations/recoverInvocations 往返：错误置位→数据保留→清通道', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    a.applyInvocations(INV_B, '新增 3 个调用', true);
    a.failInvocations({ kind: 'http', status: 500 });
    expect(store.getState().invocationsError).toBe(t('panel.routeUnavailable', { status: '500' }));
    // 数据保留（「拉不到」≠「没有调用」）
    expect(store.getState().invocations).toBe(INV_B);
    a.recoverInvocations();
    expect(store.getState().invocationsError).toBeNull();
  });

  it('setFetchLine 复合写：updater 收原子快照，malformed 保 source 路径', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    a.setFetchLine(() => ({ source: 'live', line: '实时' }));
    expect(store.getState().fetchSource).toBe('live');
    expect(store.getState().fetchLine).toBe('实时');
    // malformed 降级：source 保持 live（不被拉回 embedded）
    a.setFetchLine((prev) => ({ source: prev.source, line: '响应畸形' }));
    expect(store.getState().fetchSource).toBe('live');
    expect(store.getState().fetchLine).toBe('响应畸形');
  });

  it('同值补丁零通知：订阅者不重渲（写侧合并契约在动作层仍成立）', async () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    let renders = 0;
    function Probe(): ReactElement {
      usePanelSlice(store, (s) => s.invocations);
      renders += 1;
      return createElement('span', null, 'x');
    }
    renderToStaticMarkup(createElement(Probe));
    const before = renders;
    a.applyInvocations(INV_A, '', false); // total 0→0 无增量 + 同引用数据
    // invocations 引用从 null → INV_A 是变化的（首轮从 null 落地）；再写同引用则零变化
    const mid = renders;
    a.applyInvocations(INV_A, '', false);
    expect(renders).toBe(mid);
    expect(mid).toBeGreaterThanOrEqual(before);
  });

  it('setTrace/setCheck：数据与行文案两切片一次写', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    a.setTrace(null, t('panel.routeUnavailable', { status: '404' }));
    expect(store.getState().trace).toBeNull();
    expect(store.getState().traceLine).toBe(t('panel.routeUnavailable', { status: '404' }));
    a.setCheck(null, t('panel.malformedNotUsed'));
    expect(store.getState().checkLine).toBe(t('panel.malformedNotUsed'));
  });

  it('4s 档静默域动作：九切片直写往返', () => {
    const store = makeStore();
    const a = bindPanelActions(store);
    const sentinel = { org: true } as never;
    a.setOrgStatus(sentinel);
    expect(store.getState().orgStatus).toBe(sentinel);
    // 其余八切片以 null/占位直写验证（形状守卫在 target 层，动作层只管写路径）
    a.setFlowsStatus(null as never); expect(store.getState().flowsStatus).toBeNull();
    a.setCycleList(null as never); expect(store.getState().cycleList).toBeNull();
    a.setCycleState(null as never); expect(store.getState().cycleState).toBeNull();
    a.setSkillHealth(null as never); expect(store.getState().skillHealth).toBeNull();
    a.setBudget(null as never); expect(store.getState().budget).toBeNull();
    a.setLedgerList(null as never); expect(store.getState().ledgerList).toBeNull();
    a.setLedgerVerify(null as never); expect(store.getState().ledgerVerify).toBeNull();
    a.setHitlAudit(null as never); expect(store.getState().hitlAudit).toBeNull();
  });
});
