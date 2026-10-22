/**
 * 实时调用分区的**编排**（cycle-71 T-7131）——把两件事按用户要求的顺序接起来：
 *   ① 「最近一次已完成调用全貌卡」（有已完成调用时）；
 *   ② 既有实时调用流（renderInvocations：运行中/三态/historical 组）。
 *
 * 为什么不把这层塞进 renderInvocations 或 panelSections：
 *   - renderInvocations 已 220 行（T3 ≤250 纪律），且它的既有断言面（分组/
 *     截限/诊断行）不该因为一张新卡片而变动；
 *   - panelSections 是装配层（198 行），只该多一行订阅与一行调用。
 *
 * 账本条目由调用方作为切片传入（门禁裁决段的数据源）：与既有「治理 4s 档」
 * 同引用，本编排不自拉数据——编排层不发请求（与各域 render* 同纪律）。
 */
import { createElement, type ReactElement } from 'react';
import { mostRecentCompleted } from './invocationGrouping.ts';
import { renderLastCompletedCard, type GateLedgerView } from './renderLastCompletedCard.ts';
import { renderInvocations } from './renderInvocations.ts';
import type { InvocationJson, InvocationsJson } from './renderInvocationsTypes.ts';

/** 已完成调用本体（data 为 null 时没有「已完成」可言 → null）。 */
export function lastCompletedOf(data: InvocationsJson | null): InvocationJson | null {
  return data === null ? null : mostRecentCompleted(data.invocations);
}

/**
 * 渲染实时调用分区主体：最近完成卡 + 调用流。
 *
 * 卡片与列表是**兄弟**关系（不是嵌套）：列表内的聚合播报区是 aria-live
 * polite，卡片按 APG 不得进入自动更新的 live region——兄弟关系使这条
 * 结构约束在源码里就可读（不靠渲染时判断）。
 */
export function renderLiveSection(
  data: InvocationsJson | null,
  pollError: string | null,
  autoRefreshOn: boolean,
  announce: string,
  ledger?: GateLedgerView | null,
): ReactElement {
  const last = lastCompletedOf(data);
  return createElement(
    'div',
    { 'data-anic-live-wrap': 'true' },
    last !== null ? renderLastCompletedCard(last, ledger) : null,
    renderInvocations(data, pollError, autoRefreshOn, announce),
  );
}
