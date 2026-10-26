/**
 * 重载编排域（cycle-80 WS-1 · 一域一文件）：探测 hmr → 判新鲜度 → **先落 in-flight** → 触发。
 *
 * ## 被修的缺口（实测，不是推测）
 * 宿主 desktop profile 的 `@deepseek-ai/dsh-hmr` 已 active：`ctx.hmr.runExclusive(op)` 与
 * `ctx.hmr.reconcileProfile(requiredIds?)` 提供「重载 profile 内磁盘文件已变」的插件能力，
 * 本插件又是 `link:` 安装 ⇒ `dist/` 正是 reconcileProfile 命中的 **linked package targets**。
 * 但本仓 `grep ctx.hmr src/` 零命中——宿主把能力注册了，插件从不消费，于是每次改代码都只能
 * 人工重启宿主。本模块是这条消费链的编排面。
 *
 * ## 三条铁律（每条对应一个真实失败形态）
 * 1) **in-flight 先落盘再触发**：`reconcileProfile` 会替换本实例，事后没人能写「请求过重载」。
 *    顺序若反过来，真发生重载时史账会是空的——最坏的静默失败（见 reloadHistory 头注）。
 * 2) **setTimeout 不 await**：本实例即将被替换，await 的续体可能永不执行，还会把调用方挂住。
 *    触发后立刻返回 `scheduled`；结果由新实例 finalize 与史账体现。
 * 3) **hmr 绝不进硬 inject**：headless/SDK profile 没有 hmr，硬 inject 会让整条 fiber pending
 *    （cycle-74 P0 教训）。只经 `ctx.get('hmr', false)` 可选探测；缺失即 `unavailable`
 *    且零写入——诚实降级，绝不假装成功。
 *
 * ## 诚实边界
 * 只保证「请求 + 留痕」：不保证宿主真的完成重载；实例被杀会让 `.then` 侧的成功/失败条目丢失，
 * 但 in-flight 握手条目一定先于触发落盘，因此「曾经请求过」不会被吞掉。
 */
import { buildFreshness, computeBuildRevision } from './buildRevision.ts';
import { appendReloadHistory, finalizeInFlight, readReloadHistory, type ReloadHistoryEntry } from './reloadHistory.ts';

/** 宿主 hmr 服务的最小形状（只声明本模块用到的两个方法）。 */
interface HmrService {
  runExclusive?: (op: () => Promise<unknown>) => Promise<unknown>;
  reconcileProfile?: (requiredIds?: readonly string[]) => Promise<unknown>;
}

/** reloadSelf 的结果（工具与路由共用同一形状；action 三态是诚实降级的全部形态）。 */
export interface ReloadResult {
  action: 'scheduled' | 'refused' | 'unavailable';
  reason: string;
  fromRevision: string | null;
  stale: boolean;
  /** true = 本实例已把 in-flight 落盘（跨实例握手生效）；其余动作恒 false。 */
  handshake: boolean;
  revision?: string | null;
  scheduledAt?: string;
  history?: { ok: boolean; dropped?: number };
}

/** reloadSelf 的入参（cyclesDir = 工作区 `.cycles`；pluginRoot = 插件根）。 */
export interface ReloadSelfOptions {
  cyclesDir: string;
  pluginRoot: string;
  reason: string;
  actor: string;
  requiredIds?: string[];
  /** 测试/演示用：跳过「dist 已最新则拒绝」。生产调用方不该传。 */
  force?: boolean;
}

/**
 * 解析 hmr 服务（**一次** ctx.get，探测与取句柄同源）。
 *
 * 为什么合成一个函数：分成「先 probe 再 get」会让同一次调用里 ctx.get('hmr') 发生两次
 * ——两次之间服务若被卸载，就会出现「探测说可用、取句柄拿到 undefined」的 TOCTOU 分叉
 * （契约测试的调用序证据也会多一条 get，掩盖真实调用形态）。
 */
function resolveHmr(ctx: unknown): { available: boolean; reason: string; service: HmrService | null } {
  const get = (ctx as { get?: (key: string, strict?: boolean) => unknown } | null | undefined)?.get;
  if (typeof get !== 'function') return { available: false, reason: 'ctx.get is not available', service: null };
  let svc: HmrService | null | undefined;
  try {
    svc = get.call(ctx, 'hmr', false) as HmrService | null | undefined;
  } catch {
    return { available: false, reason: 'hmr probe threw (ctx.get(hmr) unavailable)', service: null };
  }
  if (svc === null || svc === undefined) {
    return { available: false, reason: 'hmr service not provided (headless/SDK profile)', service: null };
  }
  if (typeof svc.runExclusive !== 'function' || typeof svc.reconcileProfile !== 'function') {
    return { available: false, reason: 'hmr service shape mismatch (runExclusive/reconcileProfile missing)', service: null };
  }
  return { available: true, reason: 'ok', service: svc };
}

/**
 * 可选探测 hmr 服务（**不**写进 inject）。
 * 两个方法都在才算可用——半残服务比没有更危险（会返回一个没人能保证语义的 Promise）。
 */
export function probeHmr(ctx: unknown): { available: boolean; reason: string } {
  const r = resolveHmr(ctx);
  return { available: r.available, reason: r.reason };
}

/**
 * 请求本插件热重载（核心入口）。
 *
 * 顺序**不可交换**：探测 → 新鲜度 → 落 in-flight → 触发。若先触发再写，本实例被替换后就没
 * 有任何进程能写下「请求过重载」——史账会显示成「什么都没发生」（最坏的静默失败）。
 */
export async function reloadSelf(ctx: unknown, opts: ReloadSelfOptions): Promise<ReloadResult> {
  const hmr = resolveHmr(ctx);
  if (!hmr.available || hmr.service === null) {
    // 零写入：没有服务就没有发生任何事，写一条 'unavailable' 反而是伪造活动痕迹。
    return { action: 'unavailable', reason: hmr.reason, fromRevision: null, stale: false, handshake: false };
  }
  const fresh = buildFreshness(opts.pluginRoot);
  const fromRevision = fresh.revision?.revision ?? null;
  if (!fresh.stale && opts.force !== true) {
    return {
      action: 'refused',
      reason: 'dist is up to date (no source change since last build)',
      fromRevision, stale: false, handshake: false, revision: fromRevision,
    };
  }
  const entry: ReloadHistoryEntry = {
    at: new Date().toISOString(),
    actor: opts.actor,
    reason: opts.reason,
    status: 'in-flight',
    fromRevision,
    toRevision: null,
    staleAtRequest: true,
    warnings: [],
    pending: [],
    restartReason: null,
    error: null,
  };
  const appended = appendReloadHistory(opts.cyclesDir, entry);
  if (!appended.ok) {
    // 没有留痕就不触发：拿不到审计证据的重载请求一律拒绝（"没有证据 ≠ 通过"）。
    return {
      action: 'refused',
      reason: 'reload history is not writable; refusing to reload without an audit trail',
      fromRevision, stale: true, handshake: false, revision: fromRevision,
    };
  }
  const service = hmr.service;
  // 铁律②：不 await —— 本实例即将被替换，续体可能永不执行；串行化交给 runExclusive。
  setTimeout(() => {
    void Promise.resolve()
      .then(() => service.runExclusive?.(async () => service.reconcileProfile?.(opts.requiredIds)))
      // 成功且实例存活（无可替换项）时自己完成握手；已被替换时由新实例 finalize 接手。
      .then(() => { finalizeInFlight(opts.cyclesDir, computeBuildRevision(opts.pluginRoot)?.revision ?? null); })
      .catch((e: unknown) => {
        appendReloadHistory(opts.cyclesDir, {
          ...entry,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
          finalizedAt: new Date().toISOString(),
        });
      });
  }, 0);
  return {
    action: 'scheduled',
    reason: opts.reason,
    fromRevision,
    stale: true,
    handshake: true,
    revision: fromRevision,
    scheduledAt: entry.at,
    history: appended.dropped === undefined ? { ok: true } : { ok: true, dropped: appended.dropped },
  };
}

/** 只读摘要（org-status / 面板用；不暴露 hmr 服务对象、不写盘）。 */
export interface ReloadSummary {
  /** 刻意恒缺省：摘要不泄漏宿主服务对象本身（只读面拿不到可调用句柄）。 */
  hmr?: never;
  stale: boolean;
  revision: string | null;
  last: ReloadHistoryEntry | null;
  historyCount: number;
  error: string | null;
}

/** 汇总当前构建新鲜度 + 最近一次重载（只读，无副作用）。 */
export function reloadSummary(cyclesDir: string, pluginRoot: string): ReloadSummary {
  const fresh = buildFreshness(pluginRoot);
  const { entries, error } = readReloadHistory(cyclesDir);
  const last = entries.length > 0 ? (entries[entries.length - 1] as ReloadHistoryEntry) : null;
  return {
    stale: fresh.stale,
    revision: fresh.revision?.revision ?? null,
    last,
    historyCount: entries.length,
    error,
  };
}
