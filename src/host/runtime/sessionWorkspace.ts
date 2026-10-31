/**
 * 会话工作区解析（本模块的缺陷源起：用户实测 anic_status 默认指向 dsh-anic
 * 而非当前对话工作区）。
 *
 * ## 根因（宿主 asar 实测证据链）
 *
 * - 宿主 `@deepseek-ai/dsh-tools` `createExecution`：`tool.execute(exec.arguments, exec)`，
 *   `exec` 携带 `agent`（含 `agent.session`，`session.header.cwd` 是创建时目录）。
 * - 宿主 `@deepseek-ai/dsh-working-directory` `WorkingDirectoryService.get(session)`
 *   返回会话**实时**工作目录（sessionProjections 状态，`init: header.cwd`，`cd` 变更即更新）。
 * - dsh-anic 工具侧 `getRoot()` → `resolveWorkspaceRoots(ctx)`（无 req）→ 跳过头/查询
 *   声明 → `workspaceRegistry.list()` **第一条**（常是 dsh-anic 自己）——多工作区宿主里
 *   这是一个「按注册序猜」的错误默认值。
 *
 * ## 设计：AsyncLocalStorage 会话 scope + 出口包装注入
 *
 * 56 个 `getRoot` 调用点分布在 12 个文件，逐一传 `exec` 属于大面积侵入；
 * `wireGuard`（toolsSlot.ts）是全部工具 execute 的唯一出口包装，在此处用
 * AsyncLocalStorage 把「本次调用的会话工作区」织入，`getRoot` 内部优先读 scope，
 * **签名零变化**。宿主分发（dsh-tools dispatchScheduledExecution → dispatchToolBody
 * → tool.execute）都在同一同步调用栈上，ALS 覆盖完整。
 *
 * ## 降级纪律（宁缺勿猜，INV-27 同族）
 *
 * 1. `exec.agent` 在场 → 探测 `workingDirectory` 服务（ctx.get(name, false)，
 *    不杀 loading 态 fiber）→ `get(session)` 实时值（绝对路径校验由宿主负责）；
 * 2. 降级 `agent.session.header.cwd`（非空字符串才采信）；
 * 3. 两者皆无 → ALS 无值 → getRoot 走原 `resolveWorkspaceRoots` 链（行为不变，
 *    与既有测试/单工作区部署完全兼容）。
 * 解析失败（服务缺席/字段类型不符/抛错）→ 视为「不可知」，绝不让工具调用断流。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 宿主面窄化（房屋风格：不引宿主包，本地窄化）。 */
interface SessionWorkingDirHost {
  /** 宿主 `@deepseek-ai/dsh-working-directory` 服务（gen 0.2.x 在场；缺省探测）。 */
  get?(session: unknown): string | undefined | null;
}

interface AgentWithSession {
  session?: {
    header?: { cwd?: unknown };
  };
}

/** 会话工作区 scope 值。 */
export interface SessionWorkspaceScope {
  /** 实时工作目录（宿主 workingDirectory 服务；null = 降级到 header.cwd）。 */
  readonly live: string | null;
  /** 创建时目录（session.header.cwd；null = 不可知）。 */
  readonly header: string | null;
}

const als = new AsyncLocalStorage<SessionWorkspaceScope>();

/** 宿主 ctx 窄化（get 探测 + workingDirectory 服务直接在场两种形态）。 */
type ProbeCtx = { workingDirectory?: SessionWorkingDirHost } & { get?: <T = unknown>(key: string, strict?: boolean) => T | undefined };

/** 绝对路径才采信（Windows 盘符/UNC 均过 isAbsolute；相对路径不可靠 = 猜）。 */
function plausibleRoot(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(v)) return null;
  return v;
}

/**
 * 从工具执行上下文解析会话工作区（wireGuard 出口每次调用一次）。
 * 返回 null = 不可知（宿主未带 agent / 会话无 cwd / 服务缺席），调用方走原链。
 */
export function resolveSessionWorkspace(exec: unknown, ctx: unknown): SessionWorkspaceScope | null {
  const agent = (exec as { agent?: unknown } | null | undefined)?.agent;
  if (agent === undefined || agent === null) return null;
  // 1) 实时值：宿主 workingDirectory 服务（严格探测避免杀 loading 态 fiber）。
  let live: string | null = null;
  try {
    const c = ctx as ProbeCtx;
    const svc = (typeof c.get === 'function'
      ? c.get<SessionWorkingDirHost | undefined>('workingDirectory', false)
      : undefined) as SessionWorkingDirHost | undefined;
    const session = (agent as AgentWithSession).session;
    if (svc && typeof svc.get === 'function' && session !== undefined) {
      live = plausibleRoot(svc.get(session));
    }
  } catch { /* 服务缺席/抛错 → 降级 header.cwd */ }
  // 2) header.cwd：创建时目录（冻结快照，可能落后于 cd 变更，仍是合法降级）。
  let header: string | null = null;
  try {
    header = plausibleRoot((agent as AgentWithSession).session?.header?.cwd);
  } catch { /* agent 形状不符 → 放弃 */ }
  if (live === null && header === null) return null;
  return { live, header };
}

/**
 * 在「本次工具调用」的会话 scope 内运行 execute（wireGuard 出口接线点）。
 * 无 scope（宿主未带 agent）时直跑，零开销路径。
 */
export function runWithSessionWorkspace<T>(
  scope: SessionWorkspaceScope | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (scope === null) return fn();
  return als.run(scope, fn);
}

/** 当前调用栈的会话工作区（无 scope → null）。 */
export function currentSessionWorkspace(): SessionWorkspaceScope | null {
  return als.getStore() ?? null;
}

/**
 * 会话工作区优先序：实时值 → header.cwd → null（调用方落到原 resolveWorkspaceRoots 链）。
 * 供 tools.ts 的 getRoot 在原链**之前**消费；返回 null 表示「本层不可知」。
 */
export function sessionWorkspaceRoot(): string | null {
  const scope = als.getStore();
  if (!scope) return null;
  return scope.live ?? scope.header;
}

/* ── 宿主 ctx 的模块级持有（从 toolsSlot.ts 上移，守 T3 ≤250 行）─────────── */

/**
 * 会话工作区解析所需的宿主 ctx（用于 `ctx.get('workingDirectory', false)` 探测）。
 *
 * ## 为什么用模块级变量而不是参数穿透
 *
 * `wireGuard` 是全部工具 `execute` 的**唯一出口包装**，但它位于 `toolsSlot.ts`
 * （纯契约层，不持有宿主 ctx）。把 ctx 顺着签名传下去要动 56 个 `getRoot` 调用点
 * 与所有 gateway 签名 —— 那是大面积侵入。
 *
 * ⇒ 由 `tools.ts`（唯一持有 ctx 的聚合层）在注册期注入一次。
 * **只进不改**（重复注册以最后一次为准，与宿主"一个 profile 一个 ctx"一致）。
 *
 * ## 为什么放在本模块而不是 toolsSlot.ts
 *
 * 这一对（`globalSessionCtx` + `setSessionWorkspaceCtx`）属于「会话工作区」这个
 * 概念，不属于「工具槽位契约」。上移之后 `toolsSlot.ts` 回到 250 行以内
 * （T3 机械守卫），而概念内聚性更好 —— 读者找"会话工作区相关的东西"只看本文件。
 */
let globalSessionCtx: unknown = null;

/** `tools.ts` 注册期注入宿主 ctx（只进不改；重复注册以最后一次为准）。 */
export function setSessionWorkspaceCtx(ctx: unknown): void {
  globalSessionCtx = ctx;
}

/** 读回当前注入的 ctx（出口包装层 `resolveSessionWorkspace` 消费）。 */
export function sessionWorkspaceCtx(): unknown {
  return globalSessionCtx;
}

/**
 * 根工作区解析的**唯一顺序**（会话 → 宿主 registry 链）。
 *
 * ## 为什么这个顺序是「多项目隔离」的核心
 *
 * 多工作区宿主里 `workspaceRegistry.list()` 的**首条** ≠ 当前对话工作区
 * （实测 `anic_status` 默认指向 dsh-anic 自己，而非调用方项目）——
 * **会话 scope 才是「当前对话」的真实语义**，registry 序只是注册顺序。
 *
 * ## 降级纪律（宁缺勿猜，INV-27 同族）
 *
 * 两处 `try` 是**降级不是吞错**：ALS 不可用 / 调用方未注入 ctx / registry 抛错，
 * 都只意味着「这个来源给不出答案」⇒ 交给下一个来源，绝不让工具调用断流。
 * 全部来源都给不出 ⇒ `null`（调用方据此返回 412/可执行建议，而不是猜一个路径）。
 *
 * @param registryRoot 宿主 registry 链的解析函数（由调用方提供，避免本模块依赖
 *                     `resolveWorkspaceRoots` 的 ctx 形状 —— 那会把 Runtime 概念
 *                     反向拖进本模块）
 */
export function rootWithSessionFirst(registryRoot: () => string | null): string | null {
  try {
    const sessionRoot = sessionWorkspaceRoot();
    if (sessionRoot) return sessionRoot;
  } catch { /* ALS 不可用 → 原链 */ }
  try {
    return registryRoot();
  } catch {
    return null;
  }
}

/* ── 出口包装器（wireGuard 的唯一消费面）────────────────────────────────── */

/**
 * 工具 execute 的会话 scope 包装器（`wireGuard` 出口注入点）。
 *
 * 职责：从 `exec.agent` 解析会话工作区 → ALS scope 内跑原 execute。
 * 出口 sanitize 仍由 `toolsSlot.wireGuard` 的既有链承担（withArgumentGuard →
 * sanitizeToolValue）——本包装只管 scope，不重复收敛，也不 import 契约层：
 * `toolsSlot.ts` import 本模块（wireGuard 接线），反向 import 即组成环。
 * 结构类型系统下 `ToolExecContextLike` 与 `toolsSlot.ToolExecContext` 可互换。
 */
export function scopedToolExecute(
  inner: (args: Record<string, unknown>, exec?: ToolExecContextLike) => Promise<Record<string, unknown>>,
): (args: Record<string, unknown>, exec?: ToolExecContextLike) => Promise<Record<string, unknown>> {
  return (args, exec) => {
    const scope = resolveSessionWorkspace(exec, sessionWorkspaceCtx());
    return runWithSessionWorkspace(scope, () => inner(args, exec));
  };
}

/** 工具执行上下文的最小形状（结构与 `toolsSlot.ToolExecContext` 对齐，不 import）。 */
interface ToolExecContextLike {
  signal?: AbortSignal;
  agent?: unknown;
}
