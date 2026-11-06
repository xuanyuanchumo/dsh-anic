/**
 * 披露裁决纯函数单测（cycle-109 · 修 O-109-01）。
 *
 * 为什么必须有这组用例：`disclosureReadout.ts` 的文件头长期承认「本模块**不证明**
 * 宿主真的按 deny 生效」。本裁决模块就是那句话的反面 —— 它必须能判**三态**，
 * 尤其必须能判**红**（`leaked` / `missing`）。一个只能判绿的裁决等于没有裁决。
 *
 * 反向自检纪律（本仓）：每个判据都要有「会判红」的用例；只断言 `verified`
 * 的测试在实现恒返回 'verified' 时同样绿。
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDisclosureVerdict,
  describeHostVerdict,
  expectedVisibleIds,
  summarizeVerdict,
} from '../../src/host/runtime/disclosureVerdict.ts';

const ALL = ['anic_status', 'anic_snapshot', 'anic_skill', 'anic_tool_detail', 'anic_tools_search'];
const LOADERS = ['anic_tool_detail', 'anic_tools_search'];
const DENY = ['anic_status', 'anic_snapshot', 'anic_skill'];

describe('expectedVisibleIds', () => {
  it('从全量里剔除 deny，顺序保持输入序（同输入同输出）', () => {
    expect(expectedVisibleIds(ALL, DENY)).toEqual(LOADERS);
  });
  it('deny 含未知 id 时静默忽略（不制造幻影可见项）', () => {
    expect(expectedVisibleIds(ALL, ['not_a_tool'])).toEqual(ALL);
  });
});

describe('classifyDisclosureVerdict', () => {
  it('采不到（null）⇒ unverified，且 leaked/missing 都为空（不是失败）', () => {
    const r = classifyDisclosureVerdict(LOADERS, null, DENY);
    expect(r.verdict).toBe('unverified');
    expect(r.leaked).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.observedVisible).toBeNull();
  });

  it('实测 == 应可见 ⇒ verified（正面结论必须显式给出）', () => {
    const r = classifyDisclosureVerdict(LOADERS, LOADERS, DENY);
    expect(r.verdict).toBe('verified');
    expect(r.leaked).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('宿主仍给了被 deny 的工具 ⇒ partial + leaked 点名（越权暴露，最危险）', () => {
    const r = classifyDisclosureVerdict(LOADERS, [...LOADERS, 'anic_status'], DENY);
    expect(r.verdict).toBe('partial');
    expect(r.leaked).toEqual(['anic_status']);
    expect(r.missing).toEqual([]);
  });

  it('应可见的工具不见了 ⇒ partial + missing 点名（遮蔽过头，可能自锁）', () => {
    const r = classifyDisclosureVerdict(LOADERS, ['anic_tool_detail'], DENY);
    expect(r.verdict).toBe('partial');
    expect(r.leaked).toEqual([]);
    expect(r.missing).toEqual(['anic_tools_search']);
  });

  it('「加载器也被遮了」这一自锁形态能被点名（不是笼统 partial）', () => {
    const r = classifyDisclosureVerdict(LOADERS, [], DENY);
    expect(r.verdict).toBe('partial');
    expect(r.missing.sort()).toEqual([...LOADERS].sort());
  });

  it('leaked 与 missing 同时出现 ⇒ 两类各自点名（补救动作相反，不可合并）', () => {
    const r = classifyDisclosureVerdict(LOADERS, ['anic_status'], DENY);
    expect(r.verdict).toBe('partial');
    expect(r.leaked).toEqual(['anic_status']);
    expect(r.missing).toEqual(LOADERS);
  });

  it('宿主多给的**他人工具**不计入裁决（本插件无权判定）', () => {
    // 既不在 expected 也不在 deny ⇒ 是别的插件/宿主自带的工具。
    const r = classifyDisclosureVerdict(LOADERS, [...LOADERS, 'read', 'bash'], DENY);
    expect(r.verdict).toBe('verified');
    expect(r.leaked).toEqual([]);
  });

  it('重复名不制造重复判定（Set 语义）', () => {
    const r = classifyDisclosureVerdict(LOADERS, [...LOADERS, ...LOADERS], DENY);
    expect(r.verdict).toBe('verified');
  });
});

describe('摘要措辞', () => {
  it('三态各有独立措辞；verified 是显式正面结论', () => {
    expect(summarizeVerdict(classifyDisclosureVerdict(LOADERS, LOADERS, DENY))).toContain('verified');
    expect(summarizeVerdict(classifyDisclosureVerdict(LOADERS, null, DENY))).toContain('unverified');
    const p = summarizeVerdict(classifyDisclosureVerdict(LOADERS, ['anic_status'], DENY));
    expect(p).toContain('partial');
    expect(p).toContain('leaked=1');
    expect(p).toContain('missing=2');
  });

  it('describeHostVerdict 轻量版与完整版不矛盾（同一判据两种出口）', () => {
    expect(describeHostVerdict('verified', 2)).toContain('verified');
    expect(describeHostVerdict('partial', 1)).toContain('partial');
    expect(describeHostVerdict('unverified', null)).toContain('unverified');
  });
});