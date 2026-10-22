/**
 * 调用归属解析 —— 白盒四元组「流程流向」元的 join key（cycle-71）。
 *
 * 缺口（一轮实测）：`InvocationRecord` 没有「这次调用属于哪个 cycle / 哪个宏观相」
 * 的字段，面板无法把「模型此刻的调用」关联到「当前循环走到哪一步」；「最近完成
 * 全貌卡」的 ⑤ 归属段因此只能刻意留空（见 renderLastCompletedCard.ts 文件头）。
 *
 * ## 为什么在这一层解析（设计问题 1 → 方案 A′）
 *
 * 官方 `session/event` 事件的**第一参就是发起调用的 session**，其 `header.cwd`
 * （宿主 asar 实测 `SessionHeader.cwd: string?`）即该调用的工作区 —— 这是「免费」
 * 的归因源：不需要面板传任何元数据、不需要新路由，与 init-cycle 默认值决议
 * （default = 自主决议，不依赖面板）相容。
 *
 * 归属必须在**事件到达时**解析：调用发生那一瞬间的 currentCycle/currentPhase
 * 才是这次调用的真实流程坐标（call = 模型请求调用的瞬间）。
 *
 * 被否决的方案：
 *  - B（路由响应期 enriching）：路由只有 res/req，**拿不到 session**，只能靠
 *    `X-ANIC-Workspace` 头或 registry 猜；且快照期补算会把归属变成「看的时候
 *    的相」——对已结束的调用就是伪造（INV-27）。
 *  - 异步预热「工作区映射」：事件处理器在宿主热路径，异步刷新会引入
 *    「同一 callId 归属前后不一致」的非确定性与无界排队；收益仅是提前 TTL，
 *    不值得。
 *
 * ## 降级纪律（宁缺勿猜，INV-27 同族）
 *
 *  - session 有 cwd → 用它；
 *  - 无 session 级 cwd 时，仅当宿主已知工作区**去重后恰好 1 个**才采信（无歧义）；
 *    0 个（无从判断）或 ≥2 个（多会话歧义）→ **不填**；
 *  - `workflow-state.json` 缺失 / JSON 损坏 / 字段类型非字符串 → **不填**且不抛；
 *  - 解析器抛错由 attributionFor 兜住 —— 归属永不让调用流断流。
 *    绝不取 `process.cwd()` 或「首条注册表项」兜底：那会把调用归到错误的工作区，
 *    比留空更糟（空 = 诚实的未知；错 = 伪造）。
 *
 * ## 缓存
 *
 * TTL 2000ms，按工作区分键。为什么是 2s：面板轮询周期就是 2s
 * （useInvocations(store, pollMs = 2000)），可见粒度即 2s；workflow-state 是
 * 「按轮次推进」的低频文件（本机 updatedAt 与读时刻差数小时），2s 陈旧窗口
 * 远小于可见粒度。命中代价 = Map 查；未命中 = 至多一次 ≤1KB 本地**同步**读
 * （µs 级，不 await —— 事件处理路径不引 promise 竞态）。
 * key 上限 64 条，超限整体清空（防会话 churn 无界增长）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 归属元数据。两个字段都可缺：拿不到就**不落字段**，不伪造。 */
export interface InvocationAttribution {
  /** `.cycles/workflow-state.json` 的 currentCycle（如 `cycle-71`）。 */
  cycle?: string;
  /** 同上的 currentPhase（如 `build`）。 */
  phase?: string;
}

/** 宿主面窄化（房屋风格：不引宿主包，本地窄化）。 */
interface AttrCtx {
  sessions?: { list?(): Array<{ header?: { cwd?: string } }> };
  workspaceRegistry?: { list?(): Array<{ path?: string }> };
}

/** 归属解析器：单参 = `session/event` 事件第一参。 */
export type AttributionResolver = (session: unknown) => InvocationAttribution | null;

/** 默认 TTL（ms）：对齐客户端轮询周期，见文件头「缓存」段。 */
export const ATTRIBUTION_TTL_MS = 2000;

const CACHE_MAX_KEYS = 64;

export interface AttributorOptions {
  /** 读盘注入点（单测计数/时钟断言用）；缺省走真实 fs。 */
  read?: (workspaceRoot: string) => InvocationAttribution | null;
  /** 时钟注入点（单测 TTL 边界断言用）。 */
  now?: () => number;
  /** 覆盖 TTL（单测用短 TTL 免 sleep）。 */
  ttlMs?: number;
}

/**
 * 读 `.cycles/workflow-state.json` 的归属字段（纯读 + 全路径降级）。
 * 只采信字符串且非空的 currentCycle/currentPhase；两者都没有 → null。
 */
export function readAttributionFromDisk(workspaceRoot: string): InvocationAttribution | null {
  const p = join(workspaceRoot, '.cycles', 'workflow-state.json');
  try {
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { currentCycle?: unknown; currentPhase?: unknown } | null;
    const cycle = typeof raw?.currentCycle === 'string' && raw.currentCycle !== '' ? raw.currentCycle : undefined;
    const phase = typeof raw?.currentPhase === 'string' && raw.currentPhase !== '' ? raw.currentPhase : undefined;
    if (cycle === undefined && phase === undefined) return null;
    const out: InvocationAttribution = {};
    if (cycle !== undefined) out.cycle = cycle;
    if (phase !== undefined) out.phase = phase;
    return out;
  } catch {
    // 缺失/损坏/权限/竞态删除：宁缺勿猜——绝不抛进宿主事件热路径。
    return null;
  }
}

/** session.header.cwd（非空字符串才采信）。 */
function cwdOfSession(session: unknown): string | null {
  const raw = (session as { header?: { cwd?: unknown } } | null | undefined)?.header?.cwd;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** 宿主已知工作区集合（registry.path ∪ sessions.header.cwd，去重）。 */
function knownRoots(ctx: AttrCtx): Set<string> {
  const set = new Set<string>();
  try {
    for (const w of ctx.sessions?.list?.() ?? []) {
      const cwd = w.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '') set.add(cwd);
    }
  } catch { /* sessions 未挂载/不可用 → 无候选 */ }
  try {
    for (const w of ctx.workspaceRegistry?.list?.() ?? []) {
      if (typeof w.path === 'string' && w.path !== '') set.add(w.path);
    }
  } catch { /* registry 未挂载 → 无候选 */ }
  return set;
}

/**
 * 解析本次调用的工作区：session cwd 优先；否则仅「无歧义唯一候选」才采信。
 * 返回 null = 归属不可知 → 字段不落（降级语义，见文件头）。
 */
export function workspaceOfSession(session: unknown, ctx: unknown): string | null {
  const direct = cwdOfSession(session);
  if (direct) return direct;
  // 唯一可信兜底：去重后恰好 1 个（多会话 = 歧义 = 不猜）。
  const candidates = knownRoots(ctx as AttrCtx);
  return candidates.size === 1 ? [...candidates][0] ?? null : null;
}

/** 创建归属解析器（宿主接线见 attachInvocationFeed 的 resolveAttribution）。 */
export function createInvocationAttributor(ctx: unknown, options: AttributorOptions = {}): AttributionResolver {
  const c = ctx as AttrCtx;
  const read = options.read ?? readAttributionFromDisk;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? ATTRIBUTION_TTL_MS;
  const cache = new Map<string, { at: number; value: InvocationAttribution | null }>();
  return (session) => {
    const root = workspaceOfSession(session, c);
    if (!root) return null; // 工作区不可解析 → 不填（不缓存「猜」出来的东西）
    const t = now();
    const hit = cache.get(root);
    if (hit && t - hit.at < ttl) return hit.value;
    let value: InvocationAttribution | null = null;
    try {
      value = read(root) ?? null;
    } catch {
      // 注入的读取器抛错（自定义 read / 极端 IO）→ 当作「不可知」，绝不冒泡进
      // 宿主事件热路径。失败**不缓存**：下次事件重试，不把瞬时错误钉成 2s 假阴性。
      return null;
    }
    if (cache.size >= CACHE_MAX_KEYS) cache.clear();
    cache.set(root, { at: t, value });
    return value;
  };
}

/**
 * 事件路径包装：解析器缺失/抛错 → null。
 * 归属是**观测元数据**，任何情况下都不得阻断调用流（也不得改变既有 feed 语义）。
 */
export function attributionFor(session: unknown, resolver?: AttributionResolver): InvocationAttribution | null {
  if (!resolver) return null;
  try {
    return resolver(session) ?? null;
  } catch {
    return null;
  }
}
