/**
 * multiAgentTier2 —— 多代理门禁的 Tier-2 LLM 编排（R3 阶段 4 前半）。
 *
 * docs/anic README 的第一缺口：「所有评审/修复/多智能体环节都是纯正则启发式，
 * 无 LLM 参与（自评审是拟真）」。runGate 的 `options.llmResults` 参数自
 * M4 就有，但**没有任何生产者**——五门 3 角色全部落 Tier-1 启发式。
 *
 * 本文件补上生产者：probeLlm(ctx) → 可用时逐门逐角色跑真 LLM 评审
 * （agent 卡 systemPrompt + 结构化证据 → 闭合 JSON 协议）→ 映射为
 * AgentVerdict 喂 runGate；不可用 → 整体降级 Tier-1（诚实标注）。
 *
 * 证据接地纪律（INV-23 Tier-2 段）：LLM 返回的 evidenceIds 必须落在
 * **注入集合内**，模型引用不存在的证据 = 幻觉引用 → 过滤；过滤后为空且
 * verdict=approve → 该 approve 失去证据根基，降为 doubt（fail-closed）。
 */

import type { AgentCard } from '../agents.ts';
import { probeLlm, type ReviewRequest } from './reviewEngine.ts';
import { pickProvider, resolveModel } from './providerResolve.ts';
import { runLlmReview } from './reviewTransport.ts';
import {
  runAllGates, runGate, GATE_NAMES, AGENT_ROLES, type AgentVerdict,
  type EvidenceItem, type GateResult, type GateName, type AgentRole,
} from './multiAgentGate.ts';

/** Tier-2 评审的置信度映射。
 *
 * 闭合 JSON 协议不携带 confidence 字段（协议保持最小），此处用文档化常量：
 * 决定性裁决（approve/reject）0.8，doubt 0.4。这是**映射约定**不是模型输出，
 * trustScore 聚合（avgConfidence 均值）会把该约定如实传播。
 */
const TIER2_CONFIDENCE: Readonly<Record<AgentVerdict['verdict'], number>> = {
  approve: 0.8,
  reject: 0.8,
  doubt: 0.4,
};

/** 授权带序（与 multiAgentGate 内部表同值；这里只用于「是否值得调 LLM」）。 */
const BAND_ORDER: Readonly<Record<'L1' | 'L2' | 'L3' | 'L4', number>> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export interface Tier2Options {
  currentBand?: 'L1' | 'L2' | 'L3' | 'L4';
  provider?: string;
  model?: string;
}

export interface Tier2Summary {
  /** Tier-2 = 至少一个角色出了真 LLM 裁决；Tier-1-fallback = 全降级。 */
  tier: 'Tier-2' | 'Tier-1-fallback';
  llmVerdictCount: number;
  /** 幻觉证据引用被过滤的次数（接地纪律的可观测面）。 */
  filteredEvidenceRefs: number;
  provider: string;
  model: string;
}

export interface Tier2RunResult {
  results: GateResult[];
  summary: Tier2Summary;
}

/**
 * 运行全部门禁，LLM 可用时逐门逐角色做真评审。
 *
 * 每个门 × 角色的 LLM 调用相互独立、失败即该角色降级 Tier-1（不是整门报废：
 * 单个 agent 调用失败时其余 agent 的 Tier-2 裁决仍应进入聚合）。
 */
export async function runAllGatesWithLlm(
  ctx: unknown,
  agentCards: Map<string, AgentCard>,
  evidenceByGate: Record<string, EvidenceItem[]>,
  options: Tier2Options = {},
): Promise<Tier2RunResult> {
  const runtime = probeLlm(ctx);
  // cycle-9 真机修正：宿主没有 'default' provider —— 未显式指定时取
  // 注册表首条（见 pickProvider 头注释；此前 default 让 15 个评审全部空流）。
  const provider = pickProvider(runtime, options.provider);
  const model = await resolveModel(runtime, provider, options.model);

  // LLM 不可用 → 整体 Tier-1（诚实标注，绝不伪造 Tier-2）
  if (runtime === null) {
    return {
      results: runAllGates(agentCards, evidenceByGate, { currentBand: options.currentBand }),
      summary: { tier: 'Tier-1-fallback', llmVerdictCount: 0, filteredEvidenceRefs: 0, provider, model },
    };
  }

  let llmVerdictCount = 0;
  let filteredEvidenceRefs = 0;

  const results: GateResult[] = [];
  for (const gate of GATE_NAMES) {
    const evidence = evidenceByGate[gate] ?? [];
    const llmResults: AgentVerdict[] = [];

    // 零证据不调 LLM：无证据可接地，任何 approve 都会因接地失败降 doubt——
    // 调用只会烧配额，语义上等价于 Tier-1 的「无证据 → doubt」。
    if (evidence.length === 0) {
      results.push(runGate(gate, agentCards, evidence, { currentBand: options.currentBand }));
      continue;
    }

    for (const role of AGENT_ROLES) {
      const card = agentCards.get(`anic.agent.${gate}.${role}`);
      if (!card) continue; // 缺卡：runGate 内部同样跳过，聚合不含该角色
      // 授权带越界：runGate 会以 SELF_REFUSAL 拒绝——不值得为其消耗 LLM 配额
      if (options.currentBand && BAND_ORDER[card.autonomyBand] > BAND_ORDER[options.currentBand]) continue;

      const request: ReviewRequest = {
        gate,
        role,
        // ReviewRequest.evidence 是 {id, content} —— EvidenceItem 的超集兼容
        evidence: evidence.map((e) => ({ id: e.id, content: e.content })),
      };
      const verdict = await runLlmReview(runtime, card, request, provider, model);

      // 证据接地（INV-23）：幻觉引用过滤
      const allowed = new Set(evidence.map((e) => e.id));
      const grounded = verdict.evidenceIds.filter((id) => allowed.has(id));
      filteredEvidenceRefs += verdict.evidenceIds.length - grounded.length;

      let finalVerdict = verdict.verdict;
      let notes = verdict.notes;
      if (grounded.length === 0 && verdict.verdict === 'approve') {
        // approve 却接不到任何注入证据 → 失去证据根基，降 doubt（fail-closed）
        finalVerdict = 'doubt';
        notes = `${notes}（接地失败：引用的证据均不在注入集合内，approve 降级 doubt）`;
      }
      if (verdict.evidenceIds.length > grounded.length && grounded.length > 0) {
        notes = `${notes}（已过滤 ${String(verdict.evidenceIds.length - grounded.length)} 条幻觉证据引用）`;
      }

      llmResults.push({
        role,
        verdict: finalVerdict,
        confidence: TIER2_CONFIDENCE[finalVerdict],
        evidenceIds: grounded,
        notes,
        tier: 'Tier-2',
      });
      llmVerdictCount += 1;
    }

    // llmResults 只覆盖成功的角色；runGate 对其余角色落 Tier-1（每角色独立降级）
    results.push(runGate(gate as GateName, agentCards, evidence, {
      llmResults,
      currentBand: options.currentBand,
    }));
  }

  return {
    results,
    summary: {
      tier: llmVerdictCount > 0 ? 'Tier-2' : 'Tier-1-fallback',
      llmVerdictCount,
      filteredEvidenceRefs,
      provider,
      model,
    },
  };
}

/** 类型重导出（消费方类型收窄用）。 */
export type { AgentRole };
