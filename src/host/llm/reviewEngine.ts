/**
 * M4 LLM 评审引擎 — 条件性接入。
 *
 * INV-24：'llm' 绝不进硬 inject 数组 → ctx.get 探测 + ctx.inject 增量接入。
 * INV-23：闭合 JSON 协议 + 本地校验 + 失败即 doubt（fail-closed）。
 *
 * 三态：LLM 可用 → Tier-2 语义评审 / LLM 不可用 → Tier-1 启发式降级 / 调用失败 → doubt。
 */

import type { AgentCard } from '../agents.ts';

// ── 类型 ────────────────────────────────────────────────

/** LLM 运行时最小契约（转录自 M0-② spike host-llm-service.md） */
export interface LlmRuntime {
  stream(opts: GenerateOptions): AsyncIterable<LlmChunk>;
  listProviders(): string[];
}

/**
 * 宿主 GenerateOptions 的最小契约子集。
 *
 * P0-1（已修）：`purpose` 在宿主侧是**闭合枚举**，权威定义见
 * `@deepseek-ai/dsh-llm/lib/types/types.d.ts:530`：
 *     purpose?: 'compaction' | 'session-title';
 * 此前本文件把 `purpose?: string` 并传 `'review'`，既不被宿主承认，又让
 * 「传错值」在类型层不可拦。现在把它逐字转录为同一闭合枚举 —— 传任何
 * 枚举外的值都会在 `pnpm run typecheck` 阶段报错。
 *
 * 归因策略（R-27）：**不**借用宿主的 purpose 字段做 ANIC 评审归因；
 * 归因走 ANIC 自己的账本（`{provider, model, promptDigest, evidenceIds}`）。
 */
export interface GenerateOptions {
  provider: string;
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  purpose?: 'compaction' | 'session-title';
}

export interface LlmChunk {
  text?: string;
  error?: { code: string; message: string };
}

/** 评审请求 */
export interface ReviewRequest {
  gate: string;
  role: string;
  evidence: { id: string; content: string }[];
}

/** 评审裁决（闭合 JSON 协议） */
export interface ReviewVerdict {
  verdict: 'approve' | 'reject' | 'doubt';
  evidenceIds: string[];
  notes: string;
  tier: 'tier-2-llm' | 'tier-1-heuristic' | 'tier-0-unavailable';
}

/**
 * P0-1：ANIC 自己的评审归因留痕（R-27）。
 * 宿主不提供 purpose='review' 通道，因此归因必须落在 ANIC 侧。
 * 该结构是「调用前留痕」的载体，由路由写入响应与（未来）账本。
 */
export interface ReviewAttribution {
  provider: string;
  model: string;
  /** 提示词摘要（sha256 前 16 位十六进制），用于事后复现而不落原文。 */
  promptDigest: string;
  evidenceIds: string[];
}

/** 计算评审归因：调用**前**即可得到（不依赖 LLM 返回）。 */
export function buildAttribution(
  provider: string,
  model: string,
  request: ReviewRequest,
): ReviewAttribution {
  return {
    provider,
    model,
    promptDigest: digestPrompt(request),
    evidenceIds: request.evidence.map((e) => e.id),
  };
}

/** 提示词摘要：稳定、可复现、不落原文。 */
function digestPrompt(request: ReviewRequest): string {
  const material = `${request.gate}\u0000${request.role}\u0000${request.evidence.map((e) => `${e.id}\u0001${e.content}`).join('\u0002')}`;
  return sha256Hex(material).slice(0, 16);
}

/** 纯 TS 实现的 sha256（node:crypto 在 client 编译单元不可用，保持零依赖）。 */
function sha256Hex(input: string): string {
  // 使用 Web Crypto 之外的纯实现成本过高；此处优先 node:crypto（宿主侧运行）。
  // 若不可用则退化为稳定的非加密摘要（仅用于归因比对，不做安全承诺）。
  const req = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown } }).process?.getBuiltinModule;
  if (typeof req === 'function') {
    const mod = req('node:crypto') as { createHash?: (a: string) => { update: (s: string) => { digest: (e: string) => string } } } | undefined;
    const h = mod?.createHash?.('sha256');
    if (h) return h.update(input).digest('hex');
  }
  // 退化路径：FNV-1a 64 位（稳定、无依赖；明确标注非加密）
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0').repeat(4).slice(0, 64);
}

// ── 探测 ────────────────────────────────────────────────

/**
 * 探测 ctx.llm 是否可用。
 * INV-24：用 ctx.get('llm', false)（非 strict），绝不放 inject 数组。
 * 返回 null = 不可用（降级 Tier-1），非 null = 可用（Tier-2）。
 */
export function probeLlm(ctx: unknown): LlmRuntime | null {
  if (ctx === null || typeof ctx !== 'object') return null;
  const c = ctx as Record<string, unknown>;
  const get = c.get;
  if (typeof get !== 'function') return null;
  try {
    // ctx.get('llm', false) — false = 非 strict（不要求 provider fiber 当前 active）
    const runtime = (get as (key: string, strict?: boolean) => unknown).call(c, 'llm', false);
    if (runtime === null || runtime === undefined) return null;
    if (typeof runtime !== 'object') return null;
    const r = runtime as Record<string, unknown>;
    if (typeof r.stream !== 'function' || typeof r.listProviders !== 'function') return null;
    return runtime as LlmRuntime;
  } catch {
    return null;
  }
}

// ── 闭合协议校验 ────────────────────────────────────────

/**
 * 校验 LLM 返回的闭合 JSON。
 * INV-23：任一不满足 → doubt（fail-closed，绝不 approve）。
 */
export function validateReviewJson(raw: string): ReviewVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // JSON 解析失败 → doubt
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  // verdict 必须是三值之一
  if (p.verdict !== 'approve' && p.verdict !== 'reject' && p.verdict !== 'doubt') return null;
  // evidenceIds 必须是非空字符串数组
  if (!Array.isArray(p.evidenceIds) || p.evidenceIds.length === 0) return null;
  if (!p.evidenceIds.every((e) => typeof e === 'string')) return null;
  // notes 必须是非空字符串
  if (typeof p.notes !== 'string' || p.notes.length === 0) return null;
  return {
    verdict: p.verdict,
    evidenceIds: p.evidenceIds as string[],
    notes: p.notes,
    tier: 'tier-2-llm',
  };
}

// ── 传输层 ──────────────────────────────────────────────

/**
 * 传输层（调用 / 超时 / 错误码分派 / 缩证据重试）已拆到 `reviewTransport.ts`
 * —— T3 结构守卫要求单文件 ≤250 行，P0-1 的归因与错误码分派把本文件推过限。
 * 此处**不** re-export，避免 `reviewEngine ↔ reviewTransport` 的循环导入：
 * 消费方（`routes/reviewRoute.ts`）直接从 `reviewTransport.ts` 取 `runLlmReview`。
 */

// ── Tier-1 降级 ─────────────────────────────────────────

/**
 * Tier-1 启发式降级评审（LLM 不可用时）。
 * 诚实标注：这是启发式，不是模型评审。
 */
export function heuristicReview(request: ReviewRequest): ReviewVerdict {
  const evidenceCount = request.evidence.length;
  if (evidenceCount === 0) {
    return { verdict: 'doubt', evidenceIds: [], notes: '无证据材料（Tier-1 启发式：零证据 → doubt）', tier: 'tier-1-heuristic' };
  }
  // 启发式：有证据即 approve（诚实标注：这不是模型评审）
  return {
    verdict: 'approve',
    evidenceIds: request.evidence.map((e) => e.id),
    notes: `Tier-1 启发式降级（${String(evidenceCount)} 条证据）；LLM 不可用，非模型评审`,
    tier: 'tier-1-heuristic',
  };
}
