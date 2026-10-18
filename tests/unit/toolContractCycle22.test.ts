/**
 * cycle-22 官方契约对齐测试：
 * 1. safeHandler 语义修正——infra 异常沿 Promise 拒绝传播（注册表收敛为 isError），
 *    领域失败仍是规范值（不 throw）。
 * 2. normalizeToolResult / terminalResult 双形状——官方 {content,isError,meta} 形状
 *    与宿主宽容直传形状（0.2.0-rc.2 实测）都正确渲染。
 *
 * 官方契约锚点：dsh-plugin-dev-kb kb/site/reference/cookbook/adding-a-tool.md
 * 「抛出异常或返回无效值意味着 isError。基础设施故障请抛异常。成功的领域结果
 * 即使表示不理想的状态，也应写入规范值」+ presentResult(args, {content,isError,meta?})。
 */
import { describe, it, expect } from 'vitest';
import { safeHandler } from '../../src/host/toolsSlot.ts';
import { normalizeToolResult, terminalResult } from '../../src/host/presentation.ts';

describe('cycle-22 safeHandler 语义（官方 isError 对齐）', () => {
  it('infra 异常沿 Promise 拒绝传播（不再吞成 {error} 假成功）', async () => {
    const boom = new Error('ECONNREFUSED: registry socket gone');
    const wrapped = safeHandler(async () => { throw boom; });
    await expect(wrapped({})).rejects.toThrow('ECONNREFUSED: registry socket gone');
  });

  it('领域失败仍是规范值返回（不经 throw）', async () => {
    const wrapped = safeHandler(async () => ({ error: 'script not whitelisted: foo' }));
    const r = await wrapped({});
    expect(r.error).toContain('not whitelisted');
    // 关键区分：这是正常返回（isError=false 的规范值），渲染器解释状态
    expect(typeof r.error).toBe('string');
  });

  it('成功值原样透传（含 exec 透传）', async () => {
    const wrapped = safeHandler(async (args, exec) => ({
      echoed: true,
      hasSignal: exec?.signal instanceof AbortSignal,
      args,
    }));
    const ac = new AbortController();
    const r = await wrapped({ x: 1 }, { signal: ac.signal });
    expect(r.echoed).toBe(true);
    expect(r.hasSignal).toBe(true);
    expect(r.args).toEqual({ x: 1 });
  });
});

describe('cycle-22 normalizeToolResult 双形状归一化', () => {
  it('官方形状：meta 携带持久化事实（exitCode/stdout）', () => {
    const r = normalizeToolResult({
      content: [{ type: 'text', text: 'JSON dump' }],
      isError: false,
      meta: { exitCode: 0, stdout: 'pass', stderr: '' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('pass');
    expect(r.isError).toBe(false);
  });

  it('官方形状：meta 无输出时从 content 文本块兜底', () => {
    const r = normalizeToolResult({
      content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
      isError: true,
      meta: {},
    });
    expect(r.stdout).toBe('line1\nline2');
    expect(r.isError).toBe(true);
  });

  it('官方形状：isError=true 直通', () => {
    const r = normalizeToolResult({ content: [], isError: true, meta: {} });
    expect(r.isError).toBe(true);
  });

  it('宽容形状（宿主 0.2.0-rc.2 直传）：原样返回', () => {
    const raw = { exitCode: 1, stdout: 'out', stderr: 'err', timedOut: false };
    expect(normalizeToolResult(raw)).toBe(raw);
  });
});

describe('cycle-22 terminalResult 双形状（经 normalizeToolResult）', () => {
  it('官方形状下渲染终端卡片（meta 事实优先）', () => {
    const view = terminalResult({
      content: [{ type: 'text', text: 'dump' }],
      isError: false,
      meta: { exitCode: 2, stdout: 'gate FAIL', stderr: 'G1 no task rows' },
    });
    expect(view.card).toBe('terminal');
    expect(view.exitCode).toBe(2);
    expect(view.output).toContain('gate FAIL');
    expect(view.output).toContain('G1 no task rows');
  });

  it('宽容形状下行为与旧版完全一致（回归锚点）', () => {
    const view = terminalResult({ exitCode: 0, stdout: 'done', stderr: '' });
    expect(view.exitCode).toBe(0);
    expect(view.output).toBe('done');
  });

  it('纯函数：相同输入→相同输出（官方硬性规则）', () => {
    const r = { content: [{ type: 'text', text: 'x' }], isError: false, meta: { exitCode: 0 } };
    expect(terminalResult(r)).toEqual(terminalResult(r));
  });
});
