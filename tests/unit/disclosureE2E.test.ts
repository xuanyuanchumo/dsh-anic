/**
 * 渐进式披露**端到端语义验证**（cycle-92）—— 用真实宿主 ctx 形状跑完整链路。
 *
 * ## 为什么需要这个文件（trivial 单测不够）
 *
 * `disclosureActivation.test.ts` 验证的是 `unlockTool` **单函数**行为。
 * 但自锁是**集成层缺陷**：`computeDeny`（纯逻辑）+ `restrict`（宿主面）+
 * `anic_tool_detail.execute`（工具体）+ `tools/change`（事件）四段拼起来才成立。
 *
 * cycle-91 的教训：**判据层与单元层都绿，集成层断了**（截断徽标那一例）。
 * ⇒ 本文件把四段**串起来**跑，断言「模型的视角真的变了」。
 *
 * ## 与真机验证的关系（诚实边界）
 *
 * 真机验证需要：① `.cycles/config.yml` 写 `anic: toolDisclosure: indexed`；
 * ② **重启会话**（披露在 `agent/created` 时施加，已存在的会话不会重跑）。
 *
 * 本文件用**真实宿主 ctx 的形状**（`{tools:{restrict}, systemPrompt:{section}, emit}`）
 * 模拟，能在离线金塔里跑。**它不能替代真机**（真机的 `restrict` 是宿主实现），
 * 但它能钉死**我们这一侧的接线正确性**——而自锁正是接线缺陷。
 */
import { describe, expect, it } from 'vitest';
import { applyDisclosureToScope, wireToolDisclosure } from '../../src/host/toolDisclosureWiring.ts';
import { unlockTool, disclosureOf } from '../../src/host/runtime/disclosureActivation.ts';
import { computeDeny, INDEX_LOADER_TOOLS } from '../../src/host/indexActivation.ts';
import { ANIC_TOOL_IDS } from '../../src/host/toolIds.ts';

/** 真实工具 id 全集（23 个）。 */
const ALL = [...ANIC_TOOL_IDS];
const LOADERS = [...INDEX_LOADER_TOOLS];

/** 最小能力索引（注入面形状）。 */
/** 真实形状的能力索引（`tools` 是 [id, 摘要] 对、`scripts` 是裸名数组）。 */
const INDEX = {
  v: 1,
  commit: 'test',
  tools: ALL.map((id) => [id, id + ' 摘要'] as [string, string]),
  scripts: ['eval-runner', 'gate-check'],
} as unknown as Parameters<typeof applyDisclosureToScope>[1];

/**
 * 模拟**宿主**的 restrict 语义：**取交集**（链上任一层拒绝即不可见）。
 *
 * 这是本文件的关键：单槽桩（只记最后一次 deny）**测不出自锁**——
 * 因为自锁的机理正是"交集让新 restriction 无法放宽"。
 */
function makeHostSemantics(): {
  ctx: { tools: { restrict: (f: { deny: string[] }) => () => void }; systemPrompt: { section: (s: { name: string; text: string }) => unknown }; emit: (n: string) => unknown };
  visible: () => string[];
  stack: Array<{ deny: string[]; lifted: boolean }>;
  emits: string[];
} {
  const stack: Array<{ deny: string[]; lifted: boolean }> = [];
  const emits: string[] = [];
  const ctx = {
    tools: {
      restrict: (f: { deny: string[] }) => {
        const rec = { deny: f.deny, lifted: false };
        stack.push(rec);
        return () => { rec.lifted = true; };
      },
    },
    systemPrompt: { section: () => undefined },
    emit: (n: string) => { emits.push(n); return undefined; },
  };
  // 宿主语义：某工具只有在**所有未被撤销的 restriction** 都不拒绝它时才可见。
  const visible = (): string[] => ALL.filter((id) => !stack.some((r) => !r.lifted && r.deny.includes(id)));
  return { ctx, visible, stack, emits };
}

describe('cycle-92：indexed 披露的端到端语义（宿主交集语义）', () => {
  it('**初始遮蔽**：只有 2 个加载器可见（21 个工具被遮）', () => {
    const h = makeHostSemantics();
    const out = applyDisclosureToScope(h.ctx, INDEX, 'indexed', ALL, { ctx: h.ctx });
    expect(out.wired, out.reason).toBe(true);
    expect(out.denyCount).toBe(ALL.length - LOADERS.length);
    const vis = h.visible();
    expect(vis.sort()).toEqual([...LOADERS].sort());
    expect(h.emits, 'restriction 变更后必须发 tools/change').toContain('tools/change');
  });

  it('**自锁复现**（修复前的行为）：只加更窄的 restriction ⇒ 工具**仍然不可见**', () => {
    const h = makeHostSemantics();
    applyDisclosureToScope(h.ctx, INDEX, 'indexed', ALL, { ctx: h.ctx });
    // 模拟"错误修法"：再施加一条更窄的（deny 少了 anic_status）。
    const narrower = ALL.filter((id) => !LOADERS.includes(id) && id !== 'anic_status');
    h.ctx.tools.restrict({ deny: narrower });
    // 交集语义 ⇒ 旧的仍在拒绝 it ⇒ 仍不可见。
    expect(h.visible(), '仅叠加更窄的 restriction 无法解锁（这正是自锁的机理）').not.toContain('anic_status');
  });

  it('**修复后**：走 unlockTool ⇒ 目标工具**真的**可见（且只多这一个）', () => {
    const h = makeHostSemantics();
    const agent = { ctx: h.ctx };
    applyDisclosureToScope(h.ctx, INDEX, 'indexed', ALL, agent);
    const before = h.visible();
    expect(before).not.toContain('anic_status');

    const out = unlockTool(agent, 'anic_status');
    expect(out.callable).toBe(true);
    const after = h.visible();
    expect(after, '解锁后必须真的可见').toContain('anic_status');
    // 只多这一个：其余仍被遮。
    expect(after.length).toBe(before.length + 1);
    // 加载器始终可见。
    for (const l of LOADERS) expect(after).toContain(l);
  });

  it('**逐次解锁到全量**：23/23 全部可达（这是自锁的终点对照）', () => {
    const h = makeHostSemantics();
    const agent = { ctx: h.ctx };
    applyDisclosureToScope(h.ctx, INDEX, 'indexed', ALL, agent);
    const targets = ALL.filter((id) => !LOADERS.includes(id));
    for (const t of targets) {
      const out = unlockTool(agent, t);
      expect(out.callable, `解锁 ${t} 应成功`).toBe(true);
    }
    const vis = h.visible();
    expect(vis.length, '全部工具最终都应可达（修复前永久 2/23）').toBe(ALL.length);
  });

  it('**每次解锁都发 tools/change**（宿主据此重装配）', () => {
    const h = makeHostSemantics();
    const agent = { ctx: h.ctx };
    applyDisclosureToScope(h.ctx, INDEX, 'indexed', ALL, agent);
    const base = h.emits.filter((e) => e === 'tools/change').length;
    unlockTool(agent, 'anic_status');
    unlockTool(agent, 'anic_snapshot');
    const after = h.emits.filter((e) => e === 'tools/change').length;
    expect(after - base, '两次解锁应发两次 tools/change').toBe(2);
  });

  it('**agent/disposed 撤销遮蔽**（不泄漏）', () => {
    const h = makeHostSemantics();
    let created: ((p: { agent?: unknown }) => void) | undefined;
    let disposed: ((p: { agent?: unknown }) => void) | undefined;
    const host = {
      on: (n: string, fn: (p: { agent?: unknown }) => void) => {
        if (n === 'agent/created') created = fn;
        if (n === 'agent/disposed') disposed = fn;
        return undefined;
      },
    };
    const agent = { ctx: h.ctx, session: { header: { cwd: 'D:/p/a' } } };
    wireToolDisclosure(host, {
      mode: 'indexed',
      index: INDEX,
      allToolIds: ALL,
      resolveForAgent: () => ({ mode: 'indexed', index: INDEX }),
    });
    created?.({ agent });
    expect(h.visible().length, '遮蔽已施加').toBe(LOADERS.length);
    expect(disclosureOf(agent), '状态应被记录').not.toBeNull();

    disposed?.({ agent });
    expect(disclosureOf(agent), '销毁后状态必须清（防长跑泄漏）').toBeNull();
    expect(h.visible().length, '遮蔽必须被撤销').toBe(ALL.length);
  });
});

describe('cycle-92：computeDeny 与解锁的边界一致性', () => {
  it('初始 deny 恰好等于「全部 − 加载器」', () => {
    const deny = computeDeny('indexed', ALL);
    expect(deny.sort()).toEqual(ALL.filter((id) => !LOADERS.includes(id)).sort());
  });

  it('full 模式 ⇒ deny 为空（零行为变更）', () => {
    expect(computeDeny('full', ALL)).toEqual([]);
  });
});
