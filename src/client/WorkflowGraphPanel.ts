/**
 * ANIC 工作流图 SVG 面板（M0-① 图区 + M1 全功能面分区）。
 *
 * 纯渲染已提取至 features/graph/renderGraph.ts（12 §3.1 特性模块制）；
 * 分区订阅薄组件在 components/panelSections.ts（cycle-42 Top2 拆分）。
 * 本文件只剩：外部 store 的创建/接线 + 交互态 + 工具栏/抽屉 + 编排。
 *
 * cycle-42（Top2 债务收口）：数据面全部搬入 panelState 外部 store，各分区按
 * 切片订阅（2s/4s tick 重渲收敛到对应分区；详见 components/panelStore.ts 头注）。
 *
 * 数据热更新（三层，全部安全降级）：
 *   1. 嵌入快照（构建期生成，永远可用 —— 多代宿主安全底线）；
 *   2. live 路由 GET /anic/api/workflow-snapshot（宿主注册；挂载时与点「刷新」时拉取）；
 *   3. 路由缺失/404/5xx/无 fetch → 回退嵌入快照，底行如实显示来源。
 *
 * 主题 hooks 在 components/panelTheme.ts（cycle-18 T3 拆分）。
 *
 * cycle-110（工作台重构）：16 分区的纵向长卷 → 六域卡片网格 + sticky 域导航。
 * 「功能不清晰」的根因是信息架构缺失（无分组/无导航/健康信号藏在折叠内部），
 * 不是数据缺失——故本轮只动呈现层：域表在 workbench/workbenchModel.ts，
 * 状态分类在 workbenchStatus.ts，网格/导航/CSS 在 workbench/ 与 shared/workbenchCss。
 */
import { createElement, useCallback, useRef, useState, type ReactElement } from 'react';
import { createPanelStore } from './components/panelStore.ts';
import { bindPanelActions } from './components/panelActions.ts';
import { createInitialPanelState, type PanelDataStore } from './panelState.ts';
import { GraphSection, LiveInvocationsSection, CyclesSection, StepTraceSection, DiagnosticsSection, OrgSection, SkillHealthSection, TechDebtSection, FlowsSection, LedgerSection, HitlSection, BudgetSection, ToolbarStatusLine, BootstrapSection, WorkspaceBadge } from './components/panelSections.ts';
// cycle-72 T-7207：闭环体检分区（注册↔生产↔消费 三态矩阵白盒面）+ 其数据腿 target。
import { ClosureSection } from './features/closure/ClosureSection.ts';
import { closureTarget } from './features/closure/closureTarget.ts';
// cycle-82：配置与路径分区（唯一可写面）+ 其 4s 档数据腿。
import { ConfigSection, CONFIG_PANEL_ID } from './features/config/ConfigSection.ts';
// cycle-95：分区编排（旅程排序）已拆出，本文件只保留编排的**调用**（守 T3 ≤250 行）。
// cycle-110：呈现层重构为工作台（六域卡片网格 + 域导航 + 域健康状态点）。
// 数据管线（store / 轮询 / 隔离守卫）、分区组件、门控与锚点**零改动**——
// renderWorkbench 内部仍调 renderPanelSections（同参透传），只重组呈现序。
import { renderWorkbench } from './workbench/workbenchGrid.ts';
import { configTarget } from './features/config/configTarget.ts';
import { renderPrefsDrawer, readPrefsRaw, PREFS_PANEL_ID_BASE } from './features/prefs/prefsDrawer.ts';
import { useInvocations } from './features/live/useInvocations.ts';
import { usePanelFetch, type PanelFetchOptions } from './components/usePanelFetch.ts';
import { useTokenCss, useShellTheme } from './components/panelTheme.ts';
import { panelLiveTargets } from './panelLiveTargets.ts';
// cycle-82：4s 档全部端点（数据面知识）搬出根组件，见该文件头注。
import { periodicTarget } from './panelPeriodicTarget.ts';
import { useSelfInit } from './features/selfinit/useSelfInit.ts';
import { usePanelInstanceSeq, idOf } from './components/sectionIds.ts';
import { resolveFlows, parseRawPrefs } from '../shared/flows.ts';
import { renderNodeDetail, type NodeDetail } from './features/graph/gateColors.ts';
import { THEME_ATTRIBUTE, token } from '../shared/tokens.ts'; // 主题属性 + 令牌
import type { WorkflowNode } from './workflowGraphData.ts';
import { t } from './i18n.ts';

/**
 * 面板组件：挂载即并行拉 live（snapshot/step-trace/self-check/org-status；各自独立降级）。
 * 「刷新」手动重拉；「⚙」展开开关抽屉。in-flight 守卫防抖；无 fetch（smoke 沙盒）→ 保持嵌入快照。分区按 user 层开关门控（INV-30：关闭形态在 UI 如实呈现）。
 */
export function WorkflowGraphPanel(): ReactElement {
  // cycle-42（Top2）：store useRef 惰性初始化（createInitialPanelState 只在首渲
  // 求值一次，语言探测时机与原 useState 一致）。store 引用恒定 → 分区 props
  // 引用恒定 → memo 拦截根组件 UI 态变化向分区的级联重渲。
  const storeRef = useRef<PanelDataStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPanelStore(createInitialPanelState());
  const store = storeRef.current;

  // UI 态（本地交互，不进 store）：开关抽屉 / 偏好变更 tick / 节点详情 /
  // 手动刷新信号 / 账本翻页深度。flowTick 值不消费（setFlowTick 只负责
  // bump 重渲——每次渲染都同步重读 prefs，见 resolveFlows）。
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [, setFlowTick] = useState(0);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [ledgerLimit, setLedgerLimit] = useState(12);
  // B5.1：实例唯一抽屉 id（同一契约的两半——aria-controls 与容器 id——同源）。
  // 机制见 components/sectionIds.ts（模块计数 + useRef 惰性初始化，不用 useId）。
  const prefsPanelId = idOf(PREFS_PANEL_ID_BASE, usePanelInstanceSeq());
  // cycle-82：配置分区的实例唯一容器 id（同一页面挂两个面板时 id 不撞）。
  // 与 prefsPanelId 用同一序号来源（sectionIds 的模块计数），不另建计数器。
  const configPanelId = idOf(CONFIG_PANEL_ID, usePanelInstanceSeq());
  // P2（桌面多会话错位）：面板从首个成功快照响应学得工作区根（X-ANIC-Workspace
  // 响应头），后续请求回带该头，让服务端解析到「本面板的工作区」而不是
  // sessions.list() 首条。服务端只把它当选择器（必须命中宿主已知工作区集或
  // 含 .cycles 才采信），不是任意路径入口。
  const workspaceRef = useRef<string | null>(null);
  // cycle-99（工作区隔离）：所属会话 id——从 document 锚点读（integration 渲染
  // 时写入），随每个请求带 `X-ANIC-Session` 头；服务端按 sessions 条目 id 精确
  // 映射工作区（多会话并开时唯一无歧义的归属通道；头缺失回落既有链）。
  const sessionRef = useRef<string | null>(null);
  const sessionOfEnv = useCallback((): string | null => {
    if (sessionRef.current !== null) return sessionRef.current;
    try {
      const v = document.body.dataset.anicSessionId;
      if (typeof v === 'string' && v !== '') {
        sessionRef.current = v;
        return v;
      }
    } catch { /* 无 DOM（测试/沙盒）→ 无会话锚 */ }
    return null;
  }, []);
  // cycle-89：工作区世代号 —— 工作区**真的换了**才推进（`reloadKey` 变化不算）。
  const workspaceEpochRef = useRef<string | null>(null);
  const wsHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (workspaceRef.current) h['X-ANIC-Workspace'] = workspaceRef.current;
    // cycle-99：会话锚——服务端按 sessionId 精确映射工作区（头 > 查询 > sessionId > …）。
    const sid = sessionOfEnv();
    if (sid) h['X-ANIC-Session'] = sid;
    return h;
  }, [sessionOfEnv]);
  // 隔离选项（cycle-89）：载荷守卫 + 在途丢弃。
  const isolationOptions = useCallback((): PanelFetchOptions => ({
    expectedWorkspace: workspaceRef.current,
    shouldAdvanceEpoch: (): boolean => {
      const current = workspaceRef.current;
      const seen = workspaceEpochRef.current;
      if (current === null || seen === null) {
        if (current !== null && seen === null) workspaceEpochRef.current = current;
        return false;
      }
      if (current === seen) return false;
      workspaceEpochRef.current = current;
      return true;
    },
  }), []);

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
  //（快照学头副作用经 setters 接口回流 workspaceRef）。
  // cycle-46（T-4601 写侧收口）：写路径全部走 bindPanelActions 动作层；
  // learnWorkspace/workspaceKnown 两 ref 通道保留在调用点（非 store 写）。
  // cycle-95：`learnWorkspace` 除写 ref 外**同时**镜像进 state —— ref 是给
  // 「下一次请求该带哪个头」用的（时序要求：必须立即可读，不能等重渲），
  // 而图区分键视图态需要的是一个**可触发重渲的值**（ref 变化不重渲，
  // 所以只传 ref.current 会让分键记忆永远停在 undefined ⇒ 功能看似接好实际不生效）。
  // 两者并存：ref 保时序，state 保可见性。
  const [learnedWorkspace, setLearnedWorkspace] = useState<string | null>(null);
  usePanelFetch([...panelLiveTargets({
    setData: bindPanelActions(store).setGraph,
    setFetchLine: bindPanelActions(store).setFetchLine,
    setTrace: bindPanelActions(store).setTrace,
    setCheck: bindPanelActions(store).setCheck,
    learnWorkspace: (root) => {
      workspaceRef.current = root;
      setLearnedWorkspace(root);
    },
    workspaceKnown: () => workspaceRef.current,
  }), ...closureTarget(bindPanelActions(store))], 0, reloadKey, wsHeaders, isolationOptions());

  const resolved = resolveFlows({ user: parseRawPrefs(readPrefsRaw()).prefs.flows });
  const stepTraceOn = resolved.flows['flow.stepTrace']?.enabled ?? true;
  const diagnosticsOn = resolved.flows['flow.diagnostics']?.enabled ?? true;
  const flowsViewOn = resolved.flows['flow.flowsView']?.enabled ?? true;
  // B2：HITL 队列分区门控（flow.approvals 首次接线真实 UI——声明与实现断层的
  // 收口；关闭形态契约「队列只读展示 + 指引改走技能 CLI」见 flows.ts:51）。
  const approvalsOn = resolved.flows['flow.approvals']?.enabled ?? true;
  // P1-7：autoRefresh 开关接线——关闭即停轮询（保留首轮/手动刷新数据）。
  const autoRefreshOn = resolved.flows['flow.autoRefresh']?.enabled ?? true;
  // org/flows 分区轮询：autoRefresh 开 → 4s；关 → 仅首拍。
  // cycle-46：apply 直写全部改走动作层引用；cycle-82：端点装配细节搬到
  // panelPeriodicTarget.ts —— 本组件只剩「一个节奏、一次绑定、一个门控」。
  const actions = bindPanelActions(store);
  usePanelFetch(periodicTarget(actions, ledgerLimit), autoRefreshOn ? 4000 : 0, reloadKey, wsHeaders, isolationOptions());
  useTokenCss();
  const theme = useShellTheme();
  // 实时调用流（cycle-97 动态白盒）：与静态分区并列，展示"正在发生的调用"。
  // 刷新按钮的 reloadKey 同时作为手动刷新信号（autoRefresh 关闭时的唯一更新途径）。
  // cycle-42（Top2）：三态写入 store，LiveInvocationsSection 订阅渲染。
  useInvocations(store, autoRefreshOn ? 2000 : 0, reloadKey, wsHeaders);

  // 图区节点点击 → 详情抽屉（useCallback 引用稳定，GraphSection memo 不破）。
  const onNodeClick = useCallback((n: WorkflowNode) => {
    setSelectedNode({ id: n.id, label: n.label, type: n.type, result: n.result, detail: n.detail, testReport: n.testReport });
  }, []);
  // 账本「显示更多」：抬 ledgerLimit 并 bump reloadKey（重拉即新 limit 生效；
  // 语义 = 带新翻页深度的手动刷新）。
  const onShowMore = useCallback((): void => {
    setLedgerLimit((l) => l + 24);
    setReloadKey((k) => k + 1);
  }, []);

  // 分区编排（旅程排序与 cycle-41 完全一致）：图区 → 实时调用 → 周期时间线 →
  // 步骤流程 → 诊断 → org 全景 → 技能健康 → 流程状态机 → 账本+HITL → 预算 →
  // 节点详情抽屉。门控布尔来自 prefs 同步解析，不随数据 tick 变化；分区
  // props 全部引用稳定（store 实例 / 布尔 / useCallback 回调）。
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
      createElement(ToolbarStatusLine, { store, key: 'status' }),
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
    // cycle-91：服务端解析态喂抽屉（workspace/deployment 层的真实生效值）。
    prefsOpen ? renderPrefsDrawer({ resolved: store.getState().resolvedFlows }, () => { setFlowTick((k) => k + 1); }, prefsPanelId) : null,
    // 分区编排（旅程排序）已拆至 panelSectionOrder.ts（cycle-95 · 守 T3 ≤250 行）：
    // 「先看到什么、后看到什么」属编排职责，与根组件的「数据从哪来、点了发生什么」
    // 是两件事。排序理由（工作区徽标为何在图区之前、配置为何刻意最后）写在彼文件头注。
    ...renderWorkbench({
      store, gates: { stepTraceOn, diagnosticsOn, flowsViewOn, approvalsOn },
      onNodeClick, onShowMore, autoRefreshOn, configPanelId, selectedNode, onCloseNodeDetail: closeNodeDetail,
      // cycle-95：工作区分键视图态的分键键源。null = 尚未学到 ⇒ 图区不记忆
      //（而不是拿 `__unknown__` 当键——两个都未识别的项目会共用一份视图，
      // 那正是本功能要消灭的污染）。
      workspace: learnedWorkspace ?? undefined,
    }),
  );
}
