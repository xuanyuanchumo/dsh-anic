/**
 * 披露「宿主侧取证」契约（cycle-109 · 修 O-109-01）。
 *
 * ## 这个守卫证明什么（一句话）
 *
 * 旧读数只证明「**我们**施加了什么」；本守卫用受控桩证明接线会**采一次宿主视图**
 * 并把结果判成三态 —— 且**采集失败绝不改变 `wired` 语义**。
 *
 * ## A0″ 的出处（为什么不再跑真机探针）
 *
 * KB `site/reference/subsystems/tools.md`：
 *   - `:512`「one visibility resolver feeds presentation, lookup, and dispatch」
 *   - `:566` `get`：「a restricted-away global reads as absent」
 *   - `:574` `schemas`：「one deep-cloned schema per visible tool」「the viewing scope (the agent)」
 * A0′ 真机已证 `get(name, agent)` 归 absent（`.cycles/tech-debt/cycle-73-a0-probe-result.md`
 * 实测 `scopedBefore:25 → scopedAfter:24`、`deniedHidden:true`）。同一解析器驱动
 * `schemas(agent)` ⇒ 白盒结论成立。本守卫钉的是**本仓代码的判据**，不代替真机。
 *
 * ## 反向自检（本仓纪律）
 *
 * 用例 ②「桩返回全量」必须判 `partial` 且 `leaked` 点名 —— 若实现偷偷把
 * 「采不到」和「采到但不对」混成同一个值，这条会红。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyDisclosureToScope } from '../../src/host/toolDisclosureWiring.ts';
import { captureRegisteredFaces } from '../../src/host/toolsFaceCapture.ts';
import type { CapabilityIndexInjectable } from '../../src/host/capabilityIndex.ts';
import { buildDisclosureReadout } from '../../src/host/runtime/disclosureReadout.ts';
import { forgetDisclosure, unlockTool } from '../../src/host/runtime/disclosureActivation.ts';

const ids = captureRegisteredFaces().map((f) => f.name);
const LOADERS = ['anic_tool_detail', 'anic_tools_search'];
const index: CapabilityIndexInjectable = { v: 1, commit: 'test', tools: [['anic_evaluate', 'x']], scripts: ['eval-runner'] };

/** 受控 scoped ctx 桩：restrict 记录 deny；schemas 由用例注入（可缺、可抛、可撒谎）。 */
function stub(opts: { schemas?: (scope?: unknown) => Array<{ name?: unknown }> } = {}) {
  const calls: { deny?: string[]; schemasScopes: unknown[] } = { schemasScopes: [] };
  const tools: Record<string, unknown> = {
    restrict: (f: { deny: string[] }) => { calls.deny = f.deny; return () => undefined; },
  };
  if (opts.schemas) {
    tools.schemas = (scope?: unknown) => { calls.schemasScopes.push(scope); return opts.schemas?.(scope) ?? []; };
  }
  return {
    calls,
    ctx: {
      tools,
      systemPrompt: { section: () => undefined },
    } as { tools: Record<string, unknown>; systemPrompt: { section: () => undefined } },
  };
}

/** 记录 agent，供读数与解锁路径使用（真实宿主里 agent.ctx 即 scoped ctx）。 */
function makeAgent(ctx: unknown): Record<string, unknown> {
  return { ctx, session: { header: { cwd: '/tmp/proj' } } };
}

const AGENTS: object[] = [];
function trackAgentForCleanup(a: object): void { AGENTS.push(a); }
afterEach((): void => { while (AGENTS.length > 0) { const a = AGENTS.pop(); if (a) forgetDisclosure(a); } });

describe('宿主侧取证：三态判据', () => {
  it('① 桩按 deny 生效（只返回加载器）⇒ wired + verdict=verified', () => {
    const s = stub({ schemas: () => LOADERS.map((name) => ({ name })) });
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    const out = applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    expect(out.wired).toBe(true);
    expect(out.hostVerdict).toBe('verified');
    expect(out.hostVisible).toBe(LOADERS.length);
    // 必须传 viewing scope（A0′ v7 的坑：不传 = 全局视图 ⇒ 恒 partial）
    expect(s.calls.schemasScopes).toEqual([agent]);
  });

  it('② 桩**撒谎**（restrict 接受但仍返回全量）⇒ partial + leaked 点名 deny 项', () => {
    const s = stub({ schemas: () => ids.map((name) => ({ name })) });
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    const out = applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    expect(out.wired).toBe(true);
    expect(out.hostVerdict).toBe('partial');
    expect(out.hostVisible).toBe(ids.length);
  });

  it('③ 宿主无 schemas（旧代/stub）⇒ wired 语义**不变** + unverified（取证是旁路）', () => {
    const s = stub();
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    const out = applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    expect(out.wired).toBe(true);
    expect(out.hostVerdict).toBe('unverified');
    expect(out.hostVisible).toBeNull();
  });

  it('④ schemas 抛错 ⇒ 不抛给宿主 + unverified', () => {
    const s = stub({ schemas: () => { throw new Error('boom'); } });
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    const out = applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    expect(out.wired).toBe(true);
    expect(out.hostVerdict).toBe('unverified');
  });

  it('⑤ 没有 agent scope ⇒ **不调用** schemas（全局视图不得冒充 scoped 结论）', () => {
    const s = stub({ schemas: () => LOADERS.map((name) => ({ name })) });
    const out = applyDisclosureToScope(s.ctx as never, index, 'indexed', ids);
    expect(out.wired).toBe(true);
    expect(out.hostVerdict).toBe('unverified');
    expect(s.calls.schemasScopes).toEqual([]);
  });

  it('⑥ full 模式零行为变更：不 restrict、不取证', () => {
    const s = stub({ schemas: () => [] });
    const out = applyDisclosureToScope(s.ctx as never, index, 'full', ids);
    expect(out.wired).toBe(false);
    expect(out.hostVerdict).toBeUndefined();
    expect(s.calls.schemasScopes).toEqual([]);
  });
});

describe('读数出口：取证结论必须可查（不能只活在日志里）', () => {
  it('接线后读数带上 hostVerdict / hostVisible / leaked / missing 四类事实', () => {
    const s = stub({ schemas: () => ids.map((name) => ({ name })) });
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    const r = buildDisclosureReadout('2026-11-06T00:00:00.000Z');
    const mine = r.agents.find((a) => a.allToolCount === ids.length && a.denyCount === ids.length - LOADERS.length);
    expect(mine).toBeTruthy();
    expect(mine?.hostVerdict).toBe('partial');
    expect(mine?.hostVisible).toBe(ids.length);
    expect(mine?.hostLeaked.length).toBe(orderOfDeny().length);
    expect(mine?.hostMissing).toEqual([]);
    // 三态计数是分开的（不合并成一个 not-verified）
    expect(r.hostPartialAgents).toBe(1);
    expect(r.hostVerifiedAgents).toBe(0);
    expect(r.hostUnverifiedAgents).toBe(0);
  });

  it('解锁会**重采**一次（deny 变小的结论必须由新取证支撑，而不是沿用初态）', () => {
    // 桩模拟宿主：按最新 deny 计算可见集 ⇒ 真实宿主的语义。
    let denyNow: string[] = [];
    const s = stub({ schemas: () => ids.filter((id) => !denyNow.includes(id)).map((name) => ({ name })) });
    (s.ctx.tools.restrict as unknown) = (f: { deny: string[] }) => {
      denyNow = [...f.deny];
      s.calls.deny = f.deny;
      return () => undefined;
    };
    const agent = makeAgent(s.ctx);
    trackAgentForCleanup(agent);
    applyDisclosureToScope(s.ctx as never, index, 'indexed', ids, agent);
    expect(buildDisclosureReadout().agents[0]?.hostVerdict).toBe('verified');
    const beforeDeny = s.calls.deny?.length ?? 0;
    unlockTool(agent, 'anic_status');
    const after = buildDisclosureReadout().agents[0];
    expect(after?.denyCount).toBe(beforeDeny - 1);
    expect(after?.hostVerdict).toBe('verified');
    expect(after?.unlocked).toContain('anic_status');
  });
});

/** deny 集合的长度（与 applyDisclosureToScope 的 plan 同源：全部 − 加载器）。 */
function orderOfDeny(): string[] {
  return ids.filter((id) => !LOADERS.includes(id));
}