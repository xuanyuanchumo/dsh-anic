/**
 * M4 评审路由 — POST /anic/review。
 *
 * 条件性 LLM 接入：probe → Tier-2 / 降级 → Tier-1。
 * INV-23 fail-closed + INV-24 不进 inject。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { anicError } from './envelope.ts';
import { join } from 'node:path';
import {
  probeLlm,
  heuristicReview,
  buildAttribution,
  type ReviewAttribution,
  type ReviewRequest,
  type ReviewVerdict,
} from '../llm/reviewEngine.ts';
import { pickProvider, resolveModel } from '../llm/providerResolve.ts';
import { runLlmReview } from '../llm/reviewTransport.ts';
import { corsHeaders, originFromRes } from '../cors.ts';
import type { AgentCard } from '../agents.ts';
import { t } from '../i18n.ts';
import {
  appendReviewRecord,
  findLatestReview,
  loadReviewRecords,
  reviewFreshness,
  type ReviewFreshness,
} from '../llm/reviewLedger.ts';

const REVIEW_ROUTE = '/anic/review';

/** 上一次结论的视图（只暴露审计所需字段，不落证据正文）。 */
interface ReviewRecordView {
  verdict: 'approve' | 'reject' | 'doubt';
  tier: string;
  evidenceDigest: string;
  evidenceIds: string[];
  timestamp: string;
}

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
    /** 工作区根解析（可选：缺省时评审照常返回，只是不落结论账本）。 */
    getWorkspaceRoot?: () => string | null;
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
      res.end(JSON.stringify(anicError('ANIC_ROUTE_BAD_REQUEST', t('review.badJson'))));
      return;
    }
    if (!isReviewBody(body) || typeof body.gate !== 'string' || typeof body.role !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anicError('ANIC_ROUTE_BAD_REQUEST', t('review.missingFields'))));
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
      res.end(JSON.stringify(anicError('ANIC_SKILL_UNKNOWN_SCRIPT', t('review.cardNotFound', { cardId }))));
      return;
    }

    const request: ReviewRequest = { gate, role, evidence };

    // 探测 LLM
    const runtime = probeLlm(opts.probeCtx);
    let verdict: ReviewVerdict;
    // 动态白盒：宿主 provider 情况进响应（Tier-2 判定依据可诊断——
    // 测试宿主常见「default provider 返回空流」，没有此字段就只能猜）。
    let providers: string[] = [];

    // P0-1 归因留痕（cycle-38 接线）：ReviewAttribution 此前只有定义没有消费方，
    // 属于「注释即契约」的未兑现项。归因在**调用前**即可算出（provider/model/
    // 提示词摘要/证据 id 集合），与 LLM 是否成功无关——正是这一点使它可用于
    // 事后复现：同样的 (provider, model, promptDigest, evidenceIds) 能判断两次
    // 评审是不是同一个请求，而不需要落提示词原文（digest 是 sha256 前 16 位）。
    // Tier-1 路径没有真实调用，provider/model 记为 'none'，不伪造。
    let attribution: ReviewAttribution;

    if (runtime !== null) {
      try { providers = runtime.listProviders().map((p) => p.id); } catch { providers = []; }
      // cycle-9：'default' 不是真实 provider/model id（真机取证）；显式指定 >
      // 注册表首条 > 宿主目录首条 > 字面兜底（由宿主给出诚实错误，ANIC 不猜）
      const provider = pickProvider(runtime, typeof body.provider === 'string' ? body.provider : opts.defaultProvider);
      const model = await resolveModel(runtime, provider, typeof body.model === 'string' ? body.model : opts.defaultModel);
      attribution = buildAttribution(provider, model, request);
      verdict = await runLlmReview(runtime, card, request, provider, model);
    } else {
      // 降级 Tier-1：没有真实调用，归因如实记为 none（不借用 provider 名）
      attribution = buildAttribution('none', 'none', request);
      verdict = heuristicReview(request);
    }

    // G5 结论时效（cycle-38）：评审结论此前没有任何时效概念——一次 approve 在
    // 证据被换掉之后依然躺在账本里，看上去与刚做出时一模一样。判据用**内容指纹**
    // 而不是时间：attribution.promptDigest 只由（门、角色、证据 id+内容）决定，
    // 刻意不含 provider/model，因此「证据换过没有」是一次确定性字符串比较。
    // stale 只做提示、不改本次 verdict —— 插件不替调用方做取舍。
    //
    // 记账是增强不是依赖：工作区解析不到 / 写盘失败，评审照常返回，
    // 只是 review.freshness 记为 unknown 并在 review.error 里如实说明原因。
    const digest = attribution.promptDigest;
    let freshness: ReviewFreshness | 'unknown' = 'unknown';
    let previous: ReviewRecordView | null = null;
    let ledgerError: string | null = null;
    try {
      const root = opts.getWorkspaceRoot?.() ?? null;
      if (root === null) {
        ledgerError = 'workspace root unresolved (ledger skipped)';
      } else {
        const cyclesDir = join(root, '.cycles');
        const records = loadReviewRecords(cyclesDir);
        const prev = findLatestReview(records, gate, role);
        freshness = reviewFreshness(prev, digest);
        if (prev) {
          previous = {
            verdict: prev.verdict,
            tier: prev.tier,
            evidenceDigest: prev.evidenceDigest,
            evidenceIds: prev.evidenceIds,
            timestamp: prev.timestamp,
          };
        }
        const written = appendReviewRecord(cyclesDir, {
          gate,
          role,
          verdict: verdict.verdict,
          tier: verdict.tier,
          evidenceDigest: digest,
          evidenceIds: verdict.evidenceIds,
          provider: attribution.provider,
          model: attribution.model,
          timestamp: new Date().toISOString(),
        });
        if (!written.ok) ledgerError = written.reason;
      }
    } catch (e) {
      ledgerError = e instanceof Error ? e.message : String(e);
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
    //
    // grant（cycle-38）：把该卡的工具白名单与授权带上限随裁决返回。插件不替
    // 调用方执行工具，也不假装能拦住越权调用——诚实边界是「授权是调用方的义务，
    // 但授权依据必须可见」。白名单已在装载期做过存在性校验（agents.ts），
    // 这里原样透出，使越权调用在事后审计里可判。
    res.end(JSON.stringify({
      ...verdict,
      providers,
      grant: { toolsAllowlist: card.toolsAllowlist, autonomyBand: card.autonomyBand },
      attribution,
      review: { freshness, previous, error: ledgerError },
    }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anicError('ANIC_SKILL_EXEC_FAILED', err instanceof Error ? err.message : String(err), { effectState: 'unknown' })));
    }
  });
}
