/**
 * LLM 评审传输层 —— 调用、超时、错误码分派、缩证据重试。
 *
 * 从 `reviewEngine.ts` 拆分而来（T3 结构守卫：单文件 ≤250 行）。
 * 拆分边界是「**怎么把请求发出去**」与「**协议与降级**」：
 *   - 本文件：stream 调用、超时竞速、错误码分派、缩证据重试
 *   - reviewEngine.ts：类型契约、ctx.llm 探测、闭合 JSON 校验、Tier-1 降级、归因
 *
 * fail-closed 纪律（INV-23）在本层同样成立：任何异常路径都返回 doubt，
 * 绝不返回 approve。
 */

import type { AgentCard } from '../agents.ts';
import { validateReviewJson } from './reviewEngine.ts';
import type { LlmChunk, LlmRuntime, ReviewRequest, ReviewVerdict } from './reviewEngine.ts';

const REVIEW_TIMEOUT_MS = 30_000;

/**
 * P0-1 / F39：宿主错误码分派表。
 *
 * 权威来源：`@deepseek-ai/dsh-llm/lib/types/error.d.ts` 与 adapter-failure.d.ts
 * 暴露的失败码族。此处按「可恢复性」分三类：
 *   - 可重试（缩证据）：上下文窗口超限 → 丢掉最旧证据后重试一次
 *   - 不可重试（配额/无适配器）：立即 doubt，不再消耗配额
 *   - 未知：doubt 并原样透传码（绝不吞掉证据）
 */
const RETRYABLE_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_LENGTH_EXCEEDED', 'TOO_MANY_TOKENS']);
const NO_RETRY_CODES = new Set(['NO_ADAPTER', 'QUOTA_EXCEEDED', 'QUOTA_EXHAUSTED', 'RATE_LIMITED', 'AUTH_FAILED']);

/** 证据裁剪：保留最新的 N 条（上下文超限时重试用）。 */
function shrinkEvidence(request: ReviewRequest, keep: number): ReviewRequest {
  if (request.evidence.length <= keep) return request;
  return { ...request, evidence: request.evidence.slice(-keep) };
}

/**
 * 执行 LLM 评审。
 * fail-closed：任何异常 → doubt（绝不 approve）。
 *
 * P0-1：不传 `purpose`（宿主闭合枚举只认 'compaction' | 'session-title'，
 * 'review' 不被承认）。归因改由 `buildAttribution()` 在 ANIC 侧留痕。
 */
export async function runLlmReview(
  runtime: LlmRuntime,
  card: AgentCard,
  request: ReviewRequest,
  provider: string,
  model: string,
): Promise<ReviewVerdict> {
  const first = await attemptReview(runtime, card, request, provider, model);
  if (first.retryable && request.evidence.length > 1) {
    // 上下文超限 → 缩证据重试一次（F39 要求）
    const shrunk = shrinkEvidence(request, Math.max(1, Math.floor(request.evidence.length / 2)));
    const second = await attemptReview(runtime, card, shrunk, provider, model);
    return {
      ...second.verdict,
      notes: `${second.verdict.notes}（已缩证据重试：${String(request.evidence.length)}→${String(shrunk.evidence.length)} 条）`,
    };
  }
  return first.verdict;
}

/** 单次评审尝试，附带错误码分派元信息。 */
async function attemptReview(
  runtime: LlmRuntime,
  card: AgentCard,
  request: ReviewRequest,
  provider: string,
  model: string,
): Promise<{ verdict: ReviewVerdict; retryable: boolean }> {
  const evidenceText = request.evidence.map((e) => `[${e.id}] ${e.content}`).join('\n');

  const messages = [
    { role: 'system' as const, content: card.systemPrompt },
    { role: 'user' as const, content: `门：${request.gate}\n角色：${request.role}\n\n证据材料：\n${evidenceText}` },
  ];

  let rawText = '';
  try {
    // 注意：此处**不传** purpose —— 见函数头 P0-1 说明。
    const iter = runtime.stream({ provider, model, messages });
    const chunks = await Promise.race([
      collectStream(iter),
      new Promise<LlmChunk[]>((_, reject) =>
        setTimeout(() => reject(new Error('REVIEW_TIMEOUT')), REVIEW_TIMEOUT_MS),
      ),
    ]);
    for (const chunk of chunks) {
      if (chunk.error) {
        const code = chunk.error.code;
        // 不可重试码：立即 doubt，不消耗额外配额（F39 错误码分派）
        const noRetry = NO_RETRY_CODES.has(code);
        return {
          verdict: {
            verdict: 'doubt',
            evidenceIds: [],
            notes: `LLM error[${code}]${noRetry ? '（不可重试）' : ''}: ${chunk.error.message}`,
            tier: 'tier-2-llm',
          },
          retryable: !noRetry && RETRYABLE_CODES.has(code),
        };
      }
      if (chunk.text) rawText += chunk.text;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      verdict: { verdict: 'doubt', evidenceIds: [], notes: `LLM 调用失败：${msg}`, tier: 'tier-2-llm' },
      retryable: false,
    };
  }

  const validated = validateReviewJson(rawText);
  if (validated !== null) return { verdict: validated, retryable: false };

  // fail-closed：无法解析 → doubt
  return {
    verdict: {
      verdict: 'doubt',
      evidenceIds: [],
      notes: 'LLM 返回不符合闭合 JSON 协议（fail-closed → doubt）',
      tier: 'tier-2-llm',
    },
    retryable: false,
  };
}

/** 辅助：将 AsyncIterable 收集为数组（与 timeout race） */
async function collectStream(iter: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}
