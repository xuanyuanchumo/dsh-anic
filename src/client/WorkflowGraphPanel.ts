/**
 * ANIC 工作流图 SVG 面板（M0-① 图区 + M1 全功能面分区）。
 *
 * 纯渲染已提取至 features/graph/renderGraph.ts（12 §3.1 特性模块制）；
 * 分区订阅薄组件在 components/panelSections.ts（cycle-42 Top2 拆分）。
 * 本文件只剩：外部 store 的创建/接线 + 交互态 + 工具栏/抽屉 + 编排。
 *
 * cycle-42（Top2 债务收口）：数据面（原 ~15 个数据 useState）全部搬入
 * panelState 外部 store；usePanelFetch/useInvocations 的 apply 回调改写 store；
 * 各分区由薄组件按切片订阅——2s/4s tick 的重渲范围收敛到对应分区，
 * 根组件不再因数据 tick 重渲（store/回调引用恒定，React.memo 拦截级联）。
 *
 * 数据热更新（三层，全部安全降级）：
 *   1. 嵌入快照（构建期生成，永远可用 —— 多代宿主安全底线）；
 *   2. live 路由 GET /anic/api/workflow-snapshot（宿主注册；挂载时与点「刷新」时拉取）；
 *   3. 路由缺失/404/5xx/无 fetch → 回退嵌入快照，底行如实显示来源。
 *
 * 主题 hooks 在 components/panelTheme.ts（cycle-18 T3 拆分）。
 */
import { createElement, useCallback, useRef, useState, type ReactElement } from 'react';
import { createPanelStore } from './components/panelStore.ts';
import { bindPanelActions } from './components/panelActions.ts';
import { createInitialPanelState, type PanelDataStore } from './panelState.ts';
import { GraphSection, LiveInvocationsSection, CyclesSection, StepTraceSection, DiagnosticsSection, OrgSection, SkillHealthSection, TechDebtSection, FlowsSection, LedgerSection, HitlSection, BudgetSection, ToolbarStatusLine } from './components/panelSections.ts';
// cycle-72 T-7207：闭环体检分区（注册↔生产↔消费 三态矩阵白盒面）+ 其数据腿 target。
import { ClosureSection } from './features/closure/ClosureSection.ts';
import { closureTarget } from './features/closure/closureTarget.ts';
// cycle-82：配置与路径分区（唯一可写面）+ 其 4s 档数据腿。
import { ConfigSection, CONFIG_PANEL_ID } from './features/config/ConfigSection.ts';
import { configTarget } from './features/config/configTarget.ts';
import { renderPrefsDrawer, readPrefsRaw, PREFS_PANEL_ID_BASE } from './features/prefs/prefsDrawer.ts';
import { useInvocations } from './features/live/useInvocations.ts';
import { usePanelFetch } from './components/usePanelFetch.ts';
import { useTokenCss, useShellTheme } from './components/panelTheme.ts';
import { panelLiveTargets } from './panelLiveTargets.ts';
// cycle-82：4s 档全部端点（数据面知识）搬出根组件，见该文件头注。
import { periodicTarget } from './panelPeriodicTarget.ts';
import { useSelfInit } from './features/selfinit/useSelfInit.ts';
import { usePanelInstanceSeq, idOf } from './components/sectionIds.ts';
import { resolveFlows, parseRawPrefs } from '../shared/flows.ts';
import { renderNodeDetail, type NodeDetail } from './features/graph/gateColors.ts';
import { THEME_ATTRIBUTE, token } from '../shared/tokens.ts';
import type { WorkflowNode } from './workflowGraphData.ts';
import { t } from './i18n.ts';

/**
 * 面板组件：挂载即并行拉 live（snapshot/step-trace/self-check/org-status；各自独立降级）。
 * 「刷新」手动重拉；「⚙」展开开关抽屉。in-flight 守卫防抖；无 fetch（smoke 沙盒）
 * → 保持嵌入快照。分区按 user 层开关门控（INV-30：关闭形态在 UI 如实呈现）。
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
  // 响应头），后续所有请求回带 X-ANIC-Workspace 头，让服务端在多会话宿主上
  // 解析到「本面板的工作区」而不是 sessions.list() 首条。服务端只把它当
  // 选择器（必须命中宿主已知工作区集或含 .cycles 才采信），不是任意路径入口。
  const workspaceRef = useRef<string | null>(null);
  const wsHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (workspaceRef.current) h['X-ANIC-Workspace'] = workspaceRef.current;
    return h;
  }, []);

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
  // cycle-46（T-4601 写侧收口）：内联 setter 闭包清零——写路径全部走
  // bindPanelActions 动作层（setGraph/setFetchLine/setTrace/setCheck），
  // learnWorkspace/workspaceKnown 两 ref 通道保留在调用点（非 store 写）。
  // cycle-72：闭环体检数据腿并入同一 pollMs=0 档（见 closureTarget 头注——
  // 不接则该分区有壳无表体；全仓扫描 ~7s 故不与轻量档混轮询）。
  usePanelFetch([...panelLiveTargets({
    setData: bindPanelActions(store).setGraph,
    setFetchLine: bindPanelActions(store).setFetchLine,
    setTrace: bindPanelActions(store).setTrace,
    setCheck: bindPanelActions(store).setCheck,
    learnWorkspace: (root) => { workspaceRef.current = root; },
    workspaceKnown: () => workspaceRef.current,
  }), ...closureTarget(bindPanelActions(store))], 0, reloadKey, wsHeaders);

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
  // cycle-46（T-4601）：apply 直写全部改走动作层引用（bindPanelActions 一次性绑定）。
  // cycle-82：八个端点的装配细节搬到 panelPeriodicTarget.ts（数据面知识与编排分离），
  // 本组件只剩「一个节奏、一次绑定、一个门控」三件事。
  const actions = bindPanelActions(store);
  usePanelFetch(periodicTarget(actions, ledgerLimit), autoRefreshOn ? 4000 : 0, reloadKey, wsHeaders);
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
    prefsOpen ? renderPrefsDrawer({}, () => { setFlowTick((k) => k + 1); }, prefsPanelId) : null,
    // 图区：订阅 graph+trace 两切片（verdicts 由 trace 派生）。
    createElement(GraphSection, { store, onNodeClick }),
    // 实时调用分区紧跟图区：动态白盒是本面板的主叙事（m02733），
    // 用户展开面板第一眼应看到"模型此刻在怎么调用本插件"。
    // cycle-41（用户目标 A）：默认只展开「最近一次已完成调用」与「运行中调用」
    // 所在组——旧轮次默认折叠收纳（组内摘要仍有计数，点开即全文）。
    // cycle-42（T-4204）：deferred 渲染 + 陈旧指示（panelSections 内部）。
    createElement(LiveInvocationsSection, { store, autoRefreshOn }),
    // Cycle 时间线（B1 · P0 缺口）：宏观节奏条，旅程排序在实时调用之后、
    // 静态投影之前——「正在发生的调用」与「循环走到哪了」相邻呈现。
    // cycle-41（Top4b）：次级分区套可折叠壳（默认展开；折叠是用户主动收纳）。
    createElement(CyclesSection, { store }),
    createElement(StepTraceSection, { store, enabled: stepTraceOn }),
    createElement(DiagnosticsSection, { store, enabled: diagnosticsOn }),
    // cycle-20（P2）：自主级仪表带——org 全景的"一眼可读"形态（OrgSection 内
    // 仪表带是总览、文本行是明细，两区消费同一 orgStatus 切片）。
    createElement(OrgSection, { store }),
    // cycle-20（P3）：技能健康面板——FlowTracker 调用历史的健康分析面，
    // 旅程排序在 org 全景后、流程状态机前（「组织状态」→「技能健康」→「流程白盒」）。
    createElement(SkillHealthSection, { store }),
    // cycle-54（T-5401）：技术债务队列——「技能健康」之后呈现「欠了什么债」
    //（提案工作队列 + 已消费计数 + 非 TechDebtEntry 形态如实跳过说明）。
    createElement(TechDebtSection, { store }),
    // 流程状态机分区（cycle-9 · D10）：FlowRegistry 全景白盒。关闭形态契约与
    // stepTrace 同款 —— 分区隐藏 + 一行如实说明（INV-30），数据路由不受影响。
    createElement(FlowsSection, { store, enabled: flowsViewOn }),
    // 账本事件流 + HITL 审计队列（B2 · cycle-18）：治理证据簇，旅程排序紧跟
    // 流程状态机——「状态机走到哪」与「裁决留了什么痕、谁在等人工」相邻呈现。
    // cycle-24（P3 分页）：「显示更多」的 hasMore 由 LedgerSection 订阅数据自算。
    createElement(LedgerSection, { store, onShowMore }),
    createElement(HitlSection, { store, enabled: approvalsOn }),
    // cycle-24（P3 治理预算）：预算余量条 + 大文件榜——治理证据簇收尾
    //（「留了什么痕」之后呈现「这些痕占了多少空间」）。
    createElement(BudgetSection, { store }),
    // cycle-72 T-7207：闭环体检（注册↔生产↔消费）——治理证据簇之后回答
    //「注册了的东西到底有没有被生产、被消费」（未消费清单 + 幽灵消费两表）。
    createElement(ClosureSection, { store }),
    // cycle-82：配置与路径（唯一**可写**分区）。排序刻意放在最后：
    // 面板的主叙事是"读"（图 → 调用 → 节奏 → 治理证据 → 缺口），配置是"改"，
    // 越靠近底部越不容易挡住观测面；同时它默认展开，需要时滚到底一次可达。
    createElement(ConfigSection, { store, panelId: configPanelId }),
    renderNodeDetail(selectedNode, selectedNode === null ? undefined : { detailId: `${prefsPanelId}-node-detail`, onClose: closeNodeDetail }),
  );
}
