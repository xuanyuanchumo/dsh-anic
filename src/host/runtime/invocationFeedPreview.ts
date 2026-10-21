/**
 * tools/result 载荷的结果预览提取（cycle-48 T-4801）。
 *
 * 从 invocationFeed.ts 拆出（同域拆分纪律：宿主侧 feed 主体触 250 行）。
 * 权威契约（宿主 asar 考古 dsh-tools/lib/types/index.js materializeFinalResult，
 * tools/result 派发前调用一次）：
 *   result = { content: ContentBlock[], meta?, additionalContexts?,
 *              isError: boolean, error?(isError), concludesTurn?, value }
 * —— content 是模型可见内容块数组；文本内容在 type==='text' 块的 .text；
 *    value 是工具原始返回值；meta 由 output.presentationMeta 派生并持久化。
 */
/** 截断原始串：保留头部 200 字符 + 省略标记（argumentsPreview/resultPreview 共用契约）。 */
export function previewOf(raw: string): string {
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/**
 * 提取策略（presentation.ts normalizeToolResult 同构模式）：
 *   1. content 数组的 text 块拼接（换行连接）——官方形状主路径；
 *   2. content 非数组（宽容/旧宿主形状）→ 尝试 value 字符串化兜底；
 *   3. isError 不提取（error 三元组在渲染层已有专属行，避免重复呈现）；
 *   4. 空结果返回 undefined（字段缺省，客户端不渲染——不伪造空预览）。
 * 纯函数：不触碰 result 对象（宿主已 deepFreeze，任何写访问都会抛）。
 */
export function extractResultPreview(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { content?: unknown; isError?: unknown; value?: unknown };
  if (r.isError === true) return undefined;
  if (Array.isArray(r.content)) {
    const text = contentText(r.content);
    return text ? previewOf(text) : undefined;
  }
  // 宽容形状兜底：value 是工具原始返回值（官方契约字段），仅字符串/可安全
  // 字符串化对象提取，其余（undefined/函数等）不给预览。
  if (typeof r.value === 'string' && r.value) return previewOf(r.value);
  if (r.value && typeof r.value === 'object') {
    try { return previewOf(JSON.stringify(r.value)); } catch { return undefined; }
  }
  return undefined;
}

/** content 文本块拼接（空文本归 ''，块间换行）。 */
function contentText(blocks: unknown[]): string {
  return blocks
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
      ? String((b as { text?: unknown }).text ?? '')
      : ''))
    .join('\n');
}
