/**
 * 面板分区编排（cycle-95 · 从 `WorkflowGraphPanel.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `WorkflowGraphPanel.ts` 的职责是「外部 store 的创建/接线 + 交互态 + 工具栏/抽屉」。
 * 但它在 cycle-82..95 期间不断追加分区，把「**这一堆分区按什么顺序、带什么门控**」
 * 也一起塞了进去 —— 那是**旅程排序**这件独立的事，不是根组件的状态管理。
 * 拆开后：本文件回答「面板上先看到什么、后看到什么」，
 * 根组件回答「这些数据从哪来、点了会发生什么」。
 *
 * ## 旅程排序的判据（改动这里之前先读）
 *
 * 排序不是审美偏好，是**叙事顺序**：先说"这一轮是什么"，再说"它正在怎么被调用"，
 * 再说"它走到哪了"，再说"它留了什么证据"，最后才是可写面。
 *
 * - **工作区徽标**在**图区之前**：它是"你在看哪一块"的第一层上下文。多项目隔离
 *   在数据层早已存在（载荷守卫 / 在途丢弃 / 分键视图态），此前在视觉层完全不可见
 *   ——用户看着 A 项目的账本却以为是 B 项目的。
 * - 图区 → 实时调用：动态白盒是本面板的主叙事，用户展开第一眼应看到"模型此刻
 *   在怎么调用本插件"。
 * - 周期时间线紧随其后：宏观节奏条，「正在发生的调用」与「循环走到哪了」相邻。
 * - 治理证据簇（账本 / HITL / 预算）相邻呈现：「状态机走到哪」→「裁决留了什么痕、
 *   谁在等人工」→「这些痕占了多少空间」。
 * - **配置分区刻意放最后**：面板主叙事是"读"，配置是"改"；越靠底部越不挡观测面，
 *   且它默认展开，需要时滚到底一次可达。
 *
 * ## 门控布尔来自 prefs 同步解析，不随数据 tick 变化
 *
 * 分区 props 全部引用稳定（store 实例 / 布尔 / useCallback 回调），这样 `memo`
 * 才能真正拦截"2s 调用流 tick 让整棵树重渲"的级联。
 */
import { createElement, type ReactElement, type ReactNode } from 'react';
import type { PanelDataStore } from './panelState.ts';
import {
  GraphSection, LiveInvocationsSection, CyclesSection, StepTraceSection,
  DiagnosticsSection, OrgSection, SkillHealthSection, TechDebtSection, FlowsSection,
  LedgerSection, HitlSection, BudgetSection, ClosureSection, BootstrapSection,
  WorkspaceBadge,
} from './components/panelSections.ts';
// 配置分区不在 panelSections 门面里（它是唯一可写面，独立 import 路径），
// 与 WorkflowGraphPanel 原装配点保持同一来源（路径零变更）。
import { ConfigSection } from './features/config/ConfigSection.ts';
// cycle-110：装配时给每个分区元素打分区 key 标记（SECTION_KEY_PROP）——工作台
// 网格按标记分桶（查表 O(n)），不 import 16 个组件、不数下标；漏配会被
// workbenchGrid 的 unassigned 卡显式暴露（域表漂移必须可见）。
import { SECTION_KEY_PROP } from './workbench/workbenchModel.ts';
import { renderNodeDetail, type NodeDetail } from './features/graph/gateColors.ts';
import type { WorkflowNode } from './workflowGraphData.ts';

/** 门控布尔（来自 prefs 的 `flow.*` 开关；缺省 true＝未配置视为开启）。 */
export interface SectionGates {
  stepTraceOn: boolean;
  diagnosticsOn: boolean;
  flowsViewOn: boolean;
  approvalsOn: boolean;
}

/** 分区编排入参（全部引用稳定 —— 见文件头「门控布尔」节）。 */
export interface PanelSectionsInput {
  store: PanelDataStore;
  gates: SectionGates;
  onNodeClick: (n: WorkflowNode) => void;
  onShowMore: () => void;
  autoRefreshOn: boolean;
  configPanelId: string;
  selectedNode: NodeDetail | null;
  onCloseNodeDetail: () => void;
  /**
   * 当前工作区（cycle-95 · 分键视图态的键源）。
   * undefined = 尚未学到 ⇒ 图区**不记忆**（诚实退化，而不是把 `__unknown__`
   * 当真实分键——两个都未识别的项目会共用一份视图，那正是本功能要消灭的污染）。
   */
  workspace?: string | undefined;
}

/**
 * 产出面板全部分区（不含外层容器与工具栏 —— 那两件仍归根组件）。
 *
 * 返回类型含 `null`：节点详情抽屉在无选中时**不渲染**（而不是渲染一个空壳）——
 * 空壳会占掉布局位并让 AT 读到一个无内容的抽屉。
 *
 * @returns 分区元素数组，可直接展开进 `children` 数组。
 */

/** cycle-110：给分区元素打 key 标记（原 props 全保留；见文件尾 SECTION_KEY_PROP 注释）。 */
function keyed(el: ReactElement, sectionKey: string): ReactElement {
  const props = (el.props ?? {}) as Record<string, unknown>;
  const children = props.children as ReactNode;
  return createElement(el.type, { ...props, [SECTION_KEY_PROP]: sectionKey }, children);
}

export function renderPanelSections(input: PanelSectionsInput): Array<ReactElement | null> {
  const { store, gates, onNodeClick, onShowMore, autoRefreshOn, configPanelId, selectedNode, onCloseNodeDetail, workspace } = input;
  return [
    // 工作区标识（"你在看哪一块"的第一层上下文）—— 必须排在图区之前。
    createElement(WorkspaceBadge, { store, key: 'workspace-badge' }),
    // 图区：订阅 graph+trace 两切片（verdicts 由 trace 派生）。
    // `workspace` 只喂分键视图态；缺省 undefined ⇒ 图区不记忆缩放/筛选。
    keyed(createElement(GraphSection, { store, onNodeClick, key: 'graph', ...(workspace === undefined ? {} : { workspace }) }), 'graph'),
    // 实时调用流：动态白盒主叙事。
    keyed(createElement(LiveInvocationsSection, { store, autoRefreshOn, key: 'live' }), 'live'),
    // 周期时间线：宏观节奏条。
    keyed(createElement(CyclesSection, { store, key: 'cycles' }), 'cycles'),
    keyed(createElement(StepTraceSection, { store, enabled: gates.stepTraceOn, key: 'steptrace' }), 'stepTrace'),
    keyed(createElement(DiagnosticsSection, { store, enabled: gates.diagnosticsOn, key: 'diagnostics' }), 'diagnostics'),
    keyed(createElement(OrgSection, { store, key: 'org' }), 'org'),
    keyed(createElement(SkillHealthSection, { store, key: 'skillhealth' }), 'skillHealth'),
    // 技术债队列：技能健康之后呈现「欠了什么债」。
    keyed(createElement(TechDebtSection, { store, key: 'techdebt' }), 'techDebt'),
    keyed(createElement(FlowsSection, { store, enabled: gates.flowsViewOn, key: 'flows' }), 'flows'),
    keyed(createElement(LedgerSection, { store, onShowMore, key: 'ledger' }), 'ledger'),
    keyed(createElement(HitlSection, { store, enabled: gates.approvalsOn, key: 'hitl' }), 'hitl'),
    keyed(createElement(BudgetSection, { store, key: 'budget' }), 'budget'),
    keyed(createElement(ClosureSection, { store, key: 'closure' }), 'closure'),
    keyed(createElement(BootstrapSection, { store, key: 'bootstrap' }), 'bootstrap'),
    // 配置（唯一可写面）刻意最后：观测面先于可写面。
    keyed(createElement(ConfigSection, { store, panelId: configPanelId, key: 'config' }), 'config'),
    renderNodeDetail(selectedNode, selectedNode === null
      ? undefined
      : { detailId: `${configPanelId}-node-detail`, onClose: onCloseNodeDetail }),
  ];
}
