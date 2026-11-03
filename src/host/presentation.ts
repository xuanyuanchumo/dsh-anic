/**
 * 工具呈现视图助手（M10-d 技能优先面）。
 *
 * 为 dsh-anic 工具构造 DSH ToolCallView / ToolResultView，
 * 使大模型调用 anic_* 工具时 DSH UI 能透明呈现：
 * - pending 状态：终端卡片（命令 + 工作目录）
 * - completed 状态：终端结果卡片（输出 + 退出码）
 *
 * 纯函数无副作用，可被 presentCall/presentResult 安全调用。
 */

import type {
  TerminalCallView,
  TerminalResultView,
  GenericCallView,
  GenericResultView,
  ToolCallKind,
} from './toolsSlot.ts';
import { t } from './i18n.ts';
import { buildPresentationMeta, mergePresentationMeta, renderMetaMarker } from './presentationMeta.ts';

/**
 * cycle-99c：终端输出显示净化（模型侧不清洗——清洗只发生在呈现层）。
 *
 * 官方契约（adding-a-tool.md:93）：presentResult 原样携带输出，UI 适配器负责
 * 呈现格式。但宿主 TerminalResultView 直渲染 output 文本，vitest 等子进程在
 * 非 TTY 下仍可能写 ANSI 转义码，终端卡片显示成乱码。本函数在**呈现视图
 * 构造**处剥离 SGR/光标/OSC/DCS 序列与孤立回车。纯函数（正则替换，无 I/O）。
 */
const ESC = String.fromCharCode(0x1b);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'); // CSI … 终结（SGR/光标/滚动）
const OSC_RE = new RegExp(`${ESC}\\].*?(?:${ESC}\\\\|${String.fromCharCode(7)})`, 'gs'); // OSC … ST/BEL
const DCS_RE = new RegExp(`${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`, 'g'); // DCS/SOS/PM/APC … ST
const ESC1_RE = new RegExp(`${ESC}[=>NOMc78]`, 'g'); // 单字符 Esc 序列（Shift-In 等）

export function stripAnsiEscapeSequences(text: string): string {
  return text
    .replace(CSI_RE, '')
    .replace(OSC_RE, '')
    .replace(DCS_RE, '')
    .replace(ESC1_RE, '')
    .replace(/\r(?!\n)/g, '');
}

/** 诚实截断（dsh-ops 模式）：截断时在尾部声明实情，不假装内容完整。 */
export function truncateWithNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n-- output truncated (${text.length - maxChars} chars omitted; full output in .cycles/flow-tracker.json flow records) --`;
}

/**
 * cycle-22：presentResult 第二参双形状归一化（官方契约对齐）。
 *
 * 官方（adding-a-tool.md）：presentResult(args, { content, isError, meta? }) —
 * content 是模型可见内容块数组，meta 由 output.presentationMeta 派生并持久化
 * 在 result.meta，回放时重现。
 * 宿主现状（0.2.0-rc.2 实测，见 docs/agents/可观测性与轨迹可见性.md:11）：
 * 直接传原始 execute 返回值（{ exitCode, stdout, ... } 宽容形状）。
 *
 * 本函数两形状都吃：
 * - 官方形状：从 meta 提取持久化事实（exitCode/stdout/stderr），缺失时从
 *   content 文本块兜底（渲染层展示原文，不丢失结果信息）；
 * - 宽容形状：原样返回（宿主直传）。
 * 纯函数：不做 I/O、不读会话状态——官方硬性规则。
 */
export function normalizeToolResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  // 官方形状判定：content 是数组（ContentBlock[]）——宽容形状不会有 content 数组
  const content = result.content;
  if (Array.isArray(content)) {
    const meta = (result.meta && typeof result.meta === 'object')
      ? (result.meta as Record<string, unknown>)
      : {};
    const out: Record<string, unknown> = { ...meta, isError: result.isError === true };
    // meta 无 stdout 时从内容块兜底（text 块拼接）——结果文本不丢。
    // cycle-101 修正：判据从「meta 无 exitCode」改为「meta 无 stdout」——
    // presentationMeta 通道只持久化 exitCode/durationMs 等事实、不携带 stdout，
    // 旧判据会把回放正文的兜底一起抑制（marker 有、正文丢）。
    if (typeof out.stdout !== 'string' && !('stdout' in meta)) {
      const text = content
        .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : ''))
        .join('\n');
      if (text) out.stdout = text;
    }
    return out;
  }
  return result;
}

/**
 * 构造终端调用视图（pending 状态）。
 * 用于脚本执行类工具（anic_skill/anic_evaluate/anic_iterate 等）。
 * cycle-39 T-3914：summary → description（官方 TerminalCallView 字段名）。
 */
export function terminalCall(
  title: string,
  cwd: string,
  description?: string,
): TerminalCallView {
  return { card: 'terminal', title, cwd, description };
}

/**
 * 构造终端结果视图（completed 状态）。
 * 将 handler 返回的 { exitCode, stdout, stderr } 映射为终端卡片。
 * cycle-22：入参先过 normalizeToolResult（官方 {content,isError,meta} 形状
 * 与宿主宽容直传形状双兼容——0.3+ 宿主收紧传参形状时不再碎）。
 */
export function terminalResult(
  result: Record<string, unknown>,
  title?: string,
): TerminalResultView {
  const r = normalizeToolResult(result);
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  // cycle-101（presentationMeta 投影器）：meta 通道优先——官方契约规定 meta 由
  // output.presentationMeta 派生并**持久化**，回放时原始 value 可能已不可得。
  // 提取顺序：持久化 meta（回放重建路径）→ 现场返回值（直播路径）。两者互为兜底。
  const meta = mergePresentationMeta(result.meta as Record<string, unknown> | undefined);
  const exitCode = meta ? (meta.exitCode ?? undefined) : (typeof r.exitCode === 'number' ? r.exitCode : undefined);
  const signal = meta ? meta.signal : (typeof r.signal === 'string' ? r.signal : undefined);
  const raw = stderr ? `${stdout}\n-- stderr --\n${stderr}` : stdout;
  // cycle-99c：显示净化——剥离 ANSI 转义码（vitest 等子进程在非 TTY 下仍可能写
  // SGR 序列，flow 记录实证乱码）与孤立 \r（进度条回车重绘），再诚实截断。
  // 只作用于呈现视图；execute 返回的 stdout/stderr（模型可见内容）保持原样。
  let output = truncateWithNotice(stripAnsiEscapeSequences(raw), 12000);
  // dsh-ops 信封双消费：output 尾部追加 meta marker（[exit 0 · 12.3s]）——
  // grep 友好，回放时即使视图字段被宿主裁剪 marker 仍在文本里。
  const marker = renderMetaMarker(meta);
  if (marker && output) output = `${output}\n${marker}`;
  else if (marker) output = marker;
  return { card: 'terminal', title, output: output || undefined, exitCode, signal };
}

/**
 * 构造通用调用视图（pending 状态）。
 * 用于非脚本类工具（anic_status/anic_snapshot 等）。
 */
export function genericCall(
  title: string,
  kind: ToolCallKind = 'other',
  rawInput?: unknown,
): GenericCallView {
  return { card: 'generic', title, kind, rawInput };
}

/**
 * 构造通用结果视图（completed 状态）。
 */
export function genericResult(title?: string): GenericResultView {
  return { card: 'generic', title };
}

/**
 * anic_skill presentCall：终端卡片显示脚本名 + 工作目录。
 */
export function skillPresentCall(args: Record<string, unknown>): TerminalCallView {
  const script = typeof args.script === 'string' ? args.script : '?';
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  return terminalCall(`anic_skill: ${script}`, workspace, t('presentation.skillSummary', { script }));
}

/**
 * anic_skill presentResult：终端结果卡片显示输出 + 退出码。
 * cycle-101：result.meta（presentationMeta 通道）优先——回放重建路径。
 */
export function skillPresentResult(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): TerminalResultView {
  const script = typeof _args.script === 'string' ? _args.script : '?';
  return terminalResult(result, `anic_skill: ${script} ✓`);
}

/**
 * cycle-101：anic_skill execute 侧 meta 构造——把应持久化的呈现事实
 * （exitCode/signal/durationMs/script）打进返回值的 meta 字段。
 * 宿主把 output.presentationMeta 派生的 meta 持久化在 result.meta，
 * 回放时 presentation.ts 的 meta 通道据此重建视图。
 * 纯函数：startedAt 由调用方传入（handler 知道开始时刻，本函数不读时钟）。
 */
export function skillResultWithMeta(
  result: Record<string, unknown>,
  opts: { script: string; startedAt?: number },
): Record<string, unknown> {
  return { ...result, meta: buildPresentationMeta(result, opts) };
}

/**
 * anic_evaluate presentCall：终端卡片显示评估维度 + 工作目录。
 */
export function evaluatePresentCall(args: Record<string, unknown>): TerminalCallView {
  const dims = typeof args.dimensions === 'string' ? args.dimensions : 'all';
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  return terminalCall(`anic_evaluate [${dims}]`, workspace, t('presentation.evaluateSummary'));
}

/**
 * anic_iterate presentCall：终端卡片显示迭代循环。
 */
export function iteratePresentCall(args: Record<string, unknown>): TerminalCallView {
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  return terminalCall('anic_iterate', workspace, t('presentation.iterateSummary'));
}

/**
 * anic_bootstrap_cycle presentCall：终端卡片显示自举循环。
 */
export function bootstrapCyclePresentCall(args: Record<string, unknown>): TerminalCallView {
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  const maxRounds = typeof args.maxRounds === 'number' ? args.maxRounds : 3;
  return terminalCall(t('presentation.bootstrapCycleTitle', { maxRounds }), workspace, t('presentation.bootstrapCycleSummary'));
}

/**
 * anic_bootstrap_analyze presentCall：终端卡片显示自举分析。
 */
export function bootstrapAnalyzePresentCall(args: Record<string, unknown>): TerminalCallView {
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  return terminalCall('anic_bootstrap_analyze', workspace, t('presentation.bootstrapAnalyzeSummary'));
}

/**
 * anic_status presentCall：通用卡片显示状态查询。
 */
export function statusPresentCall(args: Record<string, unknown>): GenericCallView {
  const workspace = typeof args.workspace === 'string' ? args.workspace : '.';
  return genericCall('anic_status', 'read', { workspace });
}
