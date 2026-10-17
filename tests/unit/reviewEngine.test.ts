/**
 * M4 LLM 评审引擎测试。
 * INV-23 fail-closed + INV-24 不进 inject + 三态降级。
 */
import { describe, it, expect } from 'vitest';
import { probeLlm, validateReviewJson, heuristicReview, type LlmRuntime, type GenerateOptions, type LlmChunk } from '../../src/host/llm/reviewEngine.ts';
import { pickProvider, resolveModel } from '../../src/host/llm/providerResolve.ts';

// ── pickProvider / resolveModel（cycle-9 真机修正：宿主无 'default' provider/model）──

describe('pickProvider', () => {
  const rt = (providers: Array<{ id: string }>): LlmRuntime => ({
    async *stream(): AsyncIterable<LlmChunk> { /* 选 provider 不调流 */ },
    listProviders: () => providers,
  });

  it('显式指定 → 原样使用', () => {
    expect(pickProvider(rt([{ id: 'deepseek-official' }]), 'workbuddy')).toBe('workbuddy');
  });

  it('未指定 → 宿主注册表首条（不是字面 default）', () => {
    expect(pickProvider(rt([{ id: 'deepseek-official' }, { id: 'workbuddy' }]), undefined)).toBe('deepseek-official');
  });

  it('runtime 为 null / 空注册表 / listProviders 抛异常 → 字面 default 兜底', () => {
    expect(pickProvider(null)).toBe('default');
    expect(pickProvider(rt([]))).toBe('default');
    const throwing: LlmRuntime = { ...rt([]), listProviders: () => { throw new Error('x'); } };
    expect(pickProvider(throwing)).toBe('default');
  });
});

describe('resolveModel', () => {
  const rt = (models: Array<{ id?: string }>, throws = false): LlmRuntime => ({
    async *stream(): AsyncIterable<LlmChunk> { /* 解析模型不调流 */ },
    listProviders: () => [{ id: 'p' }],
    listModels: throws ? () => { throw new Error('x'); } : async () => models,
  });

  it('显式指定 → 原样使用（不查目录）', async () => {
    const spy = rt([{ id: 'should-not-touch' }]);
    expect(await resolveModel(spy, 'p', 'explicit-model')).toBe('explicit-model');
  });

  it('未指定 → provider 目录首条', async () => {
    expect(await resolveModel(rt([{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]), 'p')).toBe('deepseek-chat');
  });

  it('目录空 / 抛异常 / runtime null → 字面 default 兜底', async () => {
    expect(await resolveModel(rt([]), 'p')).toBe('default');
    expect(await resolveModel(rt([{ id: 'x' }], true), 'p')).toBe('default');
    expect(await resolveModel(null, 'p')).toBe('default');
  });
});

// ── probeLlm ────────────────────────────────────────────

describe('probeLlm', () => {
  it('null ctx → null', () => {
    expect(probeLlm(null)).toBeNull();
  });

  it('ctx 无 get 方法 → null', () => {
    expect(probeLlm({})).toBeNull();
  });

  it('ctx.get("llm", false) 返回有效 runtime → 返回 runtime', () => {
    const runtime: LlmRuntime = {
      async *stream(_opts: GenerateOptions): AsyncIterable<LlmChunk> { yield { text: 'ok' }; },
      listProviders: () => [{ id: 'test' }],
    };
    const ctx = { get: (key: string, _strict?: boolean) => key === 'llm' ? runtime : undefined };
    expect(probeLlm(ctx)).toBe(runtime);
  });

  it('ctx.get("llm") 返回 null → null', () => {
    const ctx = { get: () => null };
    expect(probeLlm(ctx)).toBeNull();
  });

  it('ctx.get 抛异常 → null（不传播）', () => {
    const ctx = { get: () => { throw new Error('boom'); } };
    expect(probeLlm(ctx)).toBeNull();
  });

  it('runtime 缺 stream 方法 → null', () => {
    const ctx = { get: () => ({ listProviders: () => [] }) };
    expect(probeLlm(ctx)).toBeNull();
  });
});

// ── validateReviewJson ──────────────────────────────────

describe('validateReviewJson', () => {
  it('合法 approve → 返回 ReviewVerdict', () => {
    const raw = JSON.stringify({ verdict: 'approve', evidenceIds: ['e1'], notes: 'ok' });
    const v = validateReviewJson(raw);
    expect(v).not.toBeNull();
    expect(v?.verdict).toBe('approve');
    expect(v?.tier).toBe('tier-2-llm');
  });

  it('合法 reject → 返回', () => {
    const v = validateReviewJson(JSON.stringify({ verdict: 'reject', evidenceIds: ['e1'], notes: 'no' }));
    expect(v?.verdict).toBe('reject');
  });

  it('合法 doubt → 返回', () => {
    const v = validateReviewJson(JSON.stringify({ verdict: 'doubt', evidenceIds: ['e1'], notes: 'unsure' }));
    expect(v?.verdict).toBe('doubt');
  });

  it('非法 verdict → null', () => {
    expect(validateReviewJson(JSON.stringify({ verdict: 'maybe', evidenceIds: ['e1'], notes: 'x' }))).toBeNull();
  });

  it('空 evidenceIds → null', () => {
    expect(validateReviewJson(JSON.stringify({ verdict: 'approve', evidenceIds: [], notes: 'x' }))).toBeNull();
  });

  it('空 notes → null', () => {
    expect(validateReviewJson(JSON.stringify({ verdict: 'approve', evidenceIds: ['e1'], notes: '' }))).toBeNull();
  });

  it('非 JSON → null', () => {
    expect(validateReviewJson('not json')).toBeNull();
  });

  it('散文前缀包裹 JSON → 提取成功（cycle-9 闭合协议提取；schema 校验不放松）', () => {
    // 行为变更（有意）：真机模型常在 JSON 外包散文/围栏。闭合协议的实质是
    // **校验闭合**（对象必须过 schema），不再苛责整串传输形态（见
    // reviewEngine.ts extractJsonCandidate 注释）。
    const v = validateReviewJson('Here is my review: {"verdict":"approve","evidenceIds":["e1"],"notes":"ok"}');
    expect(v?.verdict).toBe('approve');
    expect(v?.evidenceIds).toEqual(['e1']);
  });

  it('```json 围栏包裹 → 提取成功', () => {
    const v = validateReviewJson('好的，评审结果：\n```json\n{"verdict":"doubt","evidenceIds":["e2"],"notes":"证据不足"}\n```\n以上。');
    expect(v?.verdict).toBe('doubt');
  });

  it('字符串字面量内的花括号不破坏平衡扫描', () => {
    const v = validateReviewJson('前言 {"verdict":"reject","evidenceIds":["e{1}"],"notes":"嵌套花括号 {ok}"} 后记');
    expect(v?.verdict).toBe('reject');
    expect(v?.evidenceIds).toEqual(['e{1}']);
  });

  it('平衡扫描提取的 JSON 仍须过闭合 schema（提取≠放行）', () => {
    // 提取出的对象 verdict 非法 → 依然 null（fail-closed 不因提取而放松）
    expect(validateReviewJson('{"verdict":"maybe","evidenceIds":["e1"],"notes":"x"}')).toBeNull();
    expect(validateReviewJson('包裹 {"verdict":"maybe","evidenceIds":["e1"],"notes":"x"} 尾巴')).toBeNull();
  });

  it('只有不完整的左括号 → null', () => {
    expect(validateReviewJson('说了一堆 {"verdict":"approve" 然后断了')).toBeNull();
  });
});

// ── heuristicReview ─────────────────────────────────────

describe('heuristicReview', () => {
  it('零证据 → doubt + tier-1', () => {
    const v = heuristicReview({ gate: 'intent', role: 'planner', evidence: [] });
    expect(v.verdict).toBe('doubt');
    expect(v.tier).toBe('tier-1-heuristic');
  });

  it('有证据 → approve + tier-1 + 诚实标注', () => {
    const v = heuristicReview({ gate: 'intent', role: 'planner', evidence: [{ id: 'e1', content: 'test' }] });
    expect(v.verdict).toBe('approve');
    expect(v.tier).toBe('tier-1-heuristic');
    expect(v.notes).toContain('非模型评审');
  });
});
