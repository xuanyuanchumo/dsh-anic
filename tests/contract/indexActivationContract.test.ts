/**
 * 按需激活机制契约（cycle-74 T-7402）。
 *
 * 风险面（为什么值得单测）：deny 集合算错会**静默遮蔽模型必需的加载器**，
 * 模型再也取不回 schema——比不激活更糟（自锁）。三条硬约束各有单测。
 *
 * 前置：A0′ 已真机 PASS（scoped ctx 上 restrict 生效，见 cycle-73 探针记录）。
 *
 * **诚实边界**：本守卫测的是**纯逻辑**（deny 集合与可落地判定）；
 * 「接线后 scope 视图真的收缩」属真机验收（A3/A4），**本轮未落地、未验证**。SKIP ≠ PASS。
 */
import { describe, it, expect } from 'vitest';
import {
  INDEX_LOADER_TOOLS,
  computeDeny,
  activationReady,
  planActivation,
} from '../../src/host/indexActivation.ts';
import { ANIC_TOOL_IDS } from '../../src/host/toolIds.ts';

const ALL = [...ANIC_TOOL_IDS];

describe('cycle-74 T-7402 按需激活机制契约（纯逻辑）', () => {
  it('约束① full 模式 deny 恒为空（A8 零行为变更）', () => {
    expect(computeDeny('full', ALL)).toEqual([]);
    expect(planActivation('full', ALL, [])).toBeNull();
  });

  it('约束② indexed 模式 deny 全部已知工具减去加载器', () => {
    const deny = computeDeny('indexed', ALL);
    // cycle-74：加载器现已注册 ⇒ deny = 21 − 2 = 19（其余全部被遮）
    const expectDeny = ALL.filter((id) => !(INDEX_LOADER_TOOLS as readonly string[]).includes(id));
    expect(deny).toHaveLength(expectDeny.length);
    expect([...deny].sort()).toEqual([...expectDeny].sort());
    // 一旦加载器注册，它必须**不在** deny 里（否则模型取不回 schema）
    for (const loader of INDEX_LOADER_TOOLS) expect(deny).not.toContain(loader);
  });

  it('约束③ 只输出已知 id（unknown name 会让 restrict 抛错——cycle-73 v6 实测）', () => {
    const withPhantom = [...ALL, 'anic_phantom_tool', 'not_anic'] as string[];
    const deny = computeDeny('indexed', withPhantom);
    expect(deny).not.toContain('anic_phantom_tool');
    expect(deny).not.toContain('not_anic');
    const expectDeny = ALL.filter((id) => !(INDEX_LOADER_TOOLS as readonly string[]).includes(id));
    expect([...deny].sort()).toEqual([...expectDeny].sort());
  });

  it('自锁防护：**加载器缺失**时 indexed 不可落地（拒绝切档，保持 full）', () => {
    // 现实（cycle-74）：加载器已注册 ⇒ ALL 含它们。故构造「加载器缺失」的夹具验证防护本身。
    const withoutLoaders = ALL.filter((id) => !(INDEX_LOADER_TOOLS as readonly string[]).includes(id));
    expect(withoutLoaders.length).toBe(ALL.length - 2);
    const r = activationReady('indexed', withoutLoaders);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('缺加载器');
    expect(planActivation('indexed', withoutLoaders, withoutLoaders)).toBeNull();
  });

  it('现实（cycle-74）：加载器已注册 ⇒ indexed **可落地**，且 deny 不含加载器', () => {
    const ready = activationReady('indexed', ALL);
    expect(ready.ready).toBe(true);
    const plan = planActivation('indexed', ALL, ALL);
    expect(plan).not.toBeNull();
    expect(plan?.deny).toHaveLength(ALL.length - INDEX_LOADER_TOOLS.length);
    for (const l of INDEX_LOADER_TOOLS) expect(plan?.deny).not.toContain(l);
  });

  it('加载器齐备后可落地，且 plan 的 deny 不含加载器', () => {
    const registered = [...ALL, ...INDEX_LOADER_TOOLS] as string[];
    const r = activationReady('indexed', registered);
    expect(r.ready).toBe(true);
    const plan = planActivation('indexed', registered, registered);
    expect(plan).not.toBeNull();
    for (const loader of INDEX_LOADER_TOOLS) expect(plan?.deny).not.toContain(loader);
    // 反向：加载器**确实**演过「保持可见」的角色（若加载器不在 registered 则应被拒）
    expect(activationReady('indexed', [INDEX_LOADER_TOOLS[0]]).ready).toBe(false);
  });

  it('纪律① 反向自检：把加载器塞进 deny 必须能被识别为违规', () => {
    const deny = computeDeny('indexed', [...ALL, ...INDEX_LOADER_TOOLS]);
    const wronglyDenied = INDEX_LOADER_TOOLS.filter((l) => deny.includes(l));
    expect(wronglyDenied, '加载器被遮蔽（自锁）').toEqual([]);
    // 反证：人为构造一个「遮蔽加载器」的集合，断言检查确实能抓出
    const badDeny = [...deny, INDEX_LOADER_TOOLS[0] as string];
    expect(INDEX_LOADER_TOOLS.filter((l) => badDeny.includes(l)).length).toBeGreaterThan(0);
  });
});
