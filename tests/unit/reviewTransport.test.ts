/**
 * LLM 评审传输层测试（P0-1 / F39）。
 *
 * 覆盖从 `reviewEngine.ts` 拆分出的传输逻辑：
 *  - 错误码分派：不可重试码（配额/无适配器）不得触发重试
 *  - 可重试码（上下文超限）→ 缩证据重试恰一次
 *  - 超时 → doubt
 *  - fail-closed：任何异常路径绝不 approve
 */
import { describe, it, expect } from 'vitest';
import { runLlmReview } from '../../src/host/llm/reviewTransport.ts';
import type { LlmRuntime, ReviewRequest } from '../../src/host/llm/reviewEngine.ts';
import type { AgentCard } from '../../src/host/agents.ts';

const CARD: AgentCard = {
  id: 'anic.agent.intent.planner',
  role: 'planner',
  gate: 'intent',
  systemPrompt: '只输出闭合 JSON。',
  toolsAllowlist: [],
  autonomyBand: 'L2',
  outputContract: '闭合 JSON',
  escalation: '升级人类门',
};

const REQUEST: ReviewRequest = {
  gate: 'intent',
  role: 'planner',
  evidence: [
    { id: 'e1', content: '证据一' },
    { id: 'e2', content: '证据二' },
    { id: 'e3', content: '证据三' },
  ],
};

/**
 * 构造一个可编程的 stub LlmRuntime，记录每次 stream 的调用。
 * cycle-9 真机取证修正：错误块的真实形状是
 * `{type:'finish', reason:{kind:'error'|'aborted', failure:{code,message}}}`
 * （dsh-llm StreamChunk），旧 `{error:{...}}}$` 形状在真实宿主上不存在。
 */
function makeRuntime(script: ((call: number) => { text?: string; reason?: { kind?: string; failure?: { code: string; message: string } } })[]): {
  runtime: LlmRuntime;
  calls: { provider: string; model: string; purpose?: unknown }[];
} {
  const calls: { provider: string; model: string; purpose?: unknown }[] = [];
  let n = 0;
  const runtime: LlmRuntime = {
    async *stream(opts): AsyncIterable<{ text?: string; reason?: { kind?: string; failure?: { code: string; message: string } } }> {
      calls.push({ provider: opts.provider, model: opts.model, purpose: (opts as { purpose?: unknown }).purpose });
      const step = script[Math.min(n, script.length - 1)];
      n++;
      const chunk = step(n);
      yield chunk;
    },
    listProviders: () => [{ id: 'stub', name: 'Stub' }],
  };
  return { runtime, calls };
}

/** 按真实协议造一个 finish-error 块。 */
function errChunk(code: string, message: string): { reason: { kind: string; failure: { code: string; message: string } } } {
  return { reason: { kind: 'error', failure: { code, message } } };
}

const VALID = JSON.stringify({ verdict: 'approve', evidenceIds: ['e1'], notes: 'ok' });

describe('reviewTransport · 正常路径', () => {
  it('合法闭合 JSON → tier-2-llm approve', async () => {
    const { runtime } = makeRuntime([() => ({ text: VALID })]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('approve');
    expect(v.tier).toBe('tier-2-llm');
    expect(v.evidenceIds).toEqual(['e1']);
  });

  it('绝不向宿主传 purpose（宿主闭合枚举只认 compaction / session-title）', async () => {
    const { runtime, calls } = makeRuntime([() => ({ text: VALID })]);
    await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBeUndefined();
  });

  it('provider / model 原样透传给宿主', async () => {
    const { runtime, calls } = makeRuntime([() => ({ text: VALID })]);
    await runLlmReview(runtime, CARD, REQUEST, 'workbuddy', 'deepseek-v4.1');
    expect(calls[0]?.provider).toBe('workbuddy');
    expect(calls[0]?.model).toBe('deepseek-v4.1');
  });
});

describe('reviewTransport · fail-closed（绝不 approve）', () => {
  it('非 JSON 返回 → doubt', async () => {
    const { runtime } = makeRuntime([() => ({ text: '我认为可以批准' })]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('doubt');
    expect(v.notes).toContain('fail-closed');
  });

  it('JSON 缺 evidenceIds → doubt', async () => {
    const { runtime } = makeRuntime([() => ({ text: JSON.stringify({ verdict: 'approve', notes: 'x' }) })]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('doubt');
  });

  it('stream 抛异常 → doubt（不向上传播）', async () => {
    const runtime = {
      stream(): AsyncIterable<never> {
        throw new Error('socket closed');
      },
      listProviders: () => [],
    } as unknown as LlmRuntime;
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('doubt');
    expect(v.notes).toContain('socket closed');
  });

  it('迭代过程中抛异常 → doubt', async () => {
    const runtime = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<never> {
        throw new Error('mid-stream failure');
      },
      listProviders: () => [],
    } as unknown as LlmRuntime;
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('doubt');
  });

  it('模型自己回 doubt → 原样透传（不被改写成 approve）', async () => {
    const { runtime } = makeRuntime([
      () => ({ text: JSON.stringify({ verdict: 'doubt', evidenceIds: ['e1'], notes: '证据不足' }) }),
    ]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('doubt');
  });
});

describe('reviewTransport · F39 错误码分派', () => {
  it('CONTEXT_WINDOW_EXCEEDED → 缩证据重试恰一次', async () => {
    const { runtime, calls } = makeRuntime([
      () => errChunk('CONTEXT_WINDOW_EXCEEDED', 'too long'),
      () => ({ text: VALID }),
    ]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(2);
    expect(v.verdict).toBe('approve');
    // 重试必须留下「缩证据」痕迹，否则事后无法区分首答与重答
    expect(v.notes).toContain('缩证据重试');
    expect(v.notes).toContain('3→1');
  });

  it('TOO_MANY_TOKENS 同样可重试', async () => {
    const { runtime, calls } = makeRuntime([
      () => errChunk('TOO_MANY_TOKENS', 'x'),
      () => ({ text: VALID }),
    ]);
    await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(2);
  });

  it('QUOTA_EXCEEDED → 立即 doubt，不重试（不再消耗配额）', async () => {
    const { runtime, calls } = makeRuntime([
      () => errChunk('QUOTA_EXCEEDED', 'out of quota'),
    ]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(v.verdict).toBe('doubt');
    expect(v.notes).toContain('QUOTA_EXCEEDED');
    expect(v.notes).toContain('不可重试');
  });

  it('NO_ADAPTER → 立即 doubt，不重试', async () => {
    const { runtime, calls } = makeRuntime([() => errChunk('NO_ADAPTER', 'none')]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(v.verdict).toBe('doubt');
  });

  it('MISSING_CREDENTIAL（真机实测码）→ 立即 doubt，不重试', async () => {
    // 真机取证：无头宿主无 API key 时 deepseek-official 路由的终态错误。
    const { runtime, calls } = makeRuntime([() => errChunk('MISSING_CREDENTIAL', 'no API key for provider route "deepseek-official"')]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(v.verdict).toBe('doubt');
    expect(v.notes).toContain('不可重试');
  });

  it('未知错误码 → doubt 且原样透传码（绝不吞掉证据）', async () => {
    const { runtime, calls } = makeRuntime([() => errChunk('WEIRD_NEW_CODE', 'who knows')]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(v.verdict).toBe('doubt');
    expect(v.notes).toContain('WEIRD_NEW_CODE');
  });

  it('可重试码但只有 1 条证据 → 不重试（缩无可缩）', async () => {
    const oneEvidence: ReviewRequest = { ...REQUEST, evidence: [{ id: 'e1', content: 'only' }] };
    const { runtime, calls } = makeRuntime([
      () => errChunk('CONTEXT_WINDOW_EXCEEDED', 'too long'),
    ]);
    const v = await runLlmReview(runtime, CARD, oneEvidence, 'p', 'm');
    expect(calls).toHaveLength(1);
    expect(v.verdict).toBe('doubt');
  });

  it('重试仍失败 → 返回第二次的 doubt（不无限重试）', async () => {
    const { runtime, calls } = makeRuntime([
      () => errChunk('CONTEXT_WINDOW_EXCEEDED', 'again'),
      () => errChunk('CONTEXT_WINDOW_EXCEEDED', 'still'),
    ]);
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(calls).toHaveLength(2);
    expect(v.verdict).toBe('doubt');
  });

  it('真实协议 text-delta 形态收集正文（type 字段区分，reasoning 不误收）', async () => {
    // 真机形状：正文带 type:'text-delta'，思考块 type:'reasoning-delta' 带 text
    // 但不是可见正文 —— 收集器必须靠 type 区分，否则 reasoning 会混进协议文本。
    const runtime: LlmRuntime = {
      async *stream(): AsyncIterable<{ type?: string; text?: string }> {
        yield { type: 'reasoning-delta', text: '思考过程不算正文' };
        yield { type: 'text-delta', text: VALID.slice(0, 10) };
        yield { type: 'text-delta', text: VALID.slice(10) };
        yield { type: 'block-end', block: null } as unknown as { type: string };
        yield { type: 'finish', reason: { kind: 'stop' } } as unknown as { type: string };
      },
      listProviders: () => [{ id: 'stub' }],
    };
    const v = await runLlmReview(runtime, CARD, REQUEST, 'p', 'm');
    expect(v.verdict).toBe('approve');
    expect(v.evidenceIds).toEqual(['e1']);
  });
});
