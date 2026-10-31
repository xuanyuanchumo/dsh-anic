/**
 * 自举面板的**响应形状与守卫**（cycle-89 · 自举可重启的可视化腿）。
 *
 * ## 为什么客户端只依赖 JSON 契约、不 import host 类型
 *
 * 面板跑在宿主 webview 里，宿主升级（自举状态字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import `src/host/selfBootstrap.ts` 的类型，
 * 一次宿主字段改名就会让旧客户端整块崩掉（编译期还看不出来——打包时是
 * 类型擦除）。所以这里手工声明**可能缺字段**的形状，守卫只做最小准入，
 * 渲染层对每个字段单独降级。
 *
 * ## 为什么 `stale` 允许 boolean 与 `{changed}` 两种形态
 *
 * 宿主侧 `stale` 的语义是「存档 facts 与当前 facts 不一致」。早期实现只给
 * 一个布尔，后来需要点名「变了哪几项」（gitHead / cycle / ledgerHead…）。
 * 两种形态会**同时存在于真实部署中**（旧宿主 + 新客户端、新宿主 + 旧客户端），
 * 故守卫必须两者都收，派生函数 `staleOf` 归一。
 */

/** 一轮自举的历史记录（宿主 history[] 的子形状；全部可选——旧文件没有 factsDigest）。 */
export interface BootstrapHistoryEntry {
  round?: number;
  evalScore?: number;
  gateVerdict?: string | null;
  fixApplied?: string | null;
  timestamp?: string;
}

/** 项目事实基线（宿主 bootstrapFacts 的输出；字段全可选，缺就是缺）。 */
export interface BootstrapFactsJson {
  gitHead?: string | null;
  gitDirty?: boolean;
  currentCycle?: string | null;
  currentPhase?: string | null;
  ledgerHead?: string | null;
  ledgerEntries?: number;
  evalReport?: { path?: string; sha256?: string; mtime?: string } | null;
  activeCycles?: number;
  archivedCycles?: number;
  skillVersion?: string | null;
}

/** 活跃/归档分列（宿主 `activeVsArchived` 的宽松投影；字段全可选）。 */
export interface BootstrapActiveVsArchivedJson {
  /** 活跃循环目录名（升序）。 */
  active?: string[];
  archived?: number;
  total?: number;
  /** 评估/门禁/重启**只应看**这一份（= 活跃面）。 */
  evaluationInput?: string[];
}

/** `GET /anic/self/status` 的响应（宿主 BootstrapState 的宽松投影）。 */
export interface BootstrapJson {
  status?: string;
  round?: number;
  maxRounds?: number;
  lastEvalScore?: number;
  lastGateVerdict?: string | null;
  history?: BootstrapHistoryEntry[];
  lastFailure?: { reasons?: string[] } | null;
  facts?: BootstrapFactsJson | null;
  factsAt?: string | null;
  /** 当前事实的短摘要（宿主 `factsDigest`，16 位十六进制；面板只显示前 8 位）。 */
  factsDigest?: string | null;
  /** 布尔或 `{stale, changed}` 两形态（见文件头）。 */
  stale?: boolean | { stale?: boolean; changed?: string[] };
  staleReasons?: string[];
  restartCount?: number;
  /** cycle-95：活跃/归档分列（旧宿主没有该字段 ⇒ 渲染层按 facts 计数降级）。 */
  activeVsArchived?: BootstrapActiveVsArchivedJson | null;
  /**
   * cycle-95：宿主 `BOOTSTRAP_SETTLED` 的**权威裁决**（当前状态是否已结算）。
   *
   * 为什么需要它：`canRestart` 此前只认客户端自己抄的一份终态词表；终态集合的
   * 权威在宿主状态机。两份词表一分叉就会出现「宿主认为是中间态、面板认为可重启」
   * 的按钮——点下去会打断正在跑的评估。有这个字段时**以它为准**。
   */
  settled?: boolean | null;
}

/** 对象形（与 `features/live/fetchJson.isObjectLike` 同判据，独立实现避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「能取到 status 字符串」。
 *
 * 刻意**不**校验全部字段——任何新增/缺失字段都不该让整块面板走失败行
 * （与 `closureKinds` 的宽口径同理由：漏翻一个字段 ≠ 数据畸形）。
 */
export function isBootstrap(v: unknown): v is BootstrapJson {
  if (!isObj(v)) return false;
  return typeof v['status'] === 'string';
}

/** `stale` 归一：返回 `{stale, changed}`（两种宿主形态都收）。 */
export function staleOf(v: BootstrapJson): { stale: boolean; changed: string[] } {
  const raw = v.stale;
  if (typeof raw === 'boolean') return { stale: raw, changed: v.staleReasons ?? [] };
  if (isObj(raw)) {
    const changed = Array.isArray(raw['changed']) ? (raw['changed'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return { stale: raw['stale'] === true, changed: changed.length > 0 ? changed : (v.staleReasons ?? []) };
  }
  return { stale: false, changed: v.staleReasons ?? [] };
}

/** 终态集合（面板据此把「还能不能重启」讲清楚；与宿主机状态机词表同语义）。 */
export const SETTLED_STATUSES: readonly string[] = ['IDLE', 'CONVERGED', 'EXHAUSTED'];

/** 是否处于可重启形态：终态 + （陈旧 或 轮次耗尽）。进行态不可重启。 */
export function canRestart(v: BootstrapJson): boolean {
  const status = v.status ?? '';
  // 宿主权威优先：有 `settled` 就以它为准（中间态一律不可重启，即便 status 字符串
  // 因宿主新增状态词而不在本地词表里）。旧宿主无该字段时回落到本地终态集合。
  const settled = typeof v.settled === 'boolean' ? v.settled : SETTLED_STATUSES.includes(status);
  if (!settled) return false;
  const round = v.round ?? 0;
  const max = v.maxRounds ?? 0;
  return staleOf(v).stale || status === 'IDLE' || (max > 0 && round >= max);
}
