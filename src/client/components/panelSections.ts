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
import { t } from '../i18n.ts';
// cycle-82：图区分区已拆至 features/graph/GraphSection.ts（同域一文件），
// 本文件只做**再导出**门面——装配层与契约测试的 import 路径零变更。
import { renderStepTrace } from '../features/stepTrace/renderStepTrace.ts';
import { renderDiagnostics } from '../features/diagnostics/renderDiagnostics.ts';
import { renderOrgStatus } from '../features/org/renderOrgStatus.ts';
import { renderAutonomyGauge } from '../features/autonomy/renderAutonomyGauge.ts';
import { renderSkillHealth } from '../features/skillhealth/renderSkillHealth.ts';
import { renderTechDebt } from '../features/techdebt/renderTechDebt.ts';
// cycle-72 T-7207：闭环体检分区（注册↔生产↔消费 三态矩阵的白盒面）。
import { renderClosure } from '../features/closure/renderClosure.ts';
import { renderFlows } from '../features/flows/renderFlows.ts';
import { renderCyclesTimeline } from '../features/cycles/renderCyclesTimeline.ts';
import { renderLedger } from '../features/ledger/renderLedger.ts';
import { renderHitl } from '../features/hitl/renderHitl.ts';
import { renderBudget } from '../features/budget/renderBudget.ts';
import { renderLiveSection } from '../features/live/renderLiveSection.ts';
import { renderFoldableSection, renderSectionWrap, renderSectionDisabled } from './sectionShell.ts';
// cycle-71 T-7117：4s 档分区失败行（消除「分区静默空体」——见该文件头注）。
import { useSectionBody, useSectionFailure, bodyOrFailure } from './sectionFailure.ts';

// ── 模块级 selector（usePanelSlice 硬契约：引用稳定 + 返回原引用）──────────
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
const selTechDebt = (s: PanelState) => s.techDebt;
const selInvocations = (s: PanelState) => s.invocations;
const selInvocationsError = (s: PanelState) => s.invocationsError;
const selInvocationsAnnounce = (s: PanelState) => s.invocationsAnnounce;

// ── 折叠策略（cycle-71 T-7131 · 用户要求核心）─────────────────────────────────
/**
 * 用户要求：面板默认**只**展开「最近一次已完成调用 + 运行时调用可视化」，
 * 静态产物分区默认收纳。live 分区不是 renderFoldableSection 体系（自带
 * turn 组 details），故此处只给静态分区定默认态——
 *   - 其余九个静态分区默认 false（收纳）；closure（cycle-72 闭环体检）例外为 true——
 *   - diagnostics 与 hitl 例外保留 true，两者都是**兜底观测面**：
 *     diagnostics 是运行时自检（不展开就看不到失败项，问题被收纳静默），
 *     hitl 是关闭形态可观测兜底（flow.approvals 关闭时那一行如实说明必须
 *     可见，否则「关了什么」本身也被折叠）。用户在抽屉/折叠交互里显式折叠
 *     后，记忆生效（本默认只在无记忆时适用）。
 */
const DEFAULT_OPEN_SECTIONS: ReadonlySet<string> = new Set(['diagnostics', 'hitl', 'closure']);

/** 分区默认展开态（仅上述两个兜底分区为 true）。 */
function defaultOpenOf(id: string): boolean {
  return DEFAULT_OPEN_SECTIONS.has(id);
}

// ── 图区（cycle-82：已拆至 features/graph/GraphSection.ts，此处**再导出**门面）──
/**
 * 为什么拆走：本文件是十个分区的订阅薄层聚合面，cycle-82 的图区改造（交互版 +
 * 布局/视口/筛选说明）把它推过 T3 的 250 行硬限。拆分的界线是**职责**——图区分区
 * 与 GraphInteractive / renderGraph 同域，搬回 `features/graph/` 才是一域一文件。
 *
 * 再导出而非改调用方：`WorkflowGraphPanel` 与 `graphInteractiveContract` 都从
 * 本文件 import `GraphSection`，路径零变更（与 `runtime/hotReload.ts` 的纯门面同款）。
 */
export { GraphSection } from '../features/graph/GraphSection.ts';

// ── 实时调用流（2s tick —— Top2 主战场 / cycle-71 T-7131 用户要求核心）────────
interface LiveInvocationsSectionProps { store: PanelDataStore; autoRefreshOn: boolean; }
function LiveInvocationsSectionImpl({ store, autoRefreshOn }: LiveInvocationsSectionProps): ReactElement {
  const invocations = usePanelSlice(store, selInvocations);
  const pollError = usePanelSlice(store, selInvocationsError);
  const announce = usePanelSlice(store, selInvocationsAnnounce);
  // cycle-71 T-7131：门禁裁决段的数据源（治理 4s 档账本切片，与 LedgerSection 同引用）。
  const ledger = usePanelSlice(store, selLedgerList);
  // useDeferredValue：昂贵列表降为可中断渲染；紧急渲染期间引用不变 →
  // React 跳过列表 diff（旧元素树复用）。stale = 引用不同步（正在追赶）。
  const deferredInvocations = useDeferredValue(invocations);
  const stale = invocations !== deferredInvocations;
  // 陈旧指示：外层透明度（非颜色字面量——设计令牌纪律不受影响）。
  // 滞后一个渲染周期在 2s 轮询语义下不可感知，换昂贵分区的可中断更新。
  return createElement('div', { 'data-anic-live-deferred': stale ? 'stale' : 'fresh', style: { opacity: stale ? 0.75 : 1 } },
    renderLiveSection(deferredInvocations, pollError, autoRefreshOn, announce, ledger));
}
/** 实时调用流：订阅 invocations 三切片 + deferred 列表（可中断渲染）。 */
export const LiveInvocationsSection = memo(LiveInvocationsSectionImpl);

// ── Cycle 时间线（4s 档两切片）─────────────────────────────────────────
interface SectionProps { store: PanelDataStore; }
function CyclesSectionImpl({ store }: SectionProps): ReactElement {
  const list = usePanelSlice(store, selCycleList);
  const state = usePanelSlice(store, selCycleState);
  // cycle-71：两端点各自记失败 key，此处聚合（一个成功一个失败时不竞态）。
  const body = useSectionBody(store, 'cycles', ['cycleList', 'cycleState'], renderCyclesTimeline({ list, state }));
  return renderFoldableSection({ id: 'cycles', title: t('fold.cycles'), defaultOpen: defaultOpenOf('cycles'), children: body });
}
export const CyclesSection = memo(CyclesSectionImpl);

// ── 步骤流程 / 自检（一次性拉取 + 开关门控）────────────────────────────
interface GatedSectionProps extends SectionProps { enabled: boolean; }
function StepTraceSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const trace = usePanelSlice(store, selTrace);
  const traceLine = usePanelSlice(store, selTraceLine);
  return renderFoldableSection({ id: 'stepTrace', title: t('fold.stepTrace'), defaultOpen: defaultOpenOf('stepTrace'), children: enabled
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
  return renderFoldableSection({ id: 'diagnostics', title: t('fold.diagnostics'), defaultOpen: defaultOpenOf('diagnostics'), children: enabled
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
  // cycle-71：org-status 失败时不再静默空体（该分区是自主级/熔断的主观测面）。
  const body = useSectionBody(store, 'org', 'orgStatus', orgStatus
    ? [
        createElement('div', { 'data-anic-gauge-wrap': 'true', key: 'gauge' }, renderAutonomyGauge(orgStatus)),
        createElement('div', { 'data-anic-org-wrap': 'true', key: 'org' }, renderOrgStatus(orgStatus)),
      ]
    : null);
  return renderFoldableSection({ id: 'org', title: t('fold.org'), defaultOpen: defaultOpenOf('org'), children: body });
}
export const OrgSection = memo(OrgSectionImpl);

// ── 技能健康 / 流程状态机（4s 档）───────────────────────────────────────
function SkillHealthSectionImpl({ store }: SectionProps): ReactElement {
  const skillHealth = usePanelSlice(store, selSkillHealth);
  const body = useSectionBody(store, 'skillHealth', 'skillHealth', renderSkillHealth(skillHealth));
  return renderFoldableSection({ id: 'skillHealth', title: t('fold.skillHealth'), defaultOpen: defaultOpenOf('skillHealth'), children: body });
}
export const SkillHealthSection = memo(SkillHealthSectionImpl);

// ── 技术债务队列（cycle-54 T-5401 · 4s 档）─────────────────────────────
// 旅程排序在技能健康后（「技能健康」→「技能欠的债」相邻呈现）；提案是评估
// 失败维度的产物，与技能健康同属「改进建议」语义簇。
function TechDebtSectionImpl({ store }: SectionProps): ReactElement {
  const techDebt = usePanelSlice(store, selTechDebt);
  const body = useSectionBody(store, 'techDebt', 'techDebt', renderTechDebt(techDebt));
  return renderFoldableSection({ id: 'techDebt', title: t('fold.techdebt'), defaultOpen: defaultOpenOf('techDebt'), children: body });
}
export const TechDebtSection = memo(TechDebtSectionImpl);

// ── 闭环体检（cycle-72 T-7207 · 一次性档：全仓扫描 ~7s，刻意不进 4s 轮询）─────
// 用户的「白盒透明化」诉求落点：未消费清单（注册了但没人读）与幽灵消费清单
// （有人在读但没注册）两张表。默认**展开**——与 diagnostics/hitl 同为兜底观测面：
// 收纳一张「有哪些资产没人消费」的表，等于把缺口藏起来（本分区存在的意义就是可见）。
export { ClosureSection } from '../features/closure/ClosureSection.ts';

function FlowsSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const flowsStatus = usePanelSlice(store, selFlowsStatus);
  // hooks 规则：订阅必须**无条件**调用（启停门控只影响 body 组装——下方三元）。
  const failure = useSectionFailure(store, 'flowsStatus');
  // 关闭形态（renderSectionDisabled）优先于失败行——「关了什么」比「取不到」更根本。
  const body = enabled
    ? bodyOrFailure(renderFlows(flowsStatus), 'flows', failure)
    : renderSectionDisabled({ anchorKey: 'data-anic-flowsview-disabled', text: t('flows.disabled') });
  return renderFoldableSection({ id: 'flows', title: t('fold.flows'), defaultOpen: defaultOpenOf('flows'), children: body });
}
export const FlowsSection = memo(FlowsSectionImpl);

// ── 账本事件流（分页：hasMore 由本组件订阅的数据自算，不进 props）────────
interface LedgerSectionProps extends SectionProps { onShowMore: () => void; }
function LedgerSectionImpl({ store, onShowMore }: LedgerSectionProps): ReactElement {
  const ledgerList = usePanelSlice(store, selLedgerList);
  const ledgerVerify = usePanelSlice(store, selLedgerVerify);
  // cycle-71：list 与 verify 是两端点——失败 key 分开记，此处聚合。
  const body = useSectionBody(store, 'ledger', ['ledgerList', 'ledgerVerify'], renderLedger(ledgerList, ledgerVerify, ledgerList !== null && ledgerList.entries.length < ledgerList.total
    ? { hasMore: true, onShowMore }
    : undefined));
  return renderFoldableSection({ id: 'ledger', title: t('fold.ledger'), defaultOpen: defaultOpenOf('ledger'), children: body });
}
export const LedgerSection = memo(LedgerSectionImpl);

// ── HITL 审计队列（开关门控）───────────────────────────────────────────
function HitlSectionImpl({ store, enabled }: GatedSectionProps): ReactElement {
  const hitlAudit = usePanelSlice(store, selHitlAudit);
  // hooks 规则：订阅无条件调用（同 FlowsSection）。
  const failure = useSectionFailure(store, 'hitlAudit');
  const body = enabled
    ? bodyOrFailure(renderHitl(hitlAudit), 'hitl', failure)
    : renderSectionDisabled({ anchorKey: 'data-anic-approvals-disabled', text: t('hitl.disabled') });
  return renderFoldableSection({ id: 'hitl', title: t('fold.hitl'), defaultOpen: defaultOpenOf('hitl'), children: body });
}
export const HitlSection = memo(HitlSectionImpl);

// ── 治理预算（4s 档）───────────────────────────────────────────────────
function BudgetSectionImpl({ store }: SectionProps): ReactElement {
  const budget = usePanelSlice(store, selBudget);
  const body = useSectionBody(store, 'budget', 'budget', renderBudget(budget));
  return renderFoldableSection({ id: 'budget', title: t('fold.budget'), defaultOpen: defaultOpenOf('budget'), children: body });
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
