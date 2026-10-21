/**
 * 面板分区订阅薄组件（cycle-42 Top2）—— store 切片到纯渲染函数的桥。
 *
 * 每个分区组件只做两件事：usePanelSlice 订阅自己消费的切片 + 调用既有
 * 纯函数 render*（签名零变化——invocationsRender 等 21+ 用例零改动）。
 * 分区间的重渲隔离由此达成：
 *   - 2s invocations tick → 只有 LiveInvocationsSection 重渲；
 *   - 4s 治理/节奏档 → 只有订阅对应切片的分区重渲；
 *   - 根组件 UI 态（prefsOpen/reloadKey 等）变化 → React.memo 拦截级联
 *     （props 全部引用稳定：store 实例 / 布尔 / useCallback 回调）。
 *
 * selector 全部模块级函数（引用稳定 + 返回切片原引用——usePanelSlice 的
 * 两条硬契约，见 components/panelStore.ts 文件头）。多值消费 = 每值独立
 * 订阅（zustand v5 官方首推，不引入 useShallow）。
 *
 * LiveInvocationsSection 叠加 useDeferredValue（ui-research 主题三）：
 * store 通知走 SyncLane（订阅组件同步重渲本体），昂贵列表经 defer 降为
 * 可中断渲染；`invocations !== deferred`（引用比较）驱动陈旧指示——
 * 2s 轮询语义下滞后一个渲染周期可接受。
 */
import { createElement, memo, useDeferredValue, type ReactElement } from 'react';
import { usePanelSlice } from './panelStore.ts';
import type { PanelDataStore, PanelState } from '../panelState.ts';
import type { WorkflowNode } from '../workflowGraphData.ts';
import { t } from '../i18n.ts';
import { renderGraph, buildVerdicts } from '../features/graph/renderGraph.ts';
import { renderStepTrace } from '../features/stepTrace/renderStepTrace.ts';
import { renderDiagnostics } from '../features/diagnostics/renderDiagnostics.ts';
import { renderOrgStatus } from '../features/org/renderOrgStatus.ts';
import { renderAutonomyGauge } from '../features/autonomy/renderAutonomyGauge.ts';
import { renderSkillHealth } from '../features/skillhealth/renderSkillHealth.ts';
import { renderFlows } from '../features/flows/renderFlows.ts';
import { renderCyclesTimeline } from '../features/cycles/renderCyclesTimeline.ts';
import { renderLedger } from '../features/ledger/renderLedger.ts';
import { renderHitl } from '../features/hitl/renderHitl.ts';
import { renderBudget } from '../features/budget/renderBudget.ts';
import { renderInvocations } from '../features/live/renderInvocations.ts';
import { renderFoldableSection, renderSectionWrap, renderSectionDisabled } from './sectionShell.ts';

// ── 模块级 selector（usePanelSlice 硬契约：引用稳定 + 返回原引用）──────────
const selGraph = (s: PanelState) => s.graph;
const selTrace = (s: PanelState) => s.trace;
const selTraceLine = (s: PanelState) => s.traceLine;
const selCheck = (s: PanelState) => s.check;
const selCheckLine = (s: PanelState) => s.checkLine;
const selOrgStatus = (s: PanelState) => s.orgStatus;
const selFlowsStatus = (s: PanelState) => s.flowsStatus;
const selCycleList = (s: PanelState) => s.cycleList;
const selCycleState = (s: PanelState) => s.cycleState;
const selLedgerList = (s: PanelState) => s.ledgerList;
const selLedgerVerify = (s: PanelState) => s.ledgerVerify;
const selHitlAudit = (s: PanelState) => s.hitlAudit;
const selBudget = (s: PanelState) => s.budget;
const selSkillHealth = (s: PanelState) => s.skillHealth;
const selInvocations = (s: PanelState) => s.invocations;
const selInvocationsError = (s: PanelState) => s.invocationsError;
const selInvocationsAnnounce = (s: PanelState) => s.invocationsAnnounce;

// ── 图区（数据来自一次性拉取：快照 + step-trace，低频）─────────────────
interface GraphSectionProps { store: PanelDataStore; onNodeClick: (node: WorkflowNode) => void; }
function GraphSectionImpl({ store, onNodeClick }: GraphSectionProps): ReactElement {
  const graph = usePanelSlice(store, selGraph);
  const trace = usePanelSlice(store, selTrace);
  return renderGraph(graph, buildVerdicts(trace), onNodeClick);
}
/** 图区：订阅 graph + trace 两切片（verdicts 由 trace 派生）。 */
export const GraphSection = memo(GraphSectionImpl);

// ── 实时调用流（2s tick —— Top2 主战场）────────────────────────────────
interface LiveInvocationsSectionProps { store: PanelDataStore; autoRefreshOn: boolean; }
function LiveInvocationsSectionImpl({ store, autoRefreshOn }: LiveInvocationsSectionProps): ReactElement {
  const invocations = usePanelSlice(store, selInvocations);
  const pollError = usePanelSlice(store, selInvocationsError);
  const announce = usePanelSlice(store, selInvocationsAnnounce);
  // useDeferredValue：昂贵列表降为可中断渲染；紧急渲染期间引用不变 →
  // React 跳过列表 diff（旧元素树复用）。stale = 引用不同步（正在追赶）。
  const deferredInvocations = useDeferredValue(invocations);
  const stale = invocations !== deferredInvocations;
  // 陈旧指示：外层透明度（非颜色字面量——设计令牌纪律不受影响）。
  // 滞后一个渲染周期在 2s 轮询语义下不可感知，换昂贵分区的可中断更新。
  return createElement('div', { 'data-anic-live-deferred': stale ? 'stale' : 'fresh', style: { opacity: stale ? 0.75 : 1 } },
    renderInvocations(deferredInvocations, pollError, autoRefreshOn, announce));
}
/** 实时调用流：订阅 invocations 三切片 + deferred 列表（可中断渲染）。 */
export const LiveInvocationsSection = memo(LiveInvocationsSectionImpl);

// ── Cycle 时间线（4s 档两切片）─────────────────────────────────────────
interface SectionProps { store: PanelDataStore; }
function CyclesSectionImpl({ store }: SectionProps): ReactElement {
  const list = usePanelSlice(store, selCycleList);
  const state = usePanelSlice(store, selCycleState);
  return renderFoldableSection({ id: 'cycles', title: t('fold.cycles'), children: renderCyclesTimeline({ list, state }) });
}
export const CyclesSection = memo(CyclesSectionImpl);

// ── 步骤流程 / 自检（一次性拉取 + 开关门控）────────────────────────────
interface GatedSectionProps extends SectionProps { enabled: boolean; }
function StepTraceSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const trace = usePanelSlice(store, selTrace);
  const traceLine = usePanelSlice(store, selTraceLine);
  return renderFoldableSection({ id: 'stepTrace', title: t('fold.stepTrace'), children: enabled
    ? renderSectionWrap({
        anchorKey: 'data-anic-steptrace-wrap',
        dataLine: t('panel.traceDataLine', { line: traceLine }),
        body: trace === null ? null : renderStepTrace(trace),
        unavailableText: t('panel.traceUnavailable'),
      })
    : renderSectionDisabled({ anchorKey: 'data-anic-steptrace-disabled', text: t('panel.traceDisabled') }) });
}
export const StepTraceSection = memo(StepTraceSectionImpl);

function DiagnosticsSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const check = usePanelSlice(store, selCheck);
  const checkLine = usePanelSlice(store, selCheckLine);
  return renderFoldableSection({ id: 'diagnostics', title: t('fold.diagnostics'), children: enabled
    ? renderSectionWrap({
        anchorKey: 'data-anic-diagnostics-wrap',
        dataLine: t('panel.diagDataLine', { line: checkLine }),
        body: check === null ? null : renderDiagnostics(check),
        unavailableText: t('panel.diagUnavailable'),
      })
    : renderSectionDisabled({ anchorKey: 'data-anic-diagnostics-disabled', text: t('panel.diagDisabled') }) });
}
export const DiagnosticsSection = memo(DiagnosticsSectionImpl);

// ── org 全景（自主级仪表带 + 文本明细，同一数据源）──────────────────────
function OrgSectionImpl({ store }: SectionProps): ReactElement {
  const orgStatus = usePanelSlice(store, selOrgStatus);
  return renderFoldableSection({ id: 'org', title: t('fold.org'), children: [
    orgStatus ? createElement('div', { 'data-anic-gauge-wrap': 'true', key: 'gauge' }, renderAutonomyGauge(orgStatus)) : null,
    orgStatus ? createElement('div', { 'data-anic-org-wrap': 'true', key: 'org' }, renderOrgStatus(orgStatus)) : null,
  ] });
}
export const OrgSection = memo(OrgSectionImpl);

// ── 技能健康 / 流程状态机（4s 档）───────────────────────────────────────
function SkillHealthSectionImpl({ store }: SectionProps): ReactElement {
  const skillHealth = usePanelSlice(store, selSkillHealth);
  return renderFoldableSection({ id: 'skillHealth', title: t('fold.skillHealth'), children: renderSkillHealth(skillHealth) });
}
export const SkillHealthSection = memo(SkillHealthSectionImpl);

function FlowsSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const flowsStatus = usePanelSlice(store, selFlowsStatus);
  return renderFoldableSection({ id: 'flows', title: t('fold.flows'), children: enabled
    ? renderFlows(flowsStatus)
    : renderSectionDisabled({ anchorKey: 'data-anic-flowsview-disabled', text: t('flows.disabled') }) });
}
export const FlowsSection = memo(FlowsSectionImpl);

// ── 账本事件流（分页：hasMore 由本组件订阅的数据自算，不进 props）────────
interface LedgerSectionProps extends SectionProps { onShowMore: () => void; }
function LedgerSectionImpl({ store, onShowMore }: LedgerSectionProps): ReactElement {
  const ledgerList = usePanelSlice(store, selLedgerList);
  const ledgerVerify = usePanelSlice(store, selLedgerVerify);
  return renderFoldableSection({ id: 'ledger', title: t('fold.ledger'), children: renderLedger(ledgerList, ledgerVerify, ledgerList !== null && ledgerList.entries.length < ledgerList.total
    ? { hasMore: true, onShowMore }
    : undefined) });
}
export const LedgerSection = memo(LedgerSectionImpl);

// ── HITL 审计队列（开关门控）───────────────────────────────────────────
function HitlSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const hitlAudit = usePanelSlice(store, selHitlAudit);
  return renderFoldableSection({ id: 'hitl', title: t('fold.hitl'), children: enabled
    ? renderHitl(hitlAudit)
    : renderSectionDisabled({ anchorKey: 'data-anic-approvals-disabled', text: t('hitl.disabled') }) });
}
export const HitlSection = memo(HitlSectionImpl);

// ── 治理预算（4s 档）───────────────────────────────────────────────────
function BudgetSectionImpl({ store }: SectionProps): ReactElement {
  const budget = usePanelSlice(store, selBudget);
  return renderFoldableSection({ id: 'budget', title: t('fold.budget'), children: renderBudget(budget) });
}
export const BudgetSection = memo(BudgetSectionImpl);

// ── 工具栏状态行（store 订阅薄组件）────────────────────────────────────
// cycle-45（T-4502a）：原嵌套切片 fetchState.line → 顶层 fetchLine（扁平化，
// line 单值订阅——source 变化不再牵动本行重渲路径）。
const selFetchLine = (s: PanelState) => s.fetchLine;
/** 工具栏 `ANIC · …` 状态行（aria-live polite——异步拉取结果可感知）。 */
function ToolbarStatusLineImpl({ store }: SectionProps): ReactElement {
  const line = usePanelSlice(store, selFetchLine);
  return createElement('span', { role: 'status', 'aria-live': 'polite' }, `ANIC · ${line}`);
}
export const ToolbarStatusLine = memo(ToolbarStatusLineImpl);
