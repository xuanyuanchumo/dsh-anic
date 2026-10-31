/**
 * **渐进式披露的按需解锁**契约（cycle-92）—— 修「自锁」。
 *
 * ## 实测缺陷（cycle-91 审计与研究共同指出的 P0）
 *
 * indexed 模式：`restrict({ deny: [除 2 个加载器外的全部 21 个工具] })`
 * ⇒ 模型只看得见 `anic_tools_search` / `anic_tool_detail`。
 *
 * 设计意图：模型用 search/detail 取回 schema，**再调用目标工具**。
 *
 * **但 `anic_tool_detail` 只返回 schema 文本，从不把目标工具变可见**
 * ⇒ 模型取回 schema 后**依然调不到**那个工具 ⇒ **21/23 个工具永久不可用**。
 *
 * 这不是"披露收益低"，是**功能性丧失**。
 *
 * ## 为什么「再施加一条更窄的 restriction」不行
 *
 * 宿主契约（`tools.md`）：restriction **取交集**，且「链上任一层拒绝即不可见」
 * ⇒ 旧 restriction 仍在时，新增更窄的一条**不会解锁**任何东西。
 *
 * ⇒ 解锁的唯一正确做法：**先调用旧 restriction 的 disposer 撤销它，
 *   再施加一条新的（deny 已缩减）**。本文件钉死这条顺序。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  rememberDisclosure,
  unlockTool,
  disclosureOf,
  forgetDisclosure,
  recomputeDeny,
  trackedAgentCount,
  trackAgent,
} from '../../src/host/runtime/disclosureActivation.ts';

const ALL = ['anic_a', 'anic_b', 'anic_c', 'anic_tools_search', 'anic_tool_detail'];
const LOADERS = ['anic_tools_search', 'anic_tool_detail'];

/** 造一个记录 restrict 调用的桩 agent。 */
function makeAgent(): {
  agent: { ctx: { tools: { restrict: (f: { deny: string[] }) => () => void }; emit: (n: string) => void } };
  calls: Array<{ deny: string[]; lifted: boolean }>;
  emits: string[];
} {
  const calls: Array<{ deny: string[]; lifted: boolean }> = [];
  const emits: string[] = [];
  const agent = {
    ctx: {
      tools: {
        restrict: (f: { deny: string[] }) => {
          const rec = { deny: f.deny, lifted: false };
          calls.push(rec);
          // disposer 把该条标记为已撤销（模拟宿主语义）。
          return () => { rec.lifted = true; };
        },
      },
      emit: (n: string) => { emits.push(n); },
    },
  };
  return { agent, calls, emits };
}

/** 该 agent 当前**未被任何生效 restriction** 拒绝的工具集合。 */
function visibleNow(calls: Array<{ deny: string[]; lifted: boolean }>): string[] {
  return ALL.filter((id) => !calls.some((c) => !c.lifted && c.deny.includes(id)));
}

describe('cycle-92：recomputeDeny（纯函数）', () => {
  it('加载器**永不**进 deny（否则自锁）', () => {
    const deny = recomputeDeny(ALL, LOADERS, new Set());
    expect(deny).toEqual(['anic_a', 'anic_b', 'anic_c']);
    for (const l of LOADERS) expect(deny, '加载器必须在 deny 之外').not.toContain(l);
  });

  it('已解锁的工具从 deny 移除', () => {
    const deny = recomputeDeny(ALL, LOADERS, new Set(['anic_a']));
    expect(deny).toEqual(['anic_b', 'anic_c']);
  });

  it('全部解锁 ⇒ deny 为空（零遮蔽）', () => {
    const deny = recomputeDeny(ALL, LOADERS, new Set(['anic_a', 'anic_b', 'anic_c']));
    expect(deny).toEqual([]);
  });

  it('**顺序稳定**（保持 allToolIds 原序，同输入同输出）', () => {
    const a = recomputeDeny(ALL, LOADERS, new Set(['anic_b']));
    const b = recomputeDeny(ALL, LOADERS, new Set(['anic_b']));
    expect(a).toEqual(b);
    expect(a).toEqual(['anic_a', 'anic_c']);
  });
});

describe('cycle-92：unlockTool（按需解锁，真机语义模拟）', () => {
  beforeEach(() => { /* 每个用例独立 agent，无需清理 */ });

  it('**核心断言：解锁后该工具真的变可见**（修复前永久不可见）', () => {
    const { agent, calls } = makeAgent();
    // 模拟接线层的初始遮蔽。
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });
    expect(visibleNow(calls), '初始只应看见两个加载器').toEqual(LOADERS);

    const out = unlockTool(agent, 'anic_a');
    expect(out.newlyUnlocked).toBe(true);
    expect(out.callable, '解锁后必须报告可调用').toBe(true);
    expect(visibleNow(calls), '解锁后 anic_a 必须真的可见').toContain('anic_a');
    // 加载器仍可见。
    for (const l of LOADERS) expect(visibleNow(calls)).toContain(l);
  });

  it('**先撤旧再施加新**（交集语义下这是解锁的前提）', () => {
    const { agent, calls } = makeAgent();
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });

    unlockTool(agent, 'anic_a');
    // 旧 restriction 必须已被撤销（否则交集下 anic_a 仍不可见）。
    expect(calls[0]?.lifted, '旧 restriction 必须先撤销').toBe(true);
    expect(calls.length, '必须施加一条新的 restriction').toBe(2);
    expect(calls[1]?.deny, '新 deny 不应含已解锁的工具').not.toContain('anic_a');
  });

  it('**幂等**：重复解锁同一工具不报错，报告 alreadyUnlocked 语义', () => {
    const { agent } = makeAgent();
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });

    const first = unlockTool(agent, 'anic_a');
    const second = unlockTool(agent, 'anic_a');
    expect(first.newlyUnlocked).toBe(true);
    expect(second.newlyUnlocked, '第二次不是"新"解锁').toBe(false);
    expect(second.callable, '但依然可调用').toBe(true);
  });

  it('**累积解锁**：解锁 A 再解锁 B，两者都可见', () => {
    const { agent, calls } = makeAgent();
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });

    unlockTool(agent, 'anic_a');
    unlockTool(agent, 'anic_b');
    const vis = visibleNow(calls);
    expect(vis).toContain('anic_a');
    expect(vis).toContain('anic_b');
    expect(vis).not.toContain('anic_c');
  });

  it('**加载器本身**解锁 ⇒ 恒可调用（不该报错）', () => {
    const { agent } = makeAgent();
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: ['anic_a'], disposer: null });
    const out = unlockTool(agent, 'anic_tool_detail');
    expect(out.callable).toBe(true);
    expect(out.reason).toContain('always visible');
  });

  it('**未知 id** ⇒ 报告不可调用（不假装成功）', () => {
    const { agent } = makeAgent();
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: [], disposer: null });
    const out = unlockTool(agent, 'anic_nonexistent');
    expect(out.callable).toBe(false);
    expect(out.reason).toContain('unknown tool id');
  });

  it('**未启用 indexed 的 agent** ⇒ 报告已可调用（全部工具本来就可见）', () => {
    const out = unlockTool({ ctx: {} }, 'anic_a');
    expect(out.callable).toBe(true);
    expect(out.reason).toContain('not in indexed mode');
  });

  it('**`tools/change` 必发**（宿主契约：restriction 变更属于触发条件）', () => {
    const { agent, emits } = makeAgent();
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });
    unlockTool(agent, 'anic_a');
    expect(emits, 'restriction 变更后必须 emit tools/change').toContain('tools/change');
  });

  it('**失败方向是放宽**：re-restrict 抛错时全部可见（不是更少）', () => {
    const calls: Array<{ deny: string[]; lifted: boolean }> = [];
    let n = 0;
    const agent = {
      ctx: {
        tools: {
          restrict: (f: { deny: string[] }) => {
            n++;
            if (n === 1) { const rec = { deny: f.deny, lifted: false }; calls.push(rec); return () => { rec.lifted = true; }; }
            throw new Error('boom');
          },
        },
        emit: () => {},
      },
    };
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });
    const out = unlockTool(agent, 'anic_a');
    expect(out.callable, '旧 restriction 已撤 ⇒ 全部可见 ⇒ 可调用').toBe(true);
    expect(out.reason).toContain('restriction lifted but re-apply failed');
  });
});

describe('cycle-92：状态生命周期（防长跑泄漏）', () => {
  it('**forgetDisclosure 撤销遮蔽并清状态**', () => {
    const { agent, calls } = makeAgent();
    const initial = recomputeDeny(ALL, LOADERS, new Set());
    const disposer = agent.ctx.tools.restrict({ deny: initial });
    rememberDisclosure(agent, { allToolIds: ALL, loaderIds: LOADERS, deny: initial, disposer });
    trackAgent(agent);
    expect(disclosureOf(agent)).not.toBeNull();

    forgetDisclosure(agent);
    expect(disclosureOf(agent), '状态必须被清（否则长跑泄漏）').toBeNull();
    expect(calls[0]?.lifted, '遮蔽必须被撤销').toBe(true);
  });

  it('trackedAgentCount 随 track/untrack 变化', () => {
    const a = {};
    const b = {};
    trackAgent(a); trackAgent(b);
    const before = trackedAgentCount();
    forgetDisclosure(a);
    expect(trackedAgentCount()).toBeLessThanOrEqual(before);
  });
});
