/**
 * **披露运行时读数**契约（cycle-93）—— 把「不可查证」变成「任何时刻可查」。
 *
 * ## 为什么需要（修 O-92-02 / O-92-04 的根本困难）
 *
 * cycle-92 修掉了披露自锁，但留下两个**无法查证**的项：
 * - O-92-02「按需解锁是否真的生效」；
 * - O-92-04「`tools/change` 是否真的发出」。
 *
 * 共同根因**不是"没做真机验证"**，而是**披露状态没有任何出口**：
 * 状态存在内存 `WeakMap`/`Set` 里，只在 `log.info` 出现过一次；
 * `P8` 探针只查**静态可激活性**（deny 集合 + 加载器在场），不查**运行时发生了什么**。
 *
 * ⇒ 即便切到 indexed 并重启会话，**同样看不到**内部状态，只能靠"模型能不能调通"
 * 间接推断 —— 这就是"验证困难"的真正来源。
 *
 * ## 本文件钉什么
 *
 * 读数必须能回答：① 几个 agent 被遮蔽；② 每个遮蔽多少工具；③ 谁解锁了什么；
 * ④ `tools/change` 发了几次。**且这些数字必须随真实操作变化**（防"恒为 0"的假读数）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildDisclosureReadout,
  noteToolsChangeEmit,
  resetToolsChangeEmitCount,
  toolsChangeEmitCount,
  summarizeDisclosure,
  unlockChannelActive,
} from '../../src/host/runtime/disclosureReadout.ts';
import {
  rememberDisclosure,
  unlockTool,
  forgetDisclosure,
  trackAgent,
  recomputeDeny,
} from '../../src/host/runtime/disclosureActivation.ts';
import { registerDisclosureRoute } from '../../src/host/routes/disclosureRoute.ts';

const ALL = ['anic_a', 'anic_b', 'anic_c', 'anic_tools_search', 'anic_tool_detail'];
const LOADERS = ['anic_tools_search', 'anic_tool_detail'];

/**
 * 真实初态：`recomputeDeny(all, loaders, ∅)`。
 *
 * ⚠️ 为什么不能手写 `['anic_a']`：那**不是**接线层会产生的状态。
 * 手写值会让「解锁后 deny 数量」的断言失去意义（可能**增加**）——
 * 本文件第一版就踩了这个坑（日志出现 `deny 1 → 2`）。
 */
const INITIAL_DENY = recomputeDeny(ALL, LOADERS, new Set());

/** 造一个记录 restrict 的 agent。 */
function makeAgent(): { agent: { ctx: { tools: { restrict: (f: { deny: string[] }) => () => void }; emit: (n: string) => void } } } {
  const agent = {
    ctx: {
      tools: { restrict: (_f: { deny: string[] }) => () => undefined },
      emit: (_n: string) => undefined,
    },
  };
  return { agent };
}

describe('cycle-93：披露读数（buildDisclosureReadout）', () => {
  beforeEach(() => { resetToolsChangeEmitCount(); });

  it('**无 agent 时**如实报 0（不是编一个数）', () => {
    const r = buildDisclosureReadout('2026-01-01T00:00:00.000Z');
    expect(r.trackedAgents).toBe(0);
    expect(r.agents).toEqual([]);
    expect(r.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('**遮蔽中的 agent 如实报告** deny 数 + restricted 状态', () => {
    const { agent } = makeAgent();
    const deny = INITIAL_DENY;
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny, disposer: () => undefined });
    trackAgent(agent);

    const r = buildDisclosureReadout();
    expect(r.trackedAgents).toBeGreaterThanOrEqual(1);
    const mine = r.agents.find((a) => a.denyCount === 3);
    expect(mine, '应能读到 deny=3 的 agent').toBeDefined();
    expect(mine?.allToolCount).toBe(ALL.length);
    expect(mine?.loaderCount).toBe(LOADERS.length);
    expect(mine?.restricted).toBe(true);
    expect(mine?.unlocked).toEqual([]);
    forgetDisclosure(agent);
  });

  it('**解锁后读数必须变**（这是 O-92-02 的直接证据）', () => {
    const { agent } = makeAgent();
    const deny = INITIAL_DENY;
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny, disposer: () => undefined });
    trackAgent(agent);

    const before = buildDisclosureReadout().agents.find((a) => a.allToolCount === ALL.length);
    expect(before?.denyCount).toBe(INITIAL_DENY.length);

    unlockTool(agent, 'anic_a');

    const after = buildDisclosureReadout().agents.find((a) => a.allToolCount === ALL.length);
    expect(after?.denyCount, '解锁后 deny 必须减少').toBe(INITIAL_DENY.length - 1);
    expect(after?.unlocked, '已解锁列表必须含目标工具').toContain('anic_a');
    forgetDisclosure(agent);
  });

  it('**`tools/change` 计数随发出递增**（O-92-04 的直接证据）', () => {
    resetToolsChangeEmitCount();
    expect(toolsChangeEmitCount()).toBe(0);
    noteToolsChangeEmit();
    expect(toolsChangeEmitCount()).toBe(1);
    noteToolsChangeEmit();
    expect(toolsChangeEmitCount()).toBe(2);
    expect(buildDisclosureReadout().toolsChangeEmits).toBe(2);
  });

  it('**解锁会真的增加 `tools/change` 计数**（端到端串联）', () => {
    resetToolsChangeEmitCount();
    const { agent } = makeAgent();
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: INITIAL_DENY, disposer: () => undefined });
    trackAgent(agent);
    const before = toolsChangeEmitCount();
    unlockTool(agent, 'anic_a');
    expect(toolsChangeEmitCount(), '解锁必须发 tools/change 并计数').toBe(before + 1);
    forgetDisclosure(agent);
  });

  it('`fullyMaskedAgents` 只在「除加载器外全遮」时为真', () => {
    const { agent } = makeAgent();
    
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: INITIAL_DENY, disposer: () => undefined });
    trackAgent(agent);
    const r1 = buildDisclosureReadout();
    expect(r1.fullyMaskedAgents).toBeGreaterThanOrEqual(1);

    unlockTool(agent, 'anic_a');
    const r2 = buildDisclosureReadout();
    expect(r2.fullyMaskedAgents, '解锁后不再是全遮').toBeLessThan(r1.fullyMaskedAgents);
    forgetDisclosure(agent);
  });

  it('**销毁后读数归零**（防泄漏，且证明读数不缓存）', () => {
    const { agent } = makeAgent();
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: INITIAL_DENY, disposer: () => undefined });
    trackAgent(agent);
    const before = buildDisclosureReadout();
    expect(before.agents.some((a) => a.allToolCount === ALL.length && a.unlocked.length === 0)).toBe(true);
    const beforeTracked = before.trackedAgents;

    forgetDisclosure(agent);

    // `forgetDisclosure` 必须**同时**清状态与 tracked（cycle-93 修正：此前只清
    // WeakMap，`tracked` 靠调用方另调 `untrackAgent` ⇒ 漏调时读数虚高）。
    const after = buildDisclosureReadout();
    expect(after.trackedAgents, '销毁后 tracked 必须减少').toBeLessThan(beforeTracked);
    expect(
      after.agents.some((a) => a.allToolCount === ALL.length && a.unlocked.length === 0),
      '销毁后不应再有该 agent 的明细（读数不缓存陈旧状态）',
    ).toBe(false);
  });

  it('`unlockChannelActive` 只在有解锁记录时为真', () => {
    const { agent } = makeAgent();
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: INITIAL_DENY, disposer: () => undefined });
    trackAgent(agent);
    expect(unlockChannelActive(buildDisclosureReadout())).toBe(false);
    unlockTool(agent, 'anic_a');
    expect(unlockChannelActive(buildDisclosureReadout())).toBe(true);
    forgetDisclosure(agent);
  });

  it('`summarizeDisclosure` 无 agent 时给可读的一句话', () => {
    const r = buildDisclosureReadout();
    const s = summarizeDisclosure(r);
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/agents=|no agent/);
  });
});

describe('cycle-93：GET /anic/api/disclosure 路由', () => {
  it('返回 200 + 读数形状（**不需要工作区**）', () => {
    let handler: ((req: unknown, res: unknown) => void) | undefined;
    const ctx = {
      webServer: {
        register: (route: { handler: (q: unknown, s: unknown) => void }) => {
          handler = route.handler;
          return () => undefined;
        },
      },
    };
    let last = { code: 0, body: {} as Record<string, unknown> };
    registerDisclosureRoute(ctx, (_r, code, body) => { last = { code, body: body as Record<string, unknown> }; });
    expect(handler, '路由必须被注册').toBeDefined();
    handler?.({}, {});
    expect(last.code).toBe(200);
    expect(typeof last.body['trackedAgents']).toBe('number');
    expect(typeof last.body['toolsChangeEmits']).toBe('number');
    expect(typeof last.body['generatedAt']).toBe('string');
    expect(typeof last.body['summary']).toBe('string');
    expect(Array.isArray(last.body['agents'])).toBe(true);
  });

  it('**无 webServer（老代宿主）⇒ 返回空数组**（安全降级）', () => {
    expect(registerDisclosureRoute({}, () => undefined)).toEqual([]);
  });
});
