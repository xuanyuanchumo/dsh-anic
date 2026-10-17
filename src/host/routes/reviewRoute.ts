/**
 * M4 评审路由 — POST /anic/review。
 *
 * 条件性 LLM 接入：probe → Tier-2 / 降级 → Tier-1。
 * INV-23 fail-closed + INV-24 不进 inject。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeLlm, heuristicReview, type ReviewRequest, type ReviewVerdict } from '../llm/reviewEngine.ts';
import { pickProvider, resolveModel } from '../llm/providerResolve.ts';
import { runLlmReview } from '../llm/reviewTransport.ts';
import { corsHeaders, originFromRes } from '../cors.ts';
import type { AgentCard } from '../agents.ts';
import { t } from '../i18n.ts';

const REVIEW_ROUTE = '/anic/review';

interface ReviewBody {
  gate?: unknown;
  role?: unknown;
  evidence?: unknown;
  provider?: unknown;
  model?: unknown;
}

function isReviewBody(raw: unknown): raw is ReviewBody {
  return raw !== null && typeof raw === 'object';
}

/** 注册评审路由 */
export function registerReviewRoute(
  register: (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void,
  opts: {
    getAgentCards: () => Map<string, AgentCard>;
    probeCtx: unknown; // 宿主 ctx（用于 probeLlm）
    defaultProvider?: string;
    defaultModel?: string;
  },
): void {
  register('POST', REVIEW_ROUTE, async (req, res) => {
    try {
    // 读 body
    let bodyText = '';
    for await (const chunk of req) {
      bodyText += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_JSON', message: t('review.badJson') }));
      return;
    }
    if (!isReviewBody(body) || typeof body.gate !== 'string' || typeof body.role !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_REQUEST', message: t('review.missingFields') }));
      return;
    }
    const gate = body.gate;
    const role = body.role;
    const evidence = Array.isArray(body.evidence)
      ? (body.evidence as unknown[]).filter(
          (e): e is { id: string; content: string } =>
            e !== null && typeof e === 'object' &&
            typeof (e as Record<string, unknown>).id === 'string' &&
            typeof (e as Record<string, unknown>).content === 'string',
        )
      : [];

    const cardId = `anic.agent.${gate}.${role}`;
    const cards = opts.getAgentCards();
    const card = cards.get(cardId);
    if (card === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AGENT_NOT_FOUND', message: t('review.cardNotFound', { cardId }) }));
      return;
    }

    const request: ReviewRequest = { gate, role, evidence };

    // 探测 LLM
    const runtime = probeLlm(opts.probeCtx);
    let verdict: ReviewVerdict;
    // 动态白盒：宿主 provider 情况进响应（Tier-2 判定依据可诊断——
    // 测试宿主常见「default provider 返回空流」，没有此字段就只能猜）。
    let providers: string[] = [];

    if (runtime !== null) {
      try { providers = runtime.listProviders().map((p) => p.id); } catch { providers = []; }
      // cycle-9：'default' 不是真实 provider/model id（真机取证）；显式指定 >
      // 注册表首条 > 宿主目录首条 > 字面兜底（由宿主给出诚实错误，ANIC 不猜）
      const provider = pickProvider(runtime, typeof body.provider === 'string' ? body.provider : opts.defaultProvider);
      const model = await resolveModel(runtime, provider, typeof body.model === 'string' ? body.model : opts.defaultModel);
      verdict = await runLlmReview(runtime, card, request, provider, model);
    } else {
      // 降级 Tier-1
      verdict = heuristicReview(request);
    }

    // P0-8 残留修复（cycle-9）：本文件自写响应头，cycle-6 的 CORS 修复只覆盖了
    // sendJson 路径 —— 此处的 '*' 是漏网。评审响应含 agent 卡提示词与裁决，
    // 属真实跨站读泄露面。改 corsHeaders：仅回环/显式白名单回显具体 Origin。
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...corsHeaders(originFromRes(res)),
      'X-ANIC-Review-Tier': verdict.tier,
    });
    // providers 是诊断字段（动态白盒）：Tier-2 判定依据（宿主有哪些 provider）
    // 随裁决一并可见，不再需要翻宿主日志。
    res.end(JSON.stringify({ ...verdict, providers }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }));
    }
  });
}
