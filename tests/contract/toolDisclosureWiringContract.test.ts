/**
 * 按需加载接线契约（cycle-74 T-7406）——判定路径与「绝不半途遮蔽」。
 *
 * 前置：A0′ 已真机 PASS（scoped ctx 上 restrict 生效）；加载器工具已注册。
 * 本守卫用**受控宿主桩**验证接线的判定路径（不需要真机）。
 *
 * 诚实边界：本守卫证明「判定正确 + 失败全部回落 full」；
 * 「真机 indexed 下 scope 视图确实收缩」属真机验收（A3/A4），**本轮未验证**。SKIP ≠ PASS。
 */
import { describe, it, expect } from 'vitest';
import { applyDisclosureToScope, wireToolDisclosure, rootOfAgent } from '../../src/host/toolDisclosureWiring.ts';
import { captureRegisteredFaces } from '../../src/host/toolsFaceCapture.ts';
import type { CapabilityIndexInjectable } from '../../src/host/capabilityIndex.ts';

const ids = captureRegisteredFaces().map((f) => f.name);
const index: CapabilityIndexInjectable = { v: 1, commit: 'test', tools: [['anic_evaluate', 'x']], scripts: ['eval-runner'] };

/** 受控 scoped ctx 桩：记录 restrict/section 调用。 */
function scopedStub() {
  const calls: { deny?: string[]; section?: string } = {};
  return {
    calls,
    ctx: {
      tools: {
        restrict: (f: { deny: string[] }) => { calls.deny = f.deny; return () => undefined; },
      },
      systemPrompt: { section: (s: { name: string; text: string }) => { calls.section = s.text; return undefined; } },
    },
  };
}

describe('cycle-74 T-7406 按需加载接线契约', () => {
  it('full 模式：不接线、不产生任何副作用（A8 零行为变更）', () => {
    const { ctx, calls } = scopedStub();
    const out = applyDisclosureToScope(ctx, index, 'full', ids);
    expect(out.wired).toBe(false);
    expect(calls.deny).toBeUndefined();
    expect(calls.section).toBeUndefined();
    // wire 层同样：full 时**连监听器都不注册**
    let registered = 0;
    const host = { on: () => { registered++; } };
    const w = wireToolDisclosure(host, { mode: 'full', index, allToolIds: ids });
    expect(w.wired).toBe(false);
    expect(registered).toBe(0);
  });

  it('indexed 模式：施加 restrict（deny 不含加载器）+ 注入索引 section', () => {
    const { ctx, calls } = scopedStub();
    const out = applyDisclosureToScope(ctx, index, 'indexed', ids);
    expect(out.wired).toBe(true);
    expect(out.denyCount).toBe(ids.length - 2);
    for (const l of ['anic_tool_detail', 'anic_tools_search']) expect(calls.deny).not.toContain(l);
    expect(calls.section).toContain('anic_evaluate');
  });

  it('绝不半途遮蔽：宿主无 scoped restrict ⇒ 保持 full（不注入、不遮蔽）', () => {
    const out = applyDisclosureToScope({}, index, 'indexed', ids);
    expect(out.wired).toBe(false);
    expect(out.reason).toContain('restrict');
    expect(out.denyCount).toBe(0);
  });

  it('绝不半途遮蔽：restrict 抛错 ⇒ 回落 full 且原因如实', () => {
    const ctx = { tools: { restrict: () => { throw new Error('boom'); } } };
    const out = applyDisclosureToScope(ctx, index, 'indexed', ids);
    expect(out.wired).toBe(false);
    expect(out.reason).toContain('boom');
  });

  it('自锁防护：加载器缺失 ⇒ indexed 不可施加（拒绝切档）', () => {
    const without = ids.filter((i) => i !== 'anic_tool_detail' && i !== 'anic_tools_search');
    const { ctx, calls } = scopedStub();
    const out = applyDisclosureToScope(ctx, index, 'indexed', without);
    expect(out.wired).toBe(false);
    expect(calls.deny).toBeUndefined();
  });

  it('宿主无 ctx.on（旧代/stub）⇒ 保持 full，不抛错', () => {
    const out = wireToolDisclosure({}, { mode: 'indexed', index, allToolIds: ids });
    expect(out.wired).toBe(false);
    expect(out.reason).toContain('ctx.on');
  });

  it('纪律① 反向自检：indexed 下若 deny 含加载器，本契约必须能识别为违规', () => {
    const { ctx, calls } = scopedStub();
    applyDisclosureToScope(ctx, index, 'indexed', ids);
    const leaked = ['anic_tool_detail', 'anic_tools_search'].filter((l) => (calls.deny ?? []).includes(l));
    expect(leaked, '加载器被遮蔽（自锁）').toEqual([]);
    // 反证：人为构造违规集合，检查判据确实能抓
    const bad = [...(calls.deny ?? []), 'anic_tool_detail'];
    expect(['anic_tool_detail', 'anic_tools_search'].filter((l) => bad.includes(l)).length).toBeGreaterThan(0);
  });
});
describe('cycle-74 T-7408 per-agent 解析（修多工作区错配）', () => {
  /** 受控 host 桩：捕获 agent/created 处理器，供手工投递。 */
  function hostStub() {
    let handler: ((p: { agent?: unknown }) => void) | null = null;
    return {
      host: { on: (_n: string, h: (p: { agent?: unknown }) => void) => { handler = h; return undefined; } },
      emit: (agent: unknown) => handler?.({ agent }),
      isRegistered: () => handler !== null,
    };
  }
  /** 造一个「带 cwd 的 agent」：会话头 cwd 即其工作区。 */
  function agentWithCwd(cwd: string | null) {
    const calls: { deny?: string[]; section?: string } = {};
    return {
      calls,
      agent: {
        session: cwd ? { header: { cwd } } : { header: {} },
        ctx: {
          tools: { restrict: (f: { deny: string[] }) => { calls.deny = f.deny; return () => undefined; } },
          systemPrompt: { section: (s: { name: string; text: string }) => { calls.section = s.text; return undefined; } },
        },
      },
    };
  }

  it('rootOfAgent：只认字符串 cwd，否则 null（宁缺勿猜）', () => {
    expect(rootOfAgent(agentWithCwd('D:/p/a').agent)).toBe('D:/p/a');
    expect(rootOfAgent(agentWithCwd(null).agent)).toBeNull();
    expect(rootOfAgent({})).toBeNull();
    expect(rootOfAgent({ session: { header: { cwd: 123 } } })).toBeNull();
  });

  it('多工作区不错配：A=indexed / B=full ⇒ 各自按其解析结果施加', () => {
    const h = hostStub();
    const byRoot = new Map([['D:/p/a', 'indexed'], ['D:/p/b', 'full']]);
    const out = wireToolDisclosure(h.host, {
      mode: 'full',
      index: null,
      allToolIds: ids,
      resolveForAgent: (agent) => {
        const root = rootOfAgent(agent) ?? '';
        return byRoot.get(root) === 'indexed' ? { mode: 'indexed', index } : { mode: 'full', index: null };
      },
    });
    expect(out.wired).toBe(true);
    expect(h.isRegistered()).toBe(true);

    const a = agentWithCwd('D:/p/a');
    h.emit(a.agent);
    expect(a.calls.deny, 'A 项目应被激活').toBeDefined();
    expect(a.calls.section, 'A 项目应注入索引').toBeDefined();

    const b = agentWithCwd('D:/p/b');
    h.emit(b.agent);
    expect(b.calls.deny, 'B 项目必须**不**被激活（否则是错配）').toBeUndefined();
    expect(b.calls.section).toBeUndefined();
  });

  it('agent 无 cwd ⇒ 回落 full（不猜工作区）', () => {
    const h = hostStub();
    wireToolDisclosure(h.host, { mode: 'full', index: null, allToolIds: ids, resolveForAgent: (a) => (rootOfAgent(a) ? { mode: 'indexed', index } : { mode: 'full', index: null }) });
    const n = agentWithCwd(null);
    h.emit(n.agent);
    expect(n.calls.deny).toBeUndefined();
  });

  it('有 per-agent 解析器时必须注册监听器（即便全局 mode=full）', () => {
    const h = hostStub();
    const out = wireToolDisclosure(h.host, { mode: 'full', index: null, allToolIds: ids, resolveForAgent: () => ({ mode: 'full', index: null }) });
    expect(out.wired).toBe(true);
    expect(h.isRegistered()).toBe(true);
  });

  it('indexed 但索引缺失 ⇒ 该 agent 保持 full（不猜索引）', () => {
    const h = hostStub();
    wireToolDisclosure(h.host, { mode: 'full', index: null, allToolIds: ids, resolveForAgent: () => ({ mode: 'indexed', index: null }) });
    const a = agentWithCwd('D:/p/a');
    h.emit(a.agent);
    expect(a.calls.deny).toBeUndefined();
  });
});
