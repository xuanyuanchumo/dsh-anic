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
    // meta 无输出时从内容块兜底（text 块拼接）——结果文本不丢
    if (typeof out.stdout !== 'string' && !('exitCode' in meta)) {
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
  const exitCode = typeof r.exitCode === 'number' ? r.exitCode : undefined;
  const output = stderr ? `${stdout}\n-- stderr --\n${stderr}` : stdout;
  return { card: 'terminal', title, output: output || undefined, exitCode };
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
 */
export function skillPresentResult(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): TerminalResultView {
  const script = typeof _args.script === 'string' ? _args.script : '?';
  return terminalResult(result, `anic_skill: ${script} ✓`);
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
