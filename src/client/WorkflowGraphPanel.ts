/**
 * ANIC 工作流图 SVG 面板（M0-① 图区 + M1 全功能面分区）。
 *
 * 纯渲染已提取至 features/graph/renderGraph.ts（12 §3.1 特性模块制）。
 * 本文件只含 React 组件：状态 + 并行 fetch + 分区编排。
 *
 * 数据热更新（三层，全部安全降级）：
 *   1. 嵌入快照（构建期生成，永远可用 —— 多代宿主安全底线）；
 *   2. live 路由 GET /anic/api/workflow-snapshot（宿主注册；挂载时与点「刷新」时拉取）；
 *   3. 路由缺失/404/5xx/无 fetch → 回退嵌入快照，底行如实显示来源。
 *
 * M1 分区（每区独立 feature 模块，开关门控走三层合并的 user 层）：
 * 图区 renderGraph / 步骤流程 renderStepTrace / 诊断 renderDiagnostics /
 * ⚙ 开关抽屉 renderPrefsDrawer / org 全景 renderOrgStatus。
 * 主题 hooks 在 components/panelTheme.ts（cycle-18 T3 拆分）。
 */
import { createElement, useCallback, useRef, useState, type ReactElement } from 'react';
import { WORKFLOW_SNAPSHOT } from './workflowGraphData.ts';
import { renderGraph, buildVerdicts, type GraphData } from './features/graph/renderGraph.ts';
import { renderStepTrace, type StepTraceJson } from './features/stepTrace/renderStepTrace.ts';
import { renderDiagnostics, type SelfCheckJson } from './features/diagnostics/renderDiagnostics.ts';
import { renderPrefsDrawer, readPrefsRaw, PREFS_PANEL_ID_BASE } from './features/prefs/prefsDrawer.ts';
import { renderOrgStatus, type OrgStatusJson } from './features/org/renderOrgStatus.ts';
import { renderFlows, type FlowStatusJson } from './features/flows/renderFlows.ts';
import { renderInvocations } from './features/live/renderInvocations.ts';
// cycle-41（T3 拆分）：轮询钩子独立成文件（renderInvocations.ts 超行限制）。
import { useInvocations } from './features/live/useInvocations.ts';
import { usePanelFetch } from './components/usePanelFetch.ts';
import { useTokenCss, useShellTheme } from './components/panelTheme.ts';
import { panelLiveTargets, ORG_STATUS_URL, FLOWS_STATUS_URL } from './panelLiveTargets.ts';
import { renderCyclesTimeline, isCycleList, isCycleState, CYCLE_LIST_URL, CYCLE_STATE_URL, type CycleListJson, type CycleStateJson } from './features/cycles/renderCyclesTimeline.ts';
import { renderLedger, type LedgerListJson, type LedgerVerifyJson } from './features/ledger/renderLedger.ts';
import { renderHitl, type HitlAuditJson } from './features/hitl/renderHitl.ts';
import { governanceTargets } from './governanceTargets.ts';
// cycle-24（P3 治理补完）：预算视图（.cycles/ 磁盘预算白盒）。
import { renderBudget, isBudget, BUDGET_URL, type BudgetJson } from './features/budget/renderBudget.ts';
// cycle-20（P2/P3 收口）：自主级仪表带 + 技能健康面板。
import { renderAutonomyGauge } from './features/autonomy/renderAutonomyGauge.ts';
import { renderSkillHealth, isSkillHealth, SKILL_HEALTH_URL, type SkillHealthJson } from './features/skillhealth/renderSkillHealth.ts';
import { isObjectLike, isFlowStatus } from './features/live/fetchJson.ts';
import { useSelfInit } from './features/selfinit/useSelfInit.ts';
import { renderSectionWrap, renderSectionDisabled, renderFoldableSection } from './components/sectionShell.ts';
import { usePanelInstanceSeq, idOf } from './components/sectionIds.ts';
import { resolveFlows, parseRawPrefs } from '../shared/flows.ts';
import { renderNodeDetail, type NodeDetail } from './features/graph/gateColors.ts';
import { THEME_ATTRIBUTE, token } from '../shared/tokens.ts';
import { t } from './i18n.ts';

interface FetchState { source: 'embedded' | 'live'; line: string; }

/**
 * 面板组件：挂载即并行拉 live（snapshot/step-trace/self-check/org-status；各自独立降级）。
 * 「刷新」手动重拉；「⚙」展开开关抽屉。in-flight 守卫防抖；无 fetch（smoke 沙盒）
 * → 保持嵌入快照。分区按 user 层开关门控（INV-30：关闭形态在 UI 如实呈现）。
 */
export function WorkflowGraphPanel(): ReactElement {
  const [data, setData] = useState<GraphData>({ nodes: WORKFLOW_SNAPSHOT.nodes, edges: WORKFLOW_SNAPSHOT.edges });
  // 初始行文案经 t()：缺省 zh 与既有中文一致（clientI18n 回归红线）。
  const [state, setState] = useState<FetchState>({ source: 'embedded', line: t('panel.sourceEmbedded') });
  const [trace, setTrace] = useState<StepTraceJson | null>(null);
  const [traceLine, setTraceLine] = useState<string>(t('panel.notLoaded'));
  const [check, setCheck] = useState<SelfCheckJson | null>(null);
  const [checkLine, setCheckLine] = useState<string>(t('panel.notLoaded'));
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [flowTick, setFlowTick] = useState(0);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [orgStatus, setOrgStatus] = useState<OrgStatusJson | null>(null);
  // D10 宿主域接线（cycle-9）：流程状态机面板的数据源（null = 未拉取，不伪造空态）
  const [flowsStatus, setFlowsStatus] = useState<FlowStatusJson | null>(null);
  // B1：cycle 时间线数据源（list 拉不到 → 整区不渲染；state 只服务当前格摘要）。
  const [cycleList, setCycleList] = useState<CycleListJson | null>(null);
  const [cycleState, setCycleState] = useState<CycleStateJson | null>(null);
  // B2（cycle-18）：账本事件流 + HITL 审计队列数据源（治理证据簇，4s 档）。
  const [ledgerList, setLedgerList] = useState<LedgerListJson | null>(null);
  const [ledgerVerify, setLedgerVerify] = useState<LedgerVerifyJson | null>(null);
  const [hitlAudit, setHitlAudit] = useState<HitlAuditJson | null>(null);
  // cycle-24（P3 账本分页）：翻页深度（「显示更多」抬 limit 并触发重拉）。
  const [ledgerLimit, setLedgerLimit] = useState(12);
  // cycle-24（P3 治理预算）：.cycles/ 磁盘预算数据源（治理证据簇同 4s 档）。
  const [budget, setBudget] = useState<BudgetJson | null>(null);
  // cycle-20（P3）：技能健康面板数据源（FlowTracker 调用历史的分析面，4s 档）。
  const [skillHealth, setSkillHealth] = useState<SkillHealthJson | null>(null);
  // B5.1：实例唯一抽屉 id（同一契约的两半——aria-controls 与容器 id——同源）。
  // 机制见 components/sectionIds.ts（模块计数 + useRef 惰性初始化，不用 useId）。
  const prefsPanelId = idOf(PREFS_PANEL_ID_BASE, usePanelInstanceSeq());
  const [reloadKey, setReloadKey] = useState(0);
  // P2（桌面多会话错位）：面板从首个成功快照响应学得工作区根（X-ANIC-Workspace
  // 响应头），后续所有请求回带 X-ANIC-Workspace 头，让服务端在多会话宿主上
  // 解析到「本面板的工作区」而不是 sessions.list() 首条。服务端只把它当
  // 选择器（必须命中宿主已知工作区集或含 .cycles 才采信），不是任意路径入口。
  const workspaceRef = useRef<string | null>(null);
  const wsHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (workspaceRef.current) h['X-ANIC-Workspace'] = workspaceRef.current;
    return h;
  };

  // P0-2：自举四态反馈（running 时禁用防双击；失败保留错误信息与重试语义）。
  const { phase: selfInitPhase, note: selfInitNote, onSelfInit } = useSelfInit();

  // B5.2：关闭节点详情抽屉。焦点还原给图区 svg——不引 focus-trap，关闭后键盘
  // 用户落回可感知的停靠点（roving tabindex 容器，方向键可继续浏览）。
  const closeNodeDetail = useCallback((): void => {
    setSelectedNode(null);
    try {
      (document.querySelector('svg[data-anic-graph]') as { focus?: () => void } | null)?.focus?.();
    } catch { /* 无 DOM（测试/沙盒）静默 */ }
  }, []);


  // 数据热更新（B4）：一次性拉取的 targets 与降级文案抽至 panelLiveTargets.ts
  //（T3 行数纪律；快照学头副作用经 setters 接口回流 workspaceRef）。
  usePanelFetch(panelLiveTargets({
    setData,
    setState,
    setTrace, setTraceLine,
    setCheck, setCheckLine,
    learnWorkspace: (root) => { workspaceRef.current = root; },
    workspaceKnown: () => workspaceRef.current,
  }), 0, reloadKey, wsHeaders);

  const resolved = resolveFlows({ user: parseRawPrefs(readPrefsRaw()).prefs.flows });
  const stepTraceOn = resolved.flows['flow.stepTrace']?.enabled ?? true;
  const diagnosticsOn = resolved.flows['flow.diagnostics']?.enabled ?? true;
  const flowsViewOn = resolved.flows['flow.flowsView']?.enabled ?? true;
  // B2：HITL 队列分区门控（flow.approvals 首次接线真实 UI——声明与实现断层的
  // 收口；关闭形态契约「队列只读展示 + 指引改走技能 CLI」见 flows.ts:51）。
  const approvalsOn = resolved.flows['flow.approvals']?.enabled ?? true;
  // P1-7：autoRefresh 开关接线——关闭即停轮询（保留首轮/手动刷新数据，
  // 降级契约「回退手动刷新」；数据行的 generatedAt 让陈旧性可观测）。
  const autoRefreshOn = resolved.flows['flow.autoRefresh']?.enabled ?? true;
  // org/flows 分区轮询（P2 真机修复）：autoRefresh 开 → 4s；关 → 仅首拍。
  // B4：轮询/暂停/降级语义统一至 components/usePanelFetch（静默降级形态——
  // guard 不过/失败 → 不 apply，分区不渲染，不伪造空态）。
  // B1：cycle 时间线两个端点（list/state）并进同一 4s 档（旅程排序：宏观节奏条）。
  usePanelFetch([
    { url: ORG_STATUS_URL, guard: isObjectLike, apply: (v) => setOrgStatus(v as OrgStatusJson) },
    { url: FLOWS_STATUS_URL, guard: isFlowStatus, apply: (v) => setFlowsStatus(v as FlowStatusJson) },
    { url: CYCLE_LIST_URL, guard: isCycleList, apply: (v) => setCycleList(v as CycleListJson) },
    { url: CYCLE_STATE_URL, guard: isCycleState, apply: (v) => setCycleState(v as CycleStateJson) },
    // B2（cycle-18）：治理证据簇三端点并进同一 4s 档（账本条目 + 链校验 + HITL 审计）。
    ...governanceTargets({ setLedgerList, setLedgerVerify, setHitlAudit }, ledgerLimit),
    // cycle-24（P3）：技能健康 + 治理预算并入 4s 档（健康/证据观测同节奏）。
    { url: SKILL_HEALTH_URL, guard: isSkillHealth, apply: (v) => setSkillHealth(v as SkillHealthJson) },
    { url: BUDGET_URL, guard: isBudget, apply: (v) => setBudget(v as BudgetJson) },
  ], autoRefreshOn ? 4000 : 0, reloadKey, wsHeaders);
  useTokenCss();
  const theme = useShellTheme();
  // 实时调用流（cycle-97 动态白盒）：与静态分区并列，展示"正在发生的调用"。
  // 刷新按钮的 reloadKey 同时作为手动刷新信号（autoRefresh 关闭时的唯一更新途径）。
  // cycle-41：announce（Top4a 聚合播报）随 data 一起从钩子回流。
  const { data: invocations, pollError: invocationsError, announce: invocationsAnnounce } = useInvocations(autoRefreshOn ? 2000 : 0, reloadKey, wsHeaders);

  return createElement(
    'div',
    // overflow 必须是 visible、且**不能**给 height:100%：宿主把本面板挂在
    // [data-conversation-scroll] 里，而挂载点的高度是 auto。给它 overflow:auto 会让它
    // 自己变成"最近的滚动容器"却永远不滚动（内容撑高它，它再撑高父级，滚动实际发生在
    // 宿主的滚动体上）——于是 position:sticky 的工具栏粘在一个不滚动的盒子上，
    // 用户往下滚时工具栏跟着滚出屏幕，等于没有粘性。实测：滚动宿主 0→500→2000→6000px
    // 时工具栏 y 依次 76→-424→-1924→-5924（完全跟走）。改回 visible 后 sticky 才绑到
    // 真正滚动的祖先，同一组滚动位置 y 恒为 76。
    //
    // data-anic-theme：面板主题的唯一开关，由 useShellTheme() 写宿主解析后的主题
    // （不是 OS 偏好）。令牌块里 `[data-anic-theme='dark']` 依赖它选暗色语义层。
    { 'data-anic-workflow': 'canvas', [THEME_ATTRIBUTE]: theme, style: { width: '100%', overflow: 'visible', minHeight: 420, background: token('anic-surface') } },
    createElement(
      'div',
      // role="toolbar"：把三个动作声明为一组，AT 才会播报"工具栏"边界；
      // 容器本身**不可聚焦**（工具栏是容器不是控件），焦点留在按钮上。
      { 'data-anic-toolbar': 'true', role: 'toolbar', 'aria-label': t('panel.toolbar'), style: { position: 'sticky', top: 0, zIndex: 2, display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: token('anic-surface'), borderBottom: `1px solid ${token('anic-border')}`, fontSize: 12, color: token('anic-text') } },
      // role="status"：拉取结果（成功/失败/降级）是异步反馈，无 live region 时
      // 屏幕阅读器完全感知不到——刷新按钮点了"没反应"。
      createElement('span', { role: 'status', 'aria-live': 'polite' }, `ANIC · ${state.line}`),
      createElement('button', { type: 'button', 'data-anic-refresh': 'true', onClick: () => { setReloadKey((k) => k + 1); }, className: 'anic-btn' }, t('panel.refresh')),
      // 抽屉开关是 disclosure：aria-expanded 报告开合，aria-controls 指向被控容器。
      createElement('button', { type: 'button', 'data-anic-prefs-toggle': 'true', 'aria-expanded': prefsOpen, 'aria-controls': prefsPanelId, onClick: () => { setPrefsOpen((v) => !v); }, className: 'anic-btn' }, t('panel.prefsToggle')),
      // P0-2：自举按钮四态反馈 —— 执行中禁用 + aria-live 播报结果；失败时
      // 标签改为「重试」传达可重试语义（同一按钮，不加第二个控件）。
      createElement('button', {
        type: 'button', 'data-anic-self-init': 'true', 'data-anic-self-init-phase': selfInitPhase,
        disabled: selfInitPhase === 'running',
        onClick: () => { void onSelfInit(); },
        className: 'anic-btn',
        style: { opacity: selfInitPhase === 'running' ? 0.6 : 1 },
        title: t('panel.selfInitTitle'),
      }, selfInitPhase === 'running' ? t('panel.selfInitRunning') : selfInitPhase === 'failed' ? t('panel.selfInitRetry') : t('panel.selfInit')),
      // 自举结果反馈：与拉取状态同一 aria-live 约定（异步结果必须可感知）。
      selfInitPhase === 'ok' || selfInitPhase === 'failed'
        ? createElement('span', { role: 'status', 'aria-live': 'polite', 'data-anic-self-init-note': selfInitPhase, style: { fontSize: 11, color: selfInitPhase === 'failed' ? token('anic-fail') : token('anic-pass') } }, selfInitNote)
        : null,
    ),
    prefsOpen ? renderPrefsDrawer({}, () => { setFlowTick((k) => k + 1); }, prefsPanelId) : null,
    renderGraph(data, buildVerdicts(trace), (n) => { setSelectedNode({ id: n.id, label: n.label, type: n.type, result: n.result, detail: n.detail, testReport: n.testReport }); }),
    // 实时调用分区紧跟图区：动态白盒是本面板的主叙事（m02733），
    // 用户展开面板第一眼应看到"模型此刻在怎么调用本插件"。
    // cycle-41（用户目标 A）：默认只展开「最近一次已完成调用」与「运行中调用」
    // 所在组——旧轮次默认折叠收纳（组内摘要仍有计数，点开即全文）。
    renderInvocations(invocations, invocationsError, autoRefreshOn, invocationsAnnounce),
    // Cycle 时间线（B1 · P0 缺口）：宏观节奏条，旅程排序在实时调用之后、
    // 静态投影之前——「正在发生的调用」与「循环走到哪了」相邻呈现。
    // cycle-41（Top4b）：次级分区套可折叠壳（默认展开；折叠是用户主动收纳）。
    renderFoldableSection({ id: 'cycles', title: t('fold.cycles'), children: renderCyclesTimeline({ list: cycleList, state: cycleState }) }),
    renderFoldableSection({ id: 'stepTrace', title: t('fold.stepTrace'), children: stepTraceOn
      ? renderSectionWrap({
          anchorKey: 'data-anic-steptrace-wrap',
          dataLine: t('panel.traceDataLine', { line: traceLine }),
          body: trace === null ? null : renderStepTrace(trace),
          unavailableText: t('panel.traceUnavailable'),
        })
      : renderSectionDisabled({ anchorKey: 'data-anic-steptrace-disabled', text: t('panel.traceDisabled') }) }),
    renderFoldableSection({ id: 'diagnostics', title: t('fold.diagnostics'), children: diagnosticsOn
      ? renderSectionWrap({
          anchorKey: 'data-anic-diagnostics-wrap',
          dataLine: t('panel.diagDataLine', { line: checkLine }),
          body: check === null ? null : renderDiagnostics(check),
          unavailableText: t('panel.diagUnavailable'),
        })
      : renderSectionDisabled({ anchorKey: 'data-anic-diagnostics-disabled', text: t('panel.diagDisabled') }) }),
    // cycle-20（P2）：自主级仪表带——org 全景的"一眼可读"形态，放 org 文本
    // 分区前（仪表带是总览，文本行是明细；两区消费同一 orgStatus 数据）。
    renderFoldableSection({ id: 'org', title: t('fold.org'), children: [
      orgStatus ? createElement('div', { 'data-anic-gauge-wrap': 'true', key: 'gauge' }, renderAutonomyGauge(orgStatus)) : null,
      orgStatus ? createElement('div', { 'data-anic-org-wrap': 'true', key: 'org' }, renderOrgStatus(orgStatus)) : null,
    ] }),
    // cycle-20（P3）：技能健康面板——FlowTracker 调用历史的健康分析面，
    // 旅程排序在 org 全景后、流程状态机前（「组织状态」→「技能健康」→「流程白盒」）。
    renderFoldableSection({ id: 'skillHealth', title: t('fold.skillHealth'), children: renderSkillHealth(skillHealth) }),
    // 流程状态机分区（cycle-9 · D10）：FlowRegistry 全景白盒。关闭形态契约与
    // stepTrace 同款 —— 分区隐藏 + 一行如实说明（INV-30），数据路由不受影响。
    renderFoldableSection({ id: 'flows', title: t('fold.flows'), children: flowsViewOn
      ? renderFlows(flowsStatus)
      : renderSectionDisabled({ anchorKey: 'data-anic-flowsview-disabled', text: t('flows.disabled') }) }),
    // 账本事件流 + HITL 审计队列（B2 · cycle-18）：治理证据簇，旅程排序紧跟
    // 流程状态机——「状态机走到哪」与「裁决留了什么痕、谁在等人工」相邻呈现。
    // cycle-24（P3 分页）：还有未展示条目时渲染「显示更多」——抬 ledgerLimit
    // 并 bump reloadKey（重拉即新 limit 生效；语义=带新翻页深度的手动刷新）。
    renderFoldableSection({ id: 'ledger', title: t('fold.ledger'), children: renderLedger(ledgerList, ledgerVerify, ledgerList !== null && ledgerList.entries.length < ledgerList.total
      ? { hasMore: true, onShowMore: () => { setLedgerLimit((l) => l + 24); setReloadKey((k) => k + 1); } }
      : undefined) }),
    renderFoldableSection({ id: 'hitl', title: t('fold.hitl'), children: approvalsOn
      ? renderHitl(hitlAudit)
      : renderSectionDisabled({ anchorKey: 'data-anic-approvals-disabled', text: t('hitl.disabled') }) }),
    // cycle-24（P3 治理预算）：预算余量条 + 大文件榜——治理证据簇收尾
    //（「留了什么痕」之后呈现「这些痕占了多少空间」）。
    renderFoldableSection({ id: 'budget', title: t('fold.budget'), children: renderBudget(budget) }),
    renderNodeDetail(selectedNode, selectedNode === null ? undefined : { detailId: `${prefsPanelId}-node-detail`, onClose: closeNodeDetail }),
  );
}
