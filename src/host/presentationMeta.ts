/**
 * presentationMeta 投影器（cycle-101 · 官方 ToolOutputDefinition.presentationMeta 对齐）。
 *
 * 官方契约（kb: site/reference/subsystems/tools.md:19-26 + adding-a-tool.md:93）：
 *   meta 由 output.presentationMeta(args, value) 派生并**持久化在 result.meta**，
 *   回放（直播流/日志重放）时重现——意味着呈现所需的一切事实必须进 meta，
 *   而不是回放时重新计算（回放时原始 value 可能已不可得）。
 *
 * dsh-anic 现状缺口（cycle-100 审计）：terminalResult 从 handler 返回值里
 * **现场**提取 exitCode/signal——直播时没问题，但回放走的是持久化 meta 通道，
 * 时长（durationMs）这类"只在完成瞬间存在"的事实从未被持久化 ⇒ 回放丢真。
 *
 * 本模块职责（纯函数，零 I/O——官方硬性规则）：
 *   1. buildPresentationMeta：从 handler 规范值提取应持久化的呈现事实
 *      （exitCode/signal/durationMs/cancelled）——execute 侧接线；
 *   2. mergePresentationMeta：回放侧把持久化 meta 归并进视图提取
 *      （normalizeToolResult 的 meta 已含这些字段，terminalResult 顺势消费）。
 *
 * 数学模型：投影 = 选择 ∘ 投影 ∘ 归一（select→project→normalize），
 * 选择是白名单式（不透传未知字段——meta 是契约不是垃圾桶）。
 */

/** 应持久化的呈现事实白名单。 */
export interface AnicPresentationMeta {
  /** 进程退出码（信号终止时为 null——诚实区分 0 与"没跑完"）。 */
  exitCode?: number | null;
  /** 信号名（SIGTERM/SIGKILL/…），非信号终止不设。 */
  signal?: string;
  /** 端到端耗时 ms（完成瞬间才存在的事实——回放重建的关键）。 */
  durationMs?: number;
  /** 调用方取消（工具级 signal 触发）标记。 */
  cancelled?: boolean;
  /** 脚本名（anic_skill 域——回放时标题重建的语义键）。 */
  script?: string;
}

/**
 * 从 handler 返回值提取持久化 meta（execute 侧调用，随 result.meta 落盘）。
 * 只挑白名单字段：durationMs 只在调用方给了才设（不给就不伪造）。
 */
export function buildPresentationMeta(
  result: Record<string, unknown>,
  extra: { script?: string; startedAt?: number } = {},
): AnicPresentationMeta {
  const meta: AnicPresentationMeta = {};
  const exit = result.exitCode;
  if (typeof exit === 'number') meta.exitCode = exit;
  else if (exit === null) meta.exitCode = null;
  if (typeof result.signal === 'string' && result.signal) meta.signal = result.signal;
  if (result.cancelled === true) meta.cancelled = true;
  if (typeof extra.script === 'string') meta.script = extra.script;
  if (typeof extra.startedAt === 'number' && Number.isFinite(extra.startedAt)) {
    const d = Date.now() - extra.startedAt;
    if (d >= 0) meta.durationMs = d;
  }
  return meta;
}

/**
 * 回放侧归并：normalizeToolResult 已把 meta 字段平铺进视图提取源——
 * 本函数做**形状守卫**：白名单外的字段不透传（meta 是契约不是垃圾桶），
 * 类型不对的字段丢弃（持久化层可能被旧版本写坏——防御性读取）。
 */
export function mergePresentationMeta(
  raw: Record<string, unknown> | undefined,
): AnicPresentationMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: AnicPresentationMeta = {};
  const exit = raw['exitCode'];
  if (typeof exit === 'number') out.exitCode = exit;
  else if (exit === null) out.exitCode = null;
  const signal = raw['signal'];
  if (typeof signal === 'string' && signal) out.signal = signal;
  const d = raw['durationMs'];
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) out.durationMs = d;
  if (raw['cancelled'] === true) out.cancelled = true;
  const script = raw['script'];
  if (typeof script === 'string' && script) out.script = script;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * meta → 人类可读 marker 行（dsh-ops 信封双消费模式：JSON 之外再渲染
 * grep 友好的方括号尾巴，渲染端与解析端同一契约）。
 * 形如 `[exit 0 · 12.3s]` / `[exit null · SIGTERM · cancelled]`。
 */
export function renderMetaMarker(meta: AnicPresentationMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.exitCode !== undefined) parts.push(meta.exitCode === null ? 'exit null' : `exit ${meta.exitCode}`);
  if (meta.signal) parts.push(meta.signal);
  if (meta.cancelled) parts.push('cancelled');
  if (typeof meta.durationMs === 'number') {
    parts.push(meta.durationMs >= 1000 ? `${(meta.durationMs / 1000).toFixed(1)}s` : `${Math.round(meta.durationMs)}ms`);
  }
  return parts.length > 0 ? `[${parts.join(' · ')}]` : undefined;
}
