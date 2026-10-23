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
import type { TechDebtListingJson } from './features/techdebt/renderTechDebt.ts';
// cycle-72 T-7207：闭环体检（注册↔生产↔消费 三态矩阵）——— 一次性拉取切片
// （全仓扫描 ~7s，刻意不进 4s 轮询档；见 panelLiveTargets 的 closure target 注释）。
import type { ClosureView } from './features/closure/renderClosure.ts';
import type { InvocationsJson } from './features/live/renderInvocations.ts';
import type { PanelStore } from './components/panelStore.ts';

/**
 * 快照来源两切片（cycle-45 T-4502a 扁平化）。
 *
 * 曾是唯一嵌套切片 `fetchState: { source, line }`：写侧每次新建整个对象 →
 * 顶层 Object.is 恒不等，「全等补丁不通知」对它失效（同 line 重置也通知，
 * 靠 uSES 字符串 selector 兜底才不重渲）。拆为两个顶层切片后：source 不变
 * 只写 line → line 切片订阅者重渲、source 消费者零打扰；两值都同 → 零通知。
 */
export type FetchSource = 'embedded' | 'live';

/** 面板全量数据状态（切片清单与原 useState 一一对应）。 */
export interface PanelState {
  graph: GraphData;
  /** 快照来源（embedded=构建期嵌入兜底 / live=路由拉取成功）。 */
  fetchSource: FetchSource;
  /** 快照来源行文案（toolbar 的 `ANIC · ${line}`）。 */
  fetchLine: string;
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
  /** tech-debt 队列（cycle-54 T-5401——4s 档治理证据簇扩展）。 */
  techDebt: TechDebtListingJson | null;
  /** 闭环体检视图（未拉取 / 路由缺失 / 扫描失败 → null，分区如实说明）。 */
  closure: ClosureView | null;
  invocations: InvocationsJson | null;
  invocationsError: string | null;
  invocationsAnnounce: string;
  /**
   * 分区失败记录（cycle-71 T-7117）——id → 分类后的失败文案。
   *
   * 为什么是**单切片按 id 取值**而非每端点一切片：`usePanelSlice` 用 uSES
   * 对**选中值**做 Object.is——即使本对象换引用触发全场通知，某分区选中的
   * 仍是同一字符串（primitive），`Object.is` 相等 → 该分区**不重渲**。
   * 「通知扇出但渲染隔离」自动成立（详见 components/sectionFailure.ts 头注）。
   *
   * 写侧纪律：内容相同**不得**产生新对象（否则每 tick 都通知全场）。
   */
  failures: Record<string, string>;
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
    fetchSource: 'embedded',
    fetchLine: t('panel.sourceEmbedded'),
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
    techDebt: null,
    closure: null,
    invocations: null,
    invocationsError: null,
    invocationsAnnounce: '',
    failures: {},
  };
}
