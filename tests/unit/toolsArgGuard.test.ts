/**
 * 工具未知参数键守卫契约（cycle-89 T-04）。
 *
 * ## 被守卫的缺陷
 *
 * 宿主 `ctx.tools.register(definition)` 对 plain-object 定义**只校验 `output.schema`**，
 * **不校验 `parameters`**；模型 arguments 原样进 `execute`。各网关按 `args?.foo`
 * 取已知字段，**未知键被静默丢弃** —— 调用报告成功，却忽略了调用方要求的东西。
 *
 * 真机风险例：`anic_autonomy_upgrade` 的 `reason` 拼成 `Reason` 时，旧实现
 * 会**当作没传**而继续执行升级：授权理由消失，调用仍返回「成功」。
 *
 * ## 守卫位置
 *
 * 接在 `wireGuard`（全部工具的**唯一注册出口**）→ 对新工具自动生效，
 * 无需在 20+ 个 gateway 里逐个打补丁。
 */
import { describe, expect, it } from 'vitest';
import { assertKnownArguments, knownArgumentKeys, withArgumentGuard } from '../../src/host/toolsArgGuard.ts';
import { wireGuard } from '../../src/host/toolsSlot.ts';
import type { ToolRegistration } from '../../src/host/toolsSlot.ts';

/** 构造一个最小工具注册（parameters 有 properties）。 */
function toolWith(properties: Record<string, unknown>, execute?: ToolRegistration['execute']): ToolRegistration {
  return {
    name: 'anic_test_tool',
    description: 'test',
    parameters: { type: 'object', properties },
    execute: execute ?? (async () => ({ ok: true })),
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] },
  };
}

describe('knownArgumentKeys：从 schema 反射合法键', () => {
  it('反射出 properties 的键', () => {
    const keys = knownArgumentKeys({ type: 'object', properties: { a: {}, b: {} } });
    expect(keys).not.toBeNull();
    expect([...(keys ?? [])]).toEqual(['a', 'b']);
  });

  it('**schema 无 properties → 返回 null（表示「不知道」，不做校验）**', () => {
    expect(knownArgumentKeys({ type: 'object' })).toBeNull();
    expect(knownArgumentKeys({ type: 'string' })).toBeNull();
    expect(knownArgumentKeys({ type: 'object', properties: {} })).toBeNull();
    expect(knownArgumentKeys({ type: 'object', properties: [] })).toBeNull();
  });
});

describe('assertKnownArguments：未知键响亮拒绝', () => {
  const known = new Set(['reason', 'humanAuthorized']);

  it('全部合法 → 平凡通过', () => {
    expect(() => { assertKnownArguments('t', { reason: 'x', humanAuthorized: true }, known); }).not.toThrow();
  });

  it('空参数 → 平凡通过', () => {
    expect(() => { assertKnownArguments('t', {}, known); }).not.toThrow();
  });

  it('**未知键 → 抛错且消息点名该键**', () => {
    let caught: unknown;
    try { assertKnownArguments('anic_autonomy_upgrade', { reason: 'x', Reason: 'y' }, known); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('anic_autonomy_upgrade');
    expect(msg).toContain('"Reason"');
    expect(msg).toContain('unknown argument key');
  });

  it('多个未知键 → 全部点名（复数形态）', () => {
    let caught: unknown;
    try { assertKnownArguments('t', { a: 1, b: 2 }, known); } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('unknown argument keys');
    expect((caught as Error).message).toContain('"a"');
    expect((caught as Error).message).toContain('"b"');
  });

  it('**known 为 null → 不校验（不拒掉一切合法调用）**', () => {
    expect(() => { assertKnownArguments('t', { anything: 1 }, null); }).not.toThrow();
  });

  it('参数非普通对象 → 不校验', () => {
    expect(() => { assertKnownArguments('t', [] as unknown as Record<string, unknown>, known); }).not.toThrow();
    expect(() => { assertKnownArguments('t', null as unknown as Record<string, unknown>, known); }).not.toThrow();
  });
});

describe('wireGuard 接线：守卫对全部工具自动生效', () => {
  it('**未知键在 execute 之前就被拒（inner 从未被调用）**', () => {
    let innerCalled = false;
    const tool = toolWith({ reason: {} }, async () => { innerCalled = true; return { ok: true }; });
    const guarded = wireGuard(tool);
    return expect(guarded.execute({ reason: 'x', bogus: 1 })).rejects.toThrow(/unknown argument key/);
  });

  it('合法调用正常通过', async () => {
    const tool = toolWith({ reason: {} }, async () => ({ ok: true }));
    const guarded = wireGuard(tool);
    await expect(guarded.execute({ reason: 'x' })).resolves.toEqual({ ok: true });
  });

  it('withArgumentGuard 保持 inner 的执行语义（返回值原样透出）', async () => {
    const tool = toolWith({ a: {} });
    const inner = async (): Promise<Record<string, unknown>> => ({ seen: true });
    const wrapped = withArgumentGuard(tool, inner);
    await expect(wrapped({ a: 1 })).resolves.toEqual({ seen: true });
  });
});
