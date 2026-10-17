/**
 * multiAgentTier2 契约套件（R3 阶段 4 前半 · cycle-9）。
 *
 * 钉死的行为：
 *  1. LLM 不可用 → 整体 Tier-1-fallback（诚实标注，绝不伪造 Tier-2）
 *  2. LLM 可用 → 逐门逐角色真评审，runGate 聚合消费 Tier-2 裁决
 *  3. 证据接地（INV-23）：幻觉引用过滤；过滤后为空的 approve → 降 doubt
 *  4. 授权带越界角色不消耗 LLM 配额（runGate 内 SELF_REFUSAL）
 *  5. 单角色 LLM 失败 → 该角色 Tier-1，其余角色仍 Tier-2（独立降级）
 */
import { describe, expect, it } from 'vitest';
import { runAllGatesWithLlm } from '../../src/host/llm/multiAgentTier2.ts';
import type { EvidenceItem } from '../../src/host/llm/multiAgentGate.ts';
import type { LlmRuntime } from '../../src/host/llm/reviewEngine.ts';
import { SELF_REFUSAL } from '../../src/host/llm/multiAgentGate.ts';
import type { AgentCard } from '../../src/host/agents.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARDS_DIR = fileURLToPath(new URL('../../assets/agents/', import.meta.url));

/**
 * 装 15 张真实卡（保留全部字段——autonomyBand/systemPrompt 都是本套件的
 * 被测依赖；键取卡内 id 字段，不能由文件名拼，教训见 multiAgentGateContract）。
 */
function realCards(): Map<string, AgentCard> {
  const map = new Map<string, AgentCard>();
  for (const file of readdirSync(CARDS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(CARDS_DIR, file), 'utf-8')) as AgentCard & { id?: string };
    if (typeof raw.id !== 'string' || raw.id === '') continue;
    map.set(raw.id, raw);
  }
  return map;
}

/** 闭合 JSON 的流式 stub（合法 verdict 形状由 validateReviewJson 把关）。 */
function stubLlm(response: () => string): LlmRuntime {
  return {
    // biome-ignore lint/suspicious/useAwait: async 生成器形态即宿主契约
    async *stream() {
      yield { text: response() };
    },
    listProviders: () => [{ id: 'stub' }],
  };
}

/** ctx stub：ctx.get('llm', false) 形态（probeLlm 的探测路径）。 */
function ctxWith(runtime: LlmRuntime | null): unknown {
  return { get: (key: string) => (key === 'llm' ? runtime : undefined) };
}

const EVIDENCE: Record<string, EvidenceItem[]> = {
  intent: [{ id: 'intent.md', content: '目标与约束齐备', result: 'PASS' }],
  spec: [{ id: 'spec.md', content: '规格', result: 'PASS' }],
  plan: [{ id: 'plan.md', content: '计划', result: 'PASS' }],
  pr: [
    { id: 'G0', content: 'G0 PASS', result: 'PASS' },
    { id: 'G1', content: 'G1 PASS', result: 'PASS' },
    { id: 'G2', content: 'G2 PASS', result: 'PASS' },
    { id: 'G3', content: 'G3 PASS', result: 'PASS' },
    { id: 'ledger', content: '账本链校验通过', result: 'PASS' },
  ],
  release: [
    { id: 'G0', content: 'G0 PASS', result: 'PASS' },
    { id: 'audit', content: '审计日志缺失', result: 'FAIL' },
  ],
};

describe('runAllGatesWithLlm', () => {
  it('LLM 不可用 → 整体 Tier-1-fallback，诚实标注', async () => {
    const { results, summary } = await runAllGatesWithLlm(ctxWith(null), realCards(), EVIDENCE);
    expect(summary.tier).toBe('Tier-1-fallback');
    expect(summary.llmVerdictCount).toBe(0);
    expect(summary.filteredEvidenceRefs).toBe(0);
    // 五门齐全，全部 Tier-1
    expect(results).toHaveLength(5);
    for (const g of results) {
      expect(g.verdicts.every((v) => v.tier === 'Tier-1')).toBe(true);
    }
    // pr 门证据全 PASS → Tier-1 聚合 approve（语义与 runAllGates 一致）
    const pr = results.find((g) => g.gate === 'pr');
    expect(pr?.aggregate).toBe('approve');
  });

  it('ctx 无 get / get 抛异常 → 同样 Tier-1-fallback', async () => {
    const noGet = await runAllGatesWithLlm({}, realCards(), EVIDENCE);
    expect(noGet.summary.tier).toBe('Tier-1-fallback');
    const throwing = await runAllGatesWithLlm({ get: () => { throw new Error('boom'); } }, realCards(), EVIDENCE);
    expect(throwing.summary.tier).toBe('Tier-1-fallback');
  });

  it('LLM 可用 → Tier-2，逐门逐角色真评审，信任分走置信度映射', async () => {
    // 按 stub 的固定回答：approve + 'intent.md' 引用（intent 门真实证据 id）
    const runtime = stubLlm(() => JSON.stringify({
      verdict: 'approve',
      evidenceIds: ['intent.md'],
      notes: '模型评审：目标清晰',
    }));
    const cards = realCards();
    // intent 门有证据（LLM 评审）；其余门零证据（跳过 LLM，Tier-1 doubt）
    const { results, summary } = await runAllGatesWithLlm(
      ctxWith(runtime), cards,
      { intent: EVIDENCE.intent, spec: [], plan: [], pr: [], release: [] },
    );
    expect(summary.tier).toBe('Tier-2');
    expect(summary.llmVerdictCount).toBe(3); // intent 门 3 角色；零证据门不烧配额
    const intent = results.find((g) => g.gate === 'intent');
    expect(intent?.verdicts.every((v) => v.tier === 'Tier-2')).toBe(true);
    // 3×approve(0.8) → trustScore 80
    expect(intent?.trustScore).toBe(80);
    expect(intent?.aggregate).toBe('approve');
    // 零证据门：Tier-1 无证据路径（doubt），LLM 未被调用
    const spec = results.find((g) => g.gate === 'spec');
    expect(spec?.verdicts.every((v) => v.tier === 'Tier-1' && v.verdict === 'doubt')).toBe(true);
  });

  it('证据接地（INV-23）：幻觉引用被过滤，无接地的 approve 降 doubt', async () => {
    const runtime = stubLlm(() => JSON.stringify({
      verdict: 'approve',
      evidenceIds: ['ghost-1', 'ghost-2'],
      notes: '模型幻觉引用',
    }));
    const { results, summary } = await runAllGatesWithLlm(
      ctxWith(runtime), realCards(),
      { intent: EVIDENCE.intent, spec: [], plan: [], pr: [], release: [] },
    );
    // 3 角色 × 2 条幻觉引用 = 6 条被过滤
    expect(summary.filteredEvidenceRefs).toBe(6);
    const intent = results.find((g) => g.gate === 'intent');
    expect(intent?.verdicts.every((v) => v.verdict === 'doubt')).toBe(true);
    expect(intent?.verdicts.every((v) => v.evidenceIds.length === 0)).toBe(true);
    // 降级说明必须可见（接地失败是可观测事实）
    expect(intent?.verdicts[0]?.notes).toContain('接地失败');
    expect(intent?.aggregate).toBe('doubt');
  });

  it('部分接地：幻觉条目剔除，真引用保留', async () => {
    const runtime = stubLlm(() => JSON.stringify({
      verdict: 'approve',
      evidenceIds: ['intent.md', 'ghost'],
      notes: '混合引用',
    }));
    const { results, summary } = await runAllGatesWithLlm(
      ctxWith(runtime), realCards(),
      { intent: EVIDENCE.intent, spec: [], plan: [], pr: [], release: [] },
    );
    expect(summary.filteredEvidenceRefs).toBe(3); // 3 角色各 1 条幻觉
    const intent = results.find((g) => g.gate === 'intent');
    expect(intent?.verdicts.map((v) => v.evidenceIds)).toEqual([['intent.md'], ['intent.md'], ['intent.md']]);
    expect(intent?.verdicts[0]?.notes).toContain('已过滤 1 条幻觉证据引用');
    expect(intent?.aggregate).toBe('approve');
  });

  it('授权带越界角色不消耗 LLM 配额（SELF_REFUSAL 由 runGate 出）', async () => {
    let calls = 0;
    const runtime: LlmRuntime = {
      async *stream() {
        calls += 1;
        yield { text: JSON.stringify({ verdict: 'approve', evidenceIds: ['intent.md'], notes: 'ok' }) };
      },
      listProviders: () => [{ id: 'stub' }],
    };
    // 真实卡 autonomyBand 多为 L2；currentBand=L1 → 全部越带 → 0 次 LLM 调用
    const { results, summary } = await runAllGatesWithLlm(
      ctxWith(runtime), realCards(), EVIDENCE, { currentBand: 'L1' },
    );
    expect(calls).toBe(0);
    expect(summary.llmVerdictCount).toBe(0);
    // 全门 SELF_REFUSAL doubt
    for (const g of results) {
      expect(g.verdicts.every((v) => v.notes.startsWith(SELF_REFUSAL))).toBe(true);
      expect(g.aggregate).toBe('doubt');
    }
  });

  it('单角色 LLM 协议失败（非 JSON）→ 该角色 fail-closed doubt，其余 Tier-2 不受累', async () => {
    let call = 0;
    const runtime: LlmRuntime = {
      async *stream() {
        call += 1;
        // 第 1 次调用（planner）吐非 JSON；其余吐合法闭合 JSON
        if (call === 1) yield { text: '这不是 JSON' };
        else yield { text: JSON.stringify({ verdict: 'approve', evidenceIds: ['intent.md'], notes: 'ok' }) };
      },
      listProviders: () => [{ id: 'stub' }],
    };
    const { results, summary } = await runAllGatesWithLlm(
      ctxWith(runtime), realCards(),
      { intent: EVIDENCE.intent, spec: [], plan: [], pr: [], release: [] },
    );
    expect(summary.tier).toBe('Tier-2');
    const intent = results.find((g) => g.gate === 'intent');
    const planner = intent?.verdicts.find((v) => v.role === 'planner');
    const others = intent?.verdicts.filter((v) => v.role !== 'planner');
    // 协议失败 → fail-closed doubt（绝不 approve）；不回退到启发式 approve——
    // LLM 说「无法评审」时，用启发式伪造一个 approve 比诚实 doubt 更糟。
    expect(planner?.verdict).toBe('doubt');
    expect(planner?.confidence).toBeLessThan(0.5);
    expect(others?.every((v) => v.tier === 'Tier-2' && v.verdict === 'approve')).toBe(true);
  });

  it('LLM 返回 reject → 门聚合 reject（真实评审能拦住 Tier-1 会放行的事）', async () => {
    const runtime = stubLlm(() => JSON.stringify({
      verdict: 'reject',
      evidenceIds: ['intent.md'],
      notes: '证据不足，拒绝',
    }));
    const { results } = await runAllGatesWithLlm(
      ctxWith(runtime), realCards(),
      { intent: EVIDENCE.intent, spec: [], plan: [], pr: [], release: [] },
    );
    const intent = results.find((g) => g.gate === 'intent');
    // 3×reject → 聚合 reject（Tier-1 对同一证据会 approve——语义评审的价值面）
    expect(intent?.aggregate).toBe('reject');
    expect(intent?.passed).toBe(false);
  });
});
