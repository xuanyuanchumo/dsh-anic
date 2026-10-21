/**
 * 面板动作层（cycle-46 T-4601）—— 写侧收口：actions 与 store 共置。
 *
 * 背景（ui-research 简报 ROI ③，zustand v5「actions live in the store」）：
 * ~20 个 setState 写点曾散布 4 文件（WorkflowGraphPanel 七个内联 setter +
 * 八个 apply 直写、useInvocations 三处、governanceTargets setter 下传），
 * 「先读后写」不变量（announce 回读、malformed 保 source）埋在各钩子内，
 * 新切片加入时无集中过渡点。
 *
 * 本文件把全部写路径收口为具名动作：
 *   - 快照域：setGraph / setFetchLine（复合 updater）/ markLive / degradeToEmbedded；
 *   - 步骤流程/自检域：setTrace / failTrace / setCheck / failCheck；
 *   - 实时调用域：applyInvocations（announce 回读不变量在此）/ failInvocations
 *     （三分类文案）/ recoverInvocations；
 *   - 4s 档静默域：setOrgStatus / setFlowsStatus / setCycleList / setCycleState /
 *     setSkillHealth / setBudget / setLedgerList / setLedgerVerify / setHitlAudit。
 *
 * 三分类降级文案规则（与 panelLiveTargets/useInvocations 历史行为逐字一致——
 * 回归红线）收敛为单一 classifier：http → routeUnavailable、malformed →
 * malformedNotUsed、network → message 原样。
 */
import { t } from '../i18n.ts';
import type { GraphData } from '../features/graph/renderGraph.ts';
import type { StepTraceJson } from '../features/stepTrace/renderStepTrace.ts';
import type { SelfCheckJson } from '../features/diagnostics/renderDiagnostics.ts';
import type { OrgStatusJson } from '../features/org/renderOrgStatus.ts';
import type { FlowStatusJson } from '../features/flows/renderFlows.ts';
import type { CycleListJson, CycleStateJson } from '../features/cycles/renderCyclesTimeline.ts';
import type { LedgerListJson, LedgerVerifyJson } from '../features/ledger/renderLedger.ts';
import type { HitlAuditJson } from '../features/hitl/renderHitl.ts';
import type { BudgetJson } from '../features/budget/renderBudget.ts';
import type { SkillHealthJson } from '../features/skillhealth/renderSkillHealth.ts';
import type { TechDebtListingJson } from '../features/techdebt/renderTechDebt.ts';
import type { InvocationsJson } from '../features/live/renderInvocations.ts';
import type { FetchFailure } from './usePanelFetch.ts';
import type { PanelDataStore, FetchSource } from '../panelState.ts';

/** 拉取失败的行级文案三分类（唯一 classifier——原散布三处的规则收拢）。 */
export function classifyFailure(f: FetchFailure): string {
  if (f.kind === 'http') return t('panel.routeUnavailable', { status: String(f.status) });
  if (f.kind === 'malformed') return t('panel.malformedNotUsed');
  return f.message;
}

/** 快照来源复合 updater 的求值输入（malformed 降级「保 source」语义的载体）。 */
export interface FetchLineView {
  source: FetchSource;
  line: string;
}

/** 面板动作集（store 写路径的唯一门面；类型而非实现）。 */
export interface PanelActions {
  // ── 快照域 ──────────────────────────────────────────────────────────
  /** 快照数据落地（graph 切片）。 */
  setGraph(d: GraphData): void;
  /** 复合写：读当前 source/line 原子快照计算新行（malformed 保 source 等）。 */
  setFetchLine(updater: (view: FetchLineView) => FetchLineView): void;
  // ── 步骤流程 / 自检域（行级降级：失败清数据 + 文案进 line 切片）─────────
  setTrace(v: StepTraceJson | null, line: string): void;
  setCheck(v: SelfCheckJson | null, line: string): void;
  // ── 实时调用域（announce 回读不变量 + 三分类错误文案）──────────────────
  /** 应用新调用流；announce 无增量时保留旧值（回读进 updater，同值零通知）。 */
  applyInvocations(nv: InvocationsJson, announce: string, hasDelta: boolean): void;
  /** 轮询失败：错误文案置位（数据保留——「没有调用」与「拉不到」可分辨）。 */
  failInvocations(f: FetchFailure): void;
  /** 成功恢复：清错误通道。 */
  recoverInvocations(): void;
  // ── 4s 档静默域（guard 不过/失败 → 不 apply，分区不渲染）────────────────
  setOrgStatus(v: OrgStatusJson): void;
  setFlowsStatus(v: FlowStatusJson): void;
  setCycleList(v: CycleListJson): void;
  setCycleState(v: CycleStateJson): void;
  setSkillHealth(v: SkillHealthJson): void;
  setTechDebt(v: TechDebtListingJson): void;
  setBudget(v: BudgetJson): void;
  setLedgerList(v: LedgerListJson): void;
  setLedgerVerify(v: LedgerVerifyJson): void;
  setHitlAudit(v: HitlAuditJson): void;
}

/**
 * 把 store 绑定为动作集（zustand「actions live in the store」的手写等价物）。
 *
 * 依赖方向：actions 层依赖 store 机制层与 i18n，不依赖任何组件——可被
 * usePanelFetch target、useInvocations、根组件共同消费，写路径唯一化。
 */
export function bindPanelActions(store: PanelDataStore): PanelActions {
  return {
    // 快照域：复合写走函数式补丁（读-改-写原子化，T-4502a 语义）。
    setGraph: (d) => { store.setState({ graph: d }); },
    setFetchLine: (updater) => {
      store.setState((s) => {
        const r = updater({ source: s.fetchSource, line: s.fetchLine });
        return { fetchSource: r.source, fetchLine: r.line };
      });
    },
    // 步骤流程/自检域：数据与行文案同补丁落地（两切片一次写）。
    setTrace: (v, line) => { store.setState({ trace: v, traceLine: line }); },
    setCheck: (v, line) => { store.setState({ check: v, checkLine: line }); },
    // 实时调用域：announce 回读不变量进动作层（原 useInvocations 钩子内逻辑）。
    applyInvocations: (nv, announce, hasDelta) => {
      store.setState((s) => ({
        invocations: nv,
        invocationsAnnounce: hasDelta ? announce : s.invocationsAnnounce,
      }));
    },
    failInvocations: (f) => { store.setState({ invocationsError: classifyFailure(f) }); },
    recoverInvocations: () => { store.setState({ invocationsError: null }); },
    // 4s 档静默域：单切片直写。
    setOrgStatus: (v) => { store.setState({ orgStatus: v }); },
    setFlowsStatus: (v) => { store.setState({ flowsStatus: v }); },
    setCycleList: (v) => { store.setState({ cycleList: v }); },
    setCycleState: (v) => { store.setState({ cycleState: v }); },
    setSkillHealth: (v) => { store.setState({ skillHealth: v }); },
    setTechDebt: (v) => { store.setState({ techDebt: v }); },
    setBudget: (v) => { store.setState({ budget: v }); },
    setLedgerList: (v) => { store.setState({ ledgerList: v }); },
    setLedgerVerify: (v) => { store.setState({ ledgerVerify: v }); },
    setHitlAudit: (v) => { store.setState({ hitlAudit: v }); },
  };
}
