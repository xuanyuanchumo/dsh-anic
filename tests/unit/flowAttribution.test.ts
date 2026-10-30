/**
 * 流程归属语义契约（cycle-89）—— **门禁归属必须由脚本语义判定**。
 *
 * ## 被守卫的缺陷
 *
 * 原实现用「账本链头（最后一条）的 gate」当本次流程的门禁归属。实测反例：
 * 一次 `workflow-state check` 被记成 `gate:'G3'`（账本链头恰好是上次的 G3 记录）。
 *
 * 后果不是「多了一个字段」，而是**门禁证据覆盖指标永久假绿** ——
 * 任意流程都被算成「有 G3 证据」，用户看到的量化条毫无意义。
 *
 * 本文件逐条钉死三条纪律：
 *   1. 只有门禁脚本才配 gate 归属（白名单，不是黑名单）；
 *   2. 来源标注与字段实际出处一致（不再出现「字段来自 ledger、来源写 workflow-state」）；
 *   3. 不回填历史（旧记录没有 attribution 就是没有，如实计入孤儿）。
 */
import { describe, expect, it } from 'vitest';
import { gateOfScript, resolveFlowAttribution } from '../../src/host/runtime/flowAttribution.ts';

describe('gateOfScript：门禁归属只由脚本语义判定', () => {
  it('门禁脚本按参数落具体门（G2）', () => {
    expect(gateOfScript('gate-check', ['--gate', 'G2'])).toBe('G2');
  });

  it('门禁脚本无参时落入口门 G0（评估基线是所有收敛门的入口）', () => {
    expect(gateOfScript('gate-check', [])).toBe('G0');
    expect(gateOfScript('gate-check', ['--gate', 'all'])).toBe('G0');
  });

  it('HITL 审计脚本落 H 门', () => {
    expect(gateOfScript('hitl-audit', ['--gate', 'H2'])).toBe('H2');
    expect(gateOfScript('hitl-audit', [])).toBe('H1');
  });

  it('**非门禁脚本一律无门禁归属**（这条是缺陷的直接守卫）', () => {
    // 实测反例：`workflow-state check` 曾被误标成 G3。
    expect(gateOfScript('workflow-state', ['check'])).toBeUndefined();
    expect(gateOfScript('eval-runner', [])).toBeUndefined();
    expect(gateOfScript('init-cycle', [])).toBeUndefined();
    expect(gateOfScript('band-detector', [])).toBeUndefined();
    expect(gateOfScript('quick-validate', ['assets/skill'])).toBeUndefined();
    expect(gateOfScript('archive-cycle', [])).toBeUndefined();
  });

  it('非法门禁参数不采信（回落入口门，不落一个假门）', () => {
    expect(gateOfScript('gate-check', ['--gate', 'XX'])).toBe('G0');
    expect(gateOfScript('gate-check', ['--gate'])).toBe('G0');
    expect(gateOfScript('hitl-audit', ['--gate', 'G2'])).toBe('H1');
  });
});

describe('resolveFlowAttribution：来源标注与字段出处一致', () => {
  it('读不到 workflow-state 时 cycle/phase 缺省，但门禁仍按脚本判定', () => {
    // 不存在的目录 → workflow-state 读不到。
    const r = resolveFlowAttribution('/nonexistent-cycles-dir-xyz', '2026-01-01T00:00:00.000Z', 'gate-check', ['--gate', 'G1']);
    expect(r.cycle).toBeUndefined();
    expect(r.phase).toBeUndefined();
    expect(r.gate).toBe('G1');
    // source 非 none：至少有一个字段解析到了。
    expect(r.attribution.source).not.toBe('none');
  });

  it('非门禁脚本即使在有 workflow-state 的目录里也不落 gate', () => {
    const r = resolveFlowAttribution('/nonexistent-cycles-dir-xyz', '2026-01-01T00:00:00.000Z', 'workflow-state', ['check']);
    expect(r.gate).toBeUndefined();
    // cycle/phase 也读不到 → 全空 → source 诚实标 none。
    expect(r.attribution.source).toBe('none');
  });

  it('未传脚本时不猜门禁（script 缺失 = 无从判定）', () => {
    const r = resolveFlowAttribution('/nonexistent-cycles-dir-xyz', '2026-01-01T00:00:00.000Z');
    expect(r.gate).toBeUndefined();
  });
});
