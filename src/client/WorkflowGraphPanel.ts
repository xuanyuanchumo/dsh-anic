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
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { WORKFLOW_SNAPSHOT } from './workflowGraphData.ts';
import { renderGraph, buildVerdicts, type GraphData } from './features/graph/renderGraph.ts';
import { renderStepTrace, type StepTraceJson } from './features/stepTrace/renderStepTrace.ts';
import { renderDiagnostics, type SelfCheckJson } from './features/diagnostics/renderDiagnostics.ts';
import { renderPrefsDrawer, readPrefsRaw, PREFS_PANEL_ID_BASE } from './features/prefs/prefsDrawer.ts';
import { renderOrgStatus, type OrgStatusJson } from './features/org/renderOrgStatus.ts';
import { renderFlows, type FlowStatusJson } from './features/flows/renderFlows.ts';
import { useInvocations, renderInvocations } from './features/live/renderInvocations.ts';
import { usePanelFetch } from './components/usePanelFetch.ts';
import { panelLiveTargets, ORG_STATUS_URL, FLOWS_STATUS_URL } from './panelLiveTargets.ts';
import { renderCyclesTimeline, isCycleList, isCycleState, CYCLE_LIST_URL, CYCLE_STATE_URL, type CycleListJson, type CycleStateJson } from './features/cycles/renderCyclesTimeline.ts';
import { isObjectLike, isFlowStatus } from './features/live/fetchJson.ts';
import { useSelfInit } from './features/selfinit/useSelfInit.ts';
import { renderSectionWrap, renderSectionDisabled } from './components/sectionShell.ts';
import { usePanelInstanceSeq, idOf } from './components/sectionIds.ts';
import { resolveFlows, parseRawPrefs } from '../shared/flows.ts';
import { renderNodeDetail, type NodeDetail } from './features/graph/gateColors.ts';
import { resolveShellTheme, observeShellTheme, token, tokenCssBlock, THEME_ATTRIBUTE, type ShellTheme } from '../shared/tokens.ts';
import { PANEL_CSS } from '../shared/panelCss.ts';
import { t } from './i18n.ts';

interface FetchState { source: 'embedded' | 'live'; line: string; }


/**
 * 注入面板作用域的样式（P1-TOKENS 令牌块 + P1-1 面板 CSS 块）。
 *
 * 令牌块定义 `--anic-*` 变量；面板块消费它们实现交互态（:hover/:focus-visible）
 * 与响应式（@container）——这两者在内联 style 里表达不了（见 panelCss.ts 头注释）。
 * 挂在 document.head，卸载时移除；同页面多个面板实例不会重复注入（id 去重）。
 */
function useTokenCss(): void {
  useEffect(() => {
    const id = 'anic-panel-css';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = `${tokenCssBlock()}\n${PANEL_CSS}`;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);
}

/**
 * 跟踪宿主主题并把它写到面板根属性上（P0-THEME-MISMATCH）。
 *
 * 为什么不能只靠 CSS：宿主主题是**运行时状态**（用户在设置里切），而我们的
 * 暗色令牌必须跟着它走。原实现用 `@media (prefers-color-scheme: dark)` 近似，
 * 在"OS 暗色 + 宿主浅色"时套用暗色令牌 → 深底深字，实测几乎不可读。
 *
 * 这里读 `body[data-ds-dark-theme]`（宿主 theme-presenter 的权威输出，
 * 见 `tokens.ts` 注释），并订阅其变化，把结果写成 `[data-anic-theme]`。
 * 惰性求值 + 订阅，二者缺一不可：缓存初始值会让设置里切换主题后面板不跟随；
 * 不订阅则只能等下次重挂载。
 */
function useShellTheme(): ShellTheme {
  const [theme, setTheme] = useState<ShellTheme>(() => resolveShellTheme());
  useEffect(() => {
    // 挂载后立刻再读一次：属性可能晚于首次渲染到达（DOMContentLoaded 之前）。
    setTheme(resolveShellTheme());
    return observeShellTheme(setTheme);
  }, []);
  return theme;
}


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
  ], autoRefreshOn ? 4000 : 0, reloadKey, wsHeaders);
  useTokenCss();
  const theme = useShellTheme();
  // 实时调用流（cycle-97 动态白盒）：与静态分区并列，展示"正在发生的调用"。
  // 刷新按钮的 reloadKey 同时作为手动刷新信号（autoRefresh 关闭时的唯一更新途径）。
  const { data: invocations, pollError: invocationsError } = useInvocations(autoRefreshOn ? 2000 : 0, reloadKey, wsHeaders);

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
    renderGraph(data, buildVerdicts(trace), (n) => { setSelectedNode({ id: n.id, label: n.label, type: n.type, result: n.result }); }),
    // 实时调用分区紧跟图区：动态白盒是本面板的主叙事（m02733），
    // 用户展开面板第一眼应看到"模型此刻在怎么调用本插件"。
    renderInvocations(invocations, invocationsError, autoRefreshOn),
    // Cycle 时间线（B1 · P0 缺口）：宏观节奏条，旅程排序在实时调用之后、
    // 静态投影之前——「正在发生的调用」与「循环走到哪了」相邻呈现。
    renderCyclesTimeline({ list: cycleList, state: cycleState }),
    stepTraceOn
      ? renderSectionWrap({
          key: `trace-${String(flowTick)}`, anchorKey: 'data-anic-steptrace-wrap',
          dataLine: t('panel.traceDataLine', { line: traceLine }),
          body: trace === null ? null : renderStepTrace(trace),
          unavailableText: t('panel.traceUnavailable'),
        })
      : renderSectionDisabled({ anchorKey: 'data-anic-steptrace-disabled', text: t('panel.traceDisabled') }),
    diagnosticsOn
      ? renderSectionWrap({
          key: `check-${String(flowTick)}`, anchorKey: 'data-anic-diagnostics-wrap',
          dataLine: t('panel.diagDataLine', { line: checkLine }),
          body: check === null ? null : renderDiagnostics(check),
          unavailableText: t('panel.diagUnavailable'),
        })
      : renderSectionDisabled({ anchorKey: 'data-anic-diagnostics-disabled', text: t('panel.diagDisabled') }),
    orgStatus ? createElement('div', { 'data-anic-org-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}` } }, renderOrgStatus(orgStatus)) : null,
    // 流程状态机分区（cycle-9 · D10）：FlowRegistry 全景白盒。关闭形态契约与
    // stepTrace 同款 —— 分区隐藏 + 一行如实说明（INV-30），数据路由不受影响。
    flowsViewOn
      ? renderFlows(flowsStatus)
      : renderSectionDisabled({ anchorKey: 'data-anic-flowsview-disabled', text: t('flows.disabled') }),
    renderNodeDetail(selectedNode, selectedNode === null ? undefined : { detailId: `${prefsPanelId}-node-detail`, onClose: closeNodeDetail }),
  );
}
