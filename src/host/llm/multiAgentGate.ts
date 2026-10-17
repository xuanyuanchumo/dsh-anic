/**
 * 多代理门禁（原生实现，替代技能 multi-agent-gate.mjs）。
 * 5 门 × 3 角色，聚合裁决：approve/reject/doubt。
 * Tier-1 模式：基于证据的启发式评估（诚实标注「非模型评审」）。
 * Tier-2 模式：调用 LLM 评审引擎（如果可用）。
 */
import type { AgentCard } from '../agents.ts';

export type GateVerdict = 'approve' | 'reject' | 'doubt';
export const GATE_NAMES = ['intent', 'spec', 'plan', 'pr', 'release'] as const;
export const AGENT_ROLES = ['planner', 'implementer', 'reviewer'] as const;
export type GateName = (typeof GATE_NAMES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentVerdict {
  role: AgentRole;
  verdict: GateVerdict;
  confidence: number; // 0-1
  evidenceIds: string[];
  notes: string;
  tier: 'Tier-1' | 'Tier-2';
}

export interface GateResult {
  gate: GateName;
  verdicts: AgentVerdict[];
  aggregate: GateVerdict;
  trustScore: number; // 0-100
  threshold: number; // 2 or 3
  passed: boolean;
}

/**
 * 聚合裁决：approve 数 ≥ threshold → approve；否则 reject 优先于 doubt。
 *
 * P0-9（已修）：`verdicts.length === 0` 时原式 `approve / 0 * 100` 得 **NaN**，
 * 而 NaN 会污染 trustModel 的升降级建议（`NaN >= 85` 恒 false → 永远不升级，
 * 且序列化进账本后 JSON 变成 `null`）。空裁决集必须显式返回 0 分并保持
 * `doubt` —— 「没有证据 ≠ 通过」（INV-23 同族纪律）。
 *
 * P2 语义对齐（R3 阶段 3，已修）：trustScore 原为 approve 占比
 * `approve/total*100`，与技能 `multi-agent-gate.mjs:221-222` 的
 * `trustScore = Math.round(avgConfidence * 100)`（agent 置信度均值）冲突。
 * 例：3 agent 全 approve（Tier-1 置信度 0.6）—— 旧式报 100 分（看起来
 * 满分），技能语义报 60 分（启发式置信度的诚实值）。语义对齐技能侧。
 */
export function aggregateVerdicts(verdicts: AgentVerdict[], threshold: number): { verdict: GateVerdict; trustScore: number; passed: boolean } {
  if (verdicts.length === 0) return { verdict: 'doubt', trustScore: 0, passed: false };
  const approve = verdicts.filter((v) => v.verdict === 'approve').length;
  const reject = verdicts.filter((v) => v.verdict === 'reject').length;
  const verdict: GateVerdict = approve >= threshold ? 'approve' : reject > 0 ? 'reject' : 'doubt';
  const avgConfidence = verdicts.reduce((s, v) => s + v.confidence, 0) / verdicts.length;
  const trustScore = Math.round(avgConfidence * 100);
  return { verdict, trustScore, passed: verdict === 'approve' };
}

/**
 * 证据条目。
 *
 * P0-7（已修）：此前 `heuristicEvaluate` 用**中文关键词** `['通过','失败']` 判
 * PASS/FAIL —— 这正是 docs/anic 02 §N9 明令禁止的「中文假设」。通用版必须
 * 消费**结构化裁决事实**，而不是解析散文。
 *
 * `result` 是首选通道（来自 F36 报告投影 / 门禁裁决）：三态 PASS/FAIL/SKIP。
 * `content` 仅在无结构化结果时作 Tier-1 兜底，且只认**语言中立**标记
 * （Unicode 符号与 ASCII 词），不再依赖任何自然语言。
 */
export interface EvidenceItem {
  id: string;
  content: string;
  /** 结构化裁决事实（首选）。来自报告投影或门禁账本，不解析散文。 */
  result?: 'PASS' | 'FAIL' | 'SKIP';
}

/** 语言中立的失败标记（Unicode 符号 + ASCII，无自然语言依赖）。 */
const FAIL_MARKERS = ['❌', '✗', 'FAIL'];
/** 语言中立的通过标记。 */
const PASS_MARKERS = ['✅', '✓', 'PASS'];

/**
 * 从证据集中提取结构化裁决（P0-7）。
 * 任一 FAIL → 'FAIL'；否则有 PASS 且无 FAIL → 'PASS'；全 SKIP/无 → 'SKIP'。
 * 结构化字段优先；仅在完全没有结构化字段时回落到语言中立标记扫描。
 */
export function deriveEvidenceResult(evidence: EvidenceItem[]): 'PASS' | 'FAIL' | 'SKIP' {
  if (evidence.length === 0) return 'SKIP';
  const structured = evidence.filter((e) => e.result !== undefined);
  if (structured.length > 0) {
    if (structured.some((e) => e.result === 'FAIL')) return 'FAIL';
    if (structured.some((e) => e.result === 'PASS')) return 'PASS';
    return 'SKIP';
  }
  // 兜底：语言中立标记扫描（无自然语言假设）
  const text = evidence.map((e) => e.content).join(' ');
  if (FAIL_MARKERS.some((m) => text.includes(m))) return 'FAIL';
  if (PASS_MARKERS.some((m) => text.includes(m))) return 'PASS';
  return 'SKIP';
}

/** Tier-1 启发式评估（诚实标注「非模型评审」）。 */
export function heuristicEvaluate(
  role: AgentRole,
  gate: GateName,
  evidence: EvidenceItem[],
): AgentVerdict {
  const hasEvidence = evidence.length > 0;
  const derived = deriveEvidenceResult(evidence);

  let verdict: GateVerdict;
  let confidence: number;
  if (!hasEvidence) {
    verdict = 'doubt';
    confidence = 0.3;
  } else if (derived === 'FAIL') {
    verdict = 'reject';
    confidence = 0.7;
  } else if (derived === 'PASS') {
    verdict = 'approve';
    confidence = 0.6;
  } else {
    // SKIP 或证据不足 → doubt（没有证据 ≠ 通过）
    verdict = 'doubt';
    confidence = 0.4;
  }

  return {
    role,
    verdict,
    confidence,
    evidenceIds: evidence.map((e) => e.id),
    notes: `Tier-1 heuristic (evidence=${String(evidence.length)}, derived=${derived})`,
    tier: 'Tier-1',
  };
}

/**
 * 各门通过阈值。
 *
 * P0-8（已修）：原式 `gate === 'release' ? 3 : 2` 把 **pr 门也算成 2**，
 * 与技能侧 `scripts/multi-agent-gate.mjs:139`（`pr: { threshold: 3 }`，
 * 注释「3/3 Agent 全部通过则推荐合并PR」）直接冲突。PR 合并门与发布门
 * 一样是不可逆的高风险动作，必须全票。
 */
export const GATE_THRESHOLDS: Readonly<Record<GateName, number>> = {
  intent: 2,
  spec: 2,
  plan: 2,
  pr: 3,
  release: 3,
};

/** 自主级大小序（L1 < L2 < L3 < L4）。 */
const BAND_ORDER: Readonly<Record<'L1' | 'L2' | 'L3' | 'L4', number>> = { L1: 1, L2: 2, L3: 3, L4: 4 };

/** 授权带越界标记（notes 前缀；INV-28 同族：拒绝要留痕）。 */
export const SELF_REFUSAL = 'SELF_REFUSAL';

/** 运行单门多代理评估。
 *
 * options.currentBand（R3 阶段 1）：当前工作区自主级。提供时，卡片的
 * `autonomyBand` 超出当前带的 agent **拒绝出裁决**（SELF_REFUSAL，doubt/0 分/
 * 空证据）—— 授权带此前只有字段没有执行点，L4 卡片在 L2 工作区照样投票。
 * 拒绝不计入 approve，门自然更难过（越带调用收紧而非静默放行）。
 */
export function runGate(
  gate: GateName,
  agentCards: Map<string, AgentCard>,
  evidence: EvidenceItem[],
  options?: { llmResults?: AgentVerdict[]; currentBand?: 'L1' | 'L2' | 'L3' | 'L4' },
): GateResult {
  const threshold = GATE_THRESHOLDS[gate];
  const verdicts: AgentVerdict[] = [];

  for (const role of AGENT_ROLES) {
    const cardId = `anic.agent.${gate}.${role}`;
    const card = agentCards.get(cardId);
    if (!card) continue;

    // 授权带执行点（R3 阶段 1）：卡片要求的自主级超出当前带 → 拒绝出裁决
    if (options?.currentBand && BAND_ORDER[card.autonomyBand] > BAND_ORDER[options.currentBand]) {
      verdicts.push({
        role,
        verdict: 'doubt',
        confidence: 0,
        evidenceIds: [],
        notes: `${SELF_REFUSAL}: 卡片授权带 ${card.autonomyBand} 超出当前自主级 ${options.currentBand}，该 agent 拒绝出裁决（12 §2.6 授权带）`,
        tier: 'Tier-1',
      });
      continue;
    }

    // 优先使用 LLM 结果（Tier-2），否则 Tier-1 启发式
    const llmResult = options?.llmResults?.find((v) => v.role === role);
    if (llmResult && llmResult.tier === 'Tier-2') {
      verdicts.push(llmResult);
    } else {
      verdicts.push(heuristicEvaluate(role, gate, evidence));
    }
  }

  const { verdict, trustScore, passed } = aggregateVerdicts(verdicts, threshold);
  return { gate, verdicts, aggregate: verdict, trustScore, threshold, passed };
}

/** 运行全部门禁。 */
export function runAllGates(
  agentCards: Map<string, AgentCard>,
  evidenceByGate: Record<string, EvidenceItem[]>,
  options?: { currentBand?: 'L1' | 'L2' | 'L3' | 'L4' },
): GateResult[] {
  return GATE_NAMES.map((gate) => runGate(gate, agentCards, evidenceByGate[gate] ?? [], options));
}
