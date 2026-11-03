/**
 * FlowTracker 有界视图投影器契约（cycle-101 · dsh-context 模式）。
 *
 * 守卫四件事：
 *   ① 字段白名单：视图不含 stdout/stderr/args（大文本不进 wire）——token 治理的可断言形式；
 *   ② 保留钳制 + Floor：超窗口时如实回报 dropped 与 floorStartedAt（不假装完整）；
 *   ③ 统计读数：successRate 由 done/total 派生，面板直接消费；
 *   ④ 纯函数：同一输入两次调用深相等（回放安全——官方 presentCall/presentResult 规则）。
 */
import { describe, expect, it } from 'vitest';
import {
  FLOW_VIEW_VERSION,
  needsUpgrade,
  projectFlowTrackerView,
  projectStatusDistribution,
  renderFlowViewMarker,
} from '../../src/host/flowTrackerProjection.ts';
import type { FlowRecord, FlowTrackerState } from '../../src/host/runtime/flowTrackerTypes.ts';

/** 造 n 条记录（第 i 条的 script 交替、状态覆盖三态、带大 stdout 噪声）。 */
function makeState(n: number): FlowTrackerState {
  const flows: FlowRecord[] = [];
  for (let i = 0; i < n; i++) {
    const status = (['DONE', 'DONE', 'FAILED', 'TIMEOUT'] as const)[i % 4]!;
    flows.push({
      flowId: `flow-${i}`,
      script: i % 2 === 0 ? 'eval-runner' : 'gate-check',
      workspace: 'D:/ws',
      args: ['--json'],
      status,
      startedAt: `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
      exitCode: status === 'DONE' ? 0 : 1,
      durationMs: 100 + i,
      // 噪声：视图层绝不应带出这两个字段
      stdout: 'X'.repeat(5000),
      stderr: 'Y'.repeat(1000),
    });
  }
  return { flows, counter: n };
}

describe('FlowTracker 有界视图投影器（cycle-101 · dsh-context 模式）', () => {
  it('① 字段白名单：视图完全不含 stdout/stderr/args（token 治理）', () => {
    const view = projectFlowTrackerView(makeState(5), { limit: 10 });
    const json = JSON.stringify(view);
    expect(json).not.toContain('XXXXX');
    expect(json).not.toContain('YYYYY');
    expect(json).not.toContain('"args"');
    // 必要字段都在
    expect(view.head[0]).toHaveProperty('flowId');
    expect(view.head[0]).toHaveProperty('exitCode');
    expect(view.head[0]).toHaveProperty('durationMs');
  });

  it('② 保留钳制：超出窗口如实回报 dropped 与 floorStartedAt', () => {
    const state = makeState(120);
    const view = projectFlowTrackerView(state, { limit: 50 });
    expect(view.kept).toBe(50);
    expect(view.dropped).toBe(70);
    expect(view.totalRecords).toBe(120);
    expect(view.totalEver).toBe(120);
    // Floor 语义：被裁掉的最后一条的时间（窗口内记录都 ≥ 它）
    expect(view.floorStartedAt).toBe(state.flows[69]!.startedAt);
    // 窗口内第一条应等于 all[70]
    expect(view.head[0]!.flowId).toBe('flow-70');
  });

  it('②b 未超窗口：dropped=0 且 floorStartedAt=null（不伪造裁切）', () => {
    const view = projectFlowTrackerView(makeState(10), { limit: 50 });
    expect(view.dropped).toBe(0);
    expect(view.floorStartedAt).toBeNull();
    expect(view.kept).toBe(10);
  });

  it('②c limit 边界收口：0/负数 → clamp 到 1；超大值 → clamp 到 500', () => {
    // clamp 语义：limit 先 Math.max(1, ...) 再 Math.min(..., 500)
    expect(projectFlowTrackerView(makeState(5), { limit: 0 }).kept).toBe(1);
    expect(projectFlowTrackerView(makeState(5), { limit: -3 }).kept).toBe(1);
    expect(projectFlowTrackerView(makeState(5), { limit: 99999 }).kept).toBe(5);
    expect(projectFlowTrackerView(makeState(600), { limit: 99999 }).kept).toBe(500);
  });

  it('③ 统计读数：successRate 由 done/total 派生（面板直接消费）', () => {
    const view = projectFlowTrackerView(makeState(40), { limit: 40 });
    const evalStat = view.stats['eval-runner']!;
    expect(evalStat.total).toBe(20);
    expect(evalStat.successRate).toBeGreaterThanOrEqual(0);
    expect(evalStat.successRate).toBeLessThanOrEqual(1);
    // 四态计数守恒：done+failed+timeout ≤ total（INVOKING/RUNNING 未终结不计入三者）
    expect(evalStat.done + evalStat.failed + evalStat.timeout).toBeLessThanOrEqual(evalStat.total);
  });

  it('④ 纯函数：同一输入两次调用深相等（回放安全）', () => {
    const state = makeState(30);
    const a = projectFlowTrackerView(state, { limit: 20 });
    const b = projectFlowTrackerView(state, { limit: 20 });
    expect(a).toEqual(b);
    // 不修改入参（投影绝不写 state）
    expect(state.flows.length).toBe(30);
    expect(state.flows[0]!.stdout).toContain('X');
  });

  it('④b 空/畸形输入：安全降级为有界空视图（不抛）', () => {
    for (const bad of [null, undefined, {} as FlowTrackerState]) {
      const v = projectFlowTrackerView(bad as FlowTrackerState);
      expect(v.stateVersion).toBe(FLOW_VIEW_VERSION);
      expect(v.head).toEqual([]);
      expect(v.totalEver).toBe(0);
    }
  });

  it('⑤ summaryOnly：只要读数不要明细（读数场景省 payload）', () => {
    const v = projectFlowTrackerView(makeState(20), { limit: 20, summaryOnly: true });
    expect(v.head).toEqual([]);
    expect(v.kept).toBe(20);
    expect(Object.keys(v.stats).length).toBeGreaterThan(0);
  });

  it('⑥ 版本迁移判定：缺 version 或低版本 → 需升级；当前版本 → 不需', () => {
    expect(needsUpgrade({ flows: [], counter: 0 })).toBe(true);
    expect(needsUpgrade(null)).toBe(false);
    expect(needsUpgrade({ flows: [], counter: 0, version: FLOW_VIEW_VERSION } as FlowTrackerState)).toBe(false);
  });

  it('⑦ marker 与分布读数：grep 友好 + 失败率可算', () => {
    const view = projectFlowTrackerView(makeState(120), { limit: 50 });
    const marker = renderFlowViewMarker(view);
    expect(marker).toContain('flows 120 total');
    expect(marker).toContain('70 dropped');
    expect(marker).toContain('floor ');
    const dist = projectStatusDistribution(view);
    expect(dist.byStatus).toBeTypeOf('object');
    expect(dist.failureRate).toBeGreaterThan(0); // 样本含 FAILED/TIMEOUT
    expect(dist.avgDurationMs).toBeGreaterThan(0);
  });
});
