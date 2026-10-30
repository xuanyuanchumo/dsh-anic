/**
 * 4s 轮询档的 target 工厂（cycle-82 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * ## 抽出的理由（职责，不只是行数）
 *
 * 面板根组件该回答的是「有哪些分区、什么顺序、门控条件是什么」；
 * 「某分区轮询哪个端点、用什么 guard、失败落到哪个 key」是**数据面知识**，
 * 与 panelLiveTargets（一次性档）、governanceTargets（治理簇）同类。
 * 三者并列后根组件只剩编排——cycle-42 起就在做的同一件事的延续。
 *
 * ## 为什么这些端点共用同一个 4s 节奏
 *
 * 它们是同一叙事的不同视角：节奏（cycle）→ 治理（账本/HITL/预算）→ 健康（技能/债务）
 * → 本体（org/flows）。分开节奏会让面板出现"上半屏是 3 秒前、下半屏是 12 秒前"的
 * 时序错觉，读者无法判断两个数字是否同一时刻。一个节奏 = 一个时间切片。
 *
 * ## 配置（cycle-82）为什么也在这里而不是一次性档
 *
 * 配置是**别人也会改**的事实：技能脚本（init-workflow / autonomy_upgrade）会原地
 * 改写 `config.yml`。一次性拉取会让面板长期显示旧值，用户按保存时覆盖掉脚本刚写的
 * 东西。ETag 条件请求让"配置没变"的每一拍只是一次 304 空响应。
 *
 * ## 形参命名为 `s` 是刻意的
 *
 * `tests/contract/panelDataLegContract.test.ts` 用 `s.<setter>(` 形态判定「该 setter
 * 是否被 target 接线」。改个更好听的名字（`actions`）会让那些 setter 全部被判成
 * 未接线——**假红**，而且红在契约层、原因在命名层，排查成本极高。与本仓既有两个
 * target 工厂（panelLiveTargets / governanceTargets）保持同一形态。
 */
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import type { PanelActions } from './components/panelActions.ts';
import { governanceTargets } from './governanceTargets.ts';
import { configTarget } from './features/config/configTarget.ts';
// cycle-89：自举状态（状态/事实基线/陈旧判据）——4s 档：自举是长事务，
// 一次性拉取会让用户看不到 EVALUATING→GATE_CHECKING 的过程（见 bootstrapTarget 头注）。
import { bootstrapTarget } from './features/bootstrap/bootstrapTarget.ts';
import { ORG_STATUS_URL, FLOWS_STATUS_URL } from './panelLiveTargets.ts';
// cycle-89：归属矩阵端点。
import { FLOW_MATRIX_URL } from './features/flows/flowMatrixTypes.ts';
import { isObjectLike, isFlowStatus } from './features/live/fetchJson.ts';
import type { OrgStatusJson } from './features/org/renderOrgStatus.ts';
import type { FlowStatusJson } from './features/flows/renderFlows.ts';
// cycle-89：流程归属矩阵（join key 消费面）。
import { isFlowMatrix, type FlowMatrixJson } from './features/flows/flowMatrixTypes.ts';
// cycle-90：生命周期指标。
import { isLifecycleMetrics, LIFECYCLE_METRICS_URL, type LifecycleMetricsJson } from './features/flows/lifecycleTypes.ts';
import {
  isCycleList, isCycleState, CYCLE_LIST_URL, CYCLE_STATE_URL,
  type CycleListJson, type CycleStateJson,
} from './features/cycles/renderCyclesTimeline.ts';
import { isBudget, BUDGET_URL, type BudgetJson } from './features/budget/renderBudget.ts';
import { isSkillHealth, SKILL_HEALTH_URL, type SkillHealthJson } from './features/skillhealth/renderSkillHealth.ts';
import { isTechDebtListing, TECH_DEBT_URL, type TechDebtListingJson } from './features/techdebt/renderTechDebt.ts';

/**
 * 构造 4s 档全部 target。
 *
 * 每个端点都带 `onFail`/`onRecover`（cycle-71 T-7117 纪律：失败不得静默降级成
 * 「分区只剩标题」，否则用户分不清「路由挂了」与「确实无数据」）。
 * 失败 key 落在**端点粒度**——同一分区两个端点（cycle list/state、ledger
 * list/verify）各记一条：一个成功 clear 与一个失败 mark 并发时不会互相抹掉，
 * 分区侧由 sectionFailure 聚合。
 *
 * @param s 动作层（写路径唯一门面）
 * @param ledgerLimit 账本翻页深度（「显示更多」抬高后随手动刷新生效）
 */
export function periodicTarget(s: PanelActions, ledgerLimit: number): PanelFetchTarget[] {
  const fail = (id: string) => (f: Parameters<NonNullable<PanelFetchTarget['onFail']>>[0]): void => {
    s.markFetchFailure(id, f);
  };
  const recover = (id: string) => (): void => { s.clearFetchFailure(id); };
  return [
    { url: ORG_STATUS_URL, guard: isObjectLike, apply: (v) => { s.setOrgStatus(v as OrgStatusJson); }, onFail: fail('orgStatus'), onRecover: recover('orgStatus') },
    { url: FLOWS_STATUS_URL, guard: isFlowStatus, apply: (v) => { s.setFlowsStatus(v as FlowStatusJson); }, onFail: fail('flowsStatus'), onRecover: recover('flowsStatus') },
    // cycle-89：归属矩阵（归属率 / 孤儿 / 门禁证据覆盖的量化条数据源）。
    { url: FLOW_MATRIX_URL, guard: isFlowMatrix, apply: (v) => { s.setFlowMatrix(v as FlowMatrixJson); }, onFail: fail('flowMatrix'), onRecover: recover('flowMatrix') },
    // cycle-90：生命周期指标（KM / EWMA / 分位数+Gini 的读数出口）。
    { url: LIFECYCLE_METRICS_URL, guard: isLifecycleMetrics, apply: (v) => { s.setLifecycleMetrics(v as LifecycleMetricsJson); }, onFail: fail('lifecycleMetrics'), onRecover: recover('lifecycleMetrics') },
    // cycle 时间线两端点（宏观节奏条）：list 给序列、state 给「当前推进到哪」。
    { url: CYCLE_LIST_URL, guard: isCycleList, apply: (v) => { s.setCycleList(v as CycleListJson); }, onFail: fail('cycleList'), onRecover: recover('cycleList') },
    { url: CYCLE_STATE_URL, guard: isCycleState, apply: (v) => { s.setCycleState(v as CycleStateJson); }, onFail: fail('cycleState'), onRecover: recover('cycleState') },
    // 治理证据簇三端点（账本条目 + 链校验 + HITL 审计）。
    ...governanceTargets(s, ledgerLimit),
    { url: SKILL_HEALTH_URL, guard: isSkillHealth, apply: (v) => { s.setSkillHealth(v as SkillHealthJson); }, onFail: fail('skillHealth'), onRecover: recover('skillHealth') },
    // tech-debt 队列（技能健康的改进建议语义簇）。
    { url: TECH_DEBT_URL, guard: isTechDebtListing, apply: (v) => { s.setTechDebt(v as TechDebtListingJson); }, onFail: fail('techDebt'), onRecover: recover('techDebt') },
    { url: BUDGET_URL, guard: isBudget, apply: (v) => { s.setBudget(v as BudgetJson); }, onFail: fail('budget'), onRecover: recover('budget') },
    // cycle-82：配置与路径（写侧在 ConfigSection，这里只读）。
    configTarget(
      (v) => { s.setConfig(v); },
      (msg) => { s.failConfig(msg); },
      () => { s.recoverConfig(); },
    ),
    // cycle-89：自举状态（失败落到 endpoint 粒度 key 'bootstrap'，分区聚合显示）。
    bootstrapTarget(
      (v) => { s.setBootstrap(v); },
      fail('bootstrap'),
      recover('bootstrap'),
    ),
  ];
}
