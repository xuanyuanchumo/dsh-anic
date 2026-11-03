/**
 * 有界视图读数条渲染契约（cycle-101 · 面板消费端）。
 *
 * 守卫「诚实渲染三纪律」（与 flowViewTypes.ts 声明一致）：
 *   ① 取不到 ≠ 零：view 为 null 时整条不渲染（返回 null，不画空壳）；
 *   ② 被裁必显：dropped > 0 必上屏；dropped === 0 时**不**显示（不制造假警报）；
 *   ③ 数值归一：formatRate/formatDuration 对 NaN/负数/越界都输出占位而非垃圾。
 */
import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRate,
  renderFlowViewReadout,
  type FlowDistributionJson,
  type FlowViewJson,
} from '../../src/client/features/flows/renderFlowViewReadout.ts';

function makeView(over: Partial<FlowViewJson> = {}): FlowViewJson {
  return {
    stateVersion: 1,
    totalEver: 164,
    totalRecords: 164,
    kept: 50,
    dropped: 114,
    floorStartedAt: '2026-11-01T03:22:11.000Z',
    head: [],
    stats: {},
    ...over,
  };
}

const DIST: FlowDistributionJson = {
  byStatus: { DONE: 40, FAILED: 6, TIMEOUT: 4 },
  failureRate: 0.2,
  avgDurationMs: 12345,
};

describe('有界视图读数条（cycle-101）', () => {
  it('① 取不到 ≠ 零：view 为 null/undefined 时返回 null（不画空壳）', () => {
    expect(renderFlowViewReadout(null, null)).toBeNull();
    expect(renderFlowViewReadout(undefined, DIST)).toBeNull();
  });

  it('② 被裁必显：dropped>0 出现 dropped 与 floor 徽章', () => {
    const el = renderFlowViewReadout(makeView(), DIST)!;
    const html = JSON.stringify(el);
    expect(html).toContain('"dropped"');
    expect(html).toContain('"114"');
    expect(html).toContain('"floor"');
    // floor 时间被格式化（T 换空格）
    expect(html).toContain('2026-11-01 03:22:11');
  });

  it('②b 未裁切：dropped=0 且 floor=null 时两者都不出现（不制造假警报）', () => {
    const el = renderFlowViewReadout(makeView({ dropped: 0, floorStartedAt: null }), DIST)!;
    const html = JSON.stringify(el);
    expect(html).not.toContain('"dropped"');
    expect(html).not.toContain('"floor"');
  });

  it('②c 状态分布：按计数降序出现，失败态用告警色', () => {
    const html = JSON.stringify(renderFlowViewReadout(makeView(), DIST));
    expect(html).toContain('"status-DONE"');
    expect(html).toContain('"status-FAILED"');
    expect(html).toContain('"40"');
    // 失败率徽章在场
    expect(html).toContain('"failureRate"');
    expect(html).toContain('20.0%');
  });

  it('③ 数值归一：formatRate 对 NaN/越界输出安全值', () => {
    expect(formatRate(0.9234)).toBe('92.3%');
    expect(formatRate(Number.NaN)).toBe('—');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatRate(-0.5)).toBe('0.0%'); // 越界下界
    expect(formatRate(1.5)).toBe('100.0%'); // 越界上界
  });

  it('③b formatDuration：秒/毫秒分档 + 非法值占位', () => {
    expect(formatDuration(12345)).toBe('12.3s');
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });

  it('④ dist 缺失时只渲染总量类徽章（降级不崩）', () => {
    const el = renderFlowViewReadout(makeView(), null)!;
    const html = JSON.stringify(el);
    expect(html).toContain('"total"');
    expect(html).toContain('"164"');
    expect(html).not.toContain('"failureRate"');
  });

  it('⑤ a11y：读数条是 role=group 且带 aria-label', () => {
    const el = renderFlowViewReadout(makeView(), DIST)!;
    const props = el.props as Record<string, unknown>;
    expect(props['role']).toBe('group');
    expect(typeof props['aria-label']).toBe('string');
    expect(props['data-anic-flow-readout-bar']).toBe('1');
  });
});
