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
import type { FlowMatrixJson } from '../features/flows/flowMatrixTypes.ts'; // cycle-89：归属矩阵切片
import type { LifecycleMetricsJson } from '../features/flows/lifecycleTypes.ts'; // cycle-90：生命周期指标
import type { ResolvedFlowsJson } from './resolvedFlowsTypes.ts'; // cycle-91：开关解析态
import type { CycleListJson, CycleStateJson } from '../features/cycles/renderCyclesTimeline.ts';
import type { LedgerListJson, LedgerVerifyJson } from '../features/ledger/renderLedger.ts';
import type { HitlAuditJson } from '../features/hitl/renderHitl.ts';
import type { BudgetJson } from '../features/budget/renderBudget.ts';
import type { SkillHealthJson } from '../features/skillhealth/renderSkillHealth.ts';
import type { TechDebtListingJson } from '../features/techdebt/renderTechDebt.ts';
import type { ClosureView } from '../features/closure/renderClosure.ts';
// cycle-89：自举状态切片（自举可重启的可视化腿）。
import type { BootstrapJson } from '../features/bootstrap/bootstrapTypes.ts';
// cycle-82：配置编辑器域（GET 事实 + 草稿合并 + 写结果）。
import { valueToDraftText, type ConfigJson, type ConfigWriteJson } from '../features/config/configTypes.ts';
import type { InvocationsJson } from '../features/live/renderInvocations.ts';
import type { FetchFailure } from './usePanelFetch.ts';
import type { DisclosureReadoutJson } from './disclosureReadoutTypes.ts';
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
  /** 流程归属矩阵落地（cycle-89 4s 档；量化条的数据源）。 */
  setFlowMatrix(v: FlowMatrixJson): void;
  setLifecycleMetrics(v: LifecycleMetricsJson): void; // cycle-90：生命周期指标（4s 档）
  setResolvedFlows(v: ResolvedFlowsJson): void; // cycle-91：开关解析态（workspace/deployment 层）
  setDisclosure(v: DisclosureReadoutJson): void; // cycle-93：披露运行时读数
  setCycleList(v: CycleListJson): void;
  setCycleState(v: CycleStateJson): void;
  setSkillHealth(v: SkillHealthJson): void;
  setTechDebt(v: TechDebtListingJson): void;
  /** 闭环体检落地（一次性档；失败经 markFetchFailure('closure') 如实呈现）。 */
  setClosure(v: ClosureView): void;
  /** 自举状态落地（cycle-89 4s 档；重启后由动作腿主动重拉一次）。 */
  setBootstrap(v: BootstrapJson): void;
  setBudget(v: BudgetJson): void;
  setLedgerList(v: LedgerListJson): void;
  setLedgerVerify(v: LedgerVerifyJson): void;
  setHitlAudit(v: HitlAuditJson): void;
  // ── 配置编辑器域（cycle-82）───────────────────────────────────────────
  /**
   * 配置 GET 事实落地 + **草稿合并**。
   *
   * 合并规则：草稿里「与旧事实不同」的字段保留（用户正在改），「与旧事实相同」
   * 的丢弃（用户没动，跟着新事实走）。两个方向都不能简化：
   *   - 全保留 → 别人改了配置，用户永远看着旧值，保存时把别人的改动覆盖掉；
   *   - 全丢弃 → 轮询每拍都把用户正在打的字擦掉（真机表现为"输入框自己清空"）。
   * 这条是配置分区能开轮询的前提，故落在动作层而不是渲染层。
   */
  setConfig(v: ConfigJson): void;
  /** 改一个草稿字段（开关传 boolean，文本传 string）。 */
  setConfigDraft(fieldId: string, value: string | boolean): void;
  /** 丢弃全部草稿（回到「与新事实一致」）。 */
  clearConfigDrafts(): void;
  /** 写入开始：busy=true，并清掉上一次的写结果与错误（避免"上一条的成功"冒充这一次）。 */
  beginConfigWrite(): void;
  /** 写入成功：草稿提交为新基线 + 记录时间 + 存结果。 */
  finishConfigWrite(result: ConfigWriteJson, at: string): void;
  /**
   * 预览成功：只存结果，**不动草稿、不动 saveAt**。
   *
   * 为什么单列一个动作而不是复用 finishConfigWrite：预览的语义是「如果保存会发生什么」
   * 的一次问答，把它写成"已完成"会让 dirty 计数归零、让用户以为已经存了
   * （真机上表现为"点了预览，改的东西不见了"）。语义不同的写必须有不同的动作名。
   */
  finishConfigPreview(result: ConfigWriteJson): void;
  /** 写入失败：**保留草稿**（用户不用重打），结果与错误如实记录。 */
  failConfigWrite(error: string, result: ConfigWriteJson | null): void;
  /** 拉取失败（与写错误分开——两条来源不同的通道）。 */
  failConfig(error: string): void;
  /** 拉取成功：清拉取错误。 */
  recoverConfig(): void;
  // ── 分区失败通道（cycle-71 T-7117：消除「分区无声消失」）────────────────
  /**
   * 记下某分区的拉取失败（4s 档 10 端点通用）。
   *
   * **零通知不变式**：内容相同即不换对象——否则每个 4s tick 都产生新引用、
   * 都通知全场（4s 档每轮都失败时尤为明显）。这是本动作的核心纪律。
   */
  markFetchFailure(id: string, f: FetchFailure): void;
  /** 成功后清除该分区失败记录（同样零通知：本就无记录时不换对象）。 */
  clearFetchFailure(id: string): void;
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
    setFlowMatrix: (v) => { store.setState({ flowMatrix: v }); },
    setLifecycleMetrics: (v) => { store.setState({ lifecycleMetrics: v }); },
    setResolvedFlows: (v) => { store.setState({ resolvedFlows: v }); },
    setDisclosure: (v) => { store.setState({ disclosure: v }); },
    setCycleList: (v) => { store.setState({ cycleList: v }); },
    setCycleState: (v) => { store.setState({ cycleState: v }); },
    setSkillHealth: (v) => { store.setState({ skillHealth: v }); },
    setTechDebt: (v) => { store.setState({ techDebt: v }); },
    setClosure: (v) => { store.setState({ closure: v }); },
    setBootstrap: (v) => { store.setState({ bootstrap: v }); },
    setBudget: (v) => { store.setState({ budget: v }); },
    setLedgerList: (v) => { store.setState({ ledgerList: v }); },
    setLedgerVerify: (v) => { store.setState({ ledgerVerify: v }); },
    setHitlAudit: (v) => { store.setState({ hitlAudit: v }); },
    // 分区失败通道（cycle-71 T-7117）：三分类文案复用唯一 classifier。
    // 零通知不变式——先比内容，相同即原样返回（{failures: 同一引用} →
    // store 的 Object.is 比较判「未变」→ 零监听器回调）。
    markFetchFailure: (id, f) => {
      const line = classifyFailure(f);
      store.setState((s) => (s.failures[id] === line ? {} : { failures: { ...s.failures, [id]: line } }));
    },
    clearFetchFailure: (id) => {
      store.setState((s) => {
        if (!(id in s.failures)) return {}; // 无记录 → 零通知（4s 档常走此路）
        const next = { ...s.failures };
        delete next[id];
        return { failures: next };
      });
    },
    // ── 配置编辑器域（cycle-82）────────────────────────────────────────
    // 草稿合并（见接口注释）：以「旧事实」为基准算用户是否动过，再决定保留与否。
    // 比较用 valueToDraftText 归一（服务端 3 与草稿 '3' 是同一件事，
    // 直接用 !== 会把「没动过」误判成「动过」，草稿就永远清不掉）。
    setConfig: (v) => {
      store.setState((s) => {
        const prev = s.config;
        const drafts = s.configDrafts;
        if (Object.keys(drafts).length === 0 || prev === null) {
          // 没有草稿（最常见）→ 零成本直通，不建新对象。
          return prev === v ? {} : { config: v };
        }
        const nextDrafts: Record<string, string | boolean> = {};
        for (const [id, draft] of Object.entries(drafts)) {
          const prevText = valueToDraftText(prev.values[id]);
          const draftText = typeof draft === 'boolean' ? (draft ? 'true' : 'false') : String(draft);
          if (draftText !== prevText) nextDrafts[id] = draft; // 用户动过 → 保留
        }
        const sameDrafts = Object.keys(nextDrafts).length === Object.keys(drafts).length;
        if (prev === v && sameDrafts) return {}; // 事实与草稿都没变 → 零通知
        return { config: v, configDrafts: nextDrafts };
      });
    },
    setConfigDraft: (fieldId, value) => {
      store.setState((s) => ({ configDrafts: { ...s.configDrafts, [fieldId]: value } }));
    },
    clearConfigDrafts: () => {
      store.setState((s) => (Object.keys(s.configDrafts).length === 0 ? {} : { configDrafts: {} }));
    },
    beginConfigWrite: () => { store.setState({ configBusy: true, configError: null, configWrite: null }); },
    finishConfigWrite: (result, at) => {
      store.setState({ configBusy: false, configWrite: result, configSavedAt: at, configDrafts: {} });
    },
    finishConfigPreview: (result) => {
      // 只落地"如果保存会怎样"的答案：草稿与 savedAt 原样（见接口注释）。
      store.setState({ configBusy: false, configWrite: result, configError: null });
    },
    failConfigWrite: (error, result) => {
      store.setState({ configBusy: false, configError: error, configWrite: result });
    },
    failConfig: (error) => {
      store.setState((s) => (s.configError === error ? {} : { configError: error }));
    },
    recoverConfig: () => {
      store.setState((s) => (s.configError === null ? {} : { configError: null }));
    },
  };
}
