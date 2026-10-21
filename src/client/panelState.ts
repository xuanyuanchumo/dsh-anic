/**
 * 面板数据状态形状（cycle-42 Top2）—— 所有轮询/一次性拉取的数据切片。
 *
 * 从 WorkflowGraphPanel 的 ~15 个数据 useState 平移而来（语义零变化）：
 * 每个切片 = 原一个 useState；UI 态（prefsOpen/selectedNode/reloadKey/
 * ledgerLimit/flowTick）不进 store——它们是根组件本地交互态，不是共享数据。
 *
 * 依赖方向说明：本文件在 client 根（与 panelLiveTargets.ts 同层），import
 * features/* 的类型（type-only）与嵌入快照（值）——components/panelStore.ts
 * 只提供泛型机制，不感知任何 feature 类型（机制与形状分离）。
 */
import { WORKFLOW_SNAPSHOT } from './workflowGraphData.ts';
import { t } from './i18n.ts';
import type { GraphData } from './features/graph/renderGraph.ts';
import type { StepTraceJson } from './features/stepTrace/renderStepTrace.ts';
import type { SelfCheckJson } from './features/diagnostics/renderDiagnostics.ts';
import type { OrgStatusJson } from './features/org/renderOrgStatus.ts';
import type { FlowStatusJson } from './features/flows/renderFlows.ts';
import type { CycleListJson, CycleStateJson } from './features/cycles/renderCyclesTimeline.ts';
import type { LedgerListJson, LedgerVerifyJson } from './features/ledger/renderLedger.ts';
import type { HitlAuditJson } from './features/hitl/renderHitl.ts';
import type { BudgetJson } from './features/budget/renderBudget.ts';
import type { SkillHealthJson } from './features/skillhealth/renderSkillHealth.ts';
import type { InvocationsJson } from './features/live/renderInvocations.ts';
import type { PanelStore } from './components/panelStore.ts';

/** 快照来源行（toolbar 的 `ANIC · ${line}` 文案状态）。 */
export interface PanelFetchState { source: 'embedded' | 'live'; line: string; }

/** 面板全量数据状态（切片清单与原 useState 一一对应）。 */
export interface PanelState {
  graph: GraphData;
  fetchState: PanelFetchState;
  trace: StepTraceJson | null;
  traceLine: string;
  check: SelfCheckJson | null;
  checkLine: string;
  orgStatus: OrgStatusJson | null;
  flowsStatus: FlowStatusJson | null;
  cycleList: CycleListJson | null;
  cycleState: CycleStateJson | null;
  ledgerList: LedgerListJson | null;
  ledgerVerify: LedgerVerifyJson | null;
  hitlAudit: HitlAuditJson | null;
  budget: BudgetJson | null;
  skillHealth: SkillHealthJson | null;
  invocations: InvocationsJson | null;
  invocationsError: string | null;
  invocationsAnnounce: string;
}

/** 面板 store 别名（订阅薄组件与钩子的公共类型）。 */
export type PanelDataStore = PanelStore<PanelState>;

/**
 * 初始状态（与原 useState 初始值逐字段对齐——回归红线）：
 * 嵌入快照兜底 + t() 初始文案（缺省 zh 与既有中文一致，clientI18n 回归钉）。
 * mount 时调用一次（useRef 惰性初始化），语言探测与原 useState 同时机。
 */
export function createInitialPanelState(): PanelState {
  return {
    graph: { nodes: WORKFLOW_SNAPSHOT.nodes, edges: WORKFLOW_SNAPSHOT.edges },
    fetchState: { source: 'embedded', line: t('panel.sourceEmbedded') },
    trace: null,
    traceLine: t('panel.notLoaded'),
    check: null,
    checkLine: t('panel.notLoaded'),
    orgStatus: null,
    flowsStatus: null,
    cycleList: null,
    cycleState: null,
    ledgerList: null,
    ledgerVerify: null,
    hitlAudit: null,
    budget: null,
    skillHealth: null,
    invocations: null,
    invocationsError: null,
    invocationsAnnounce: '',
  };
}
