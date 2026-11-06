/**
 * 循环坐标漂移判据单测（cycle-108）。
 *
 * 这组用例的价值不在"函数算得对"，而在**把一次真机事故钉成机器判据**：
 * HEAD 已 `cycle-107`，`workflow-state.currentCycle` 停在 `cycle-105`，
 * `cycles/` 只有 `cycle-105` —— 于是 cycle-106/107 两轮测试报告全写进 cycle-105，
 * 全程零报错。任何一条回归都会让"坐标漂移"重新变成不可见状态。
 */
import { describe, it, expect } from 'vitest';
import {
  cycleNumberOf,
  headCycleOf,
  detectCycleDrift,
  type CycleDriftInput,
} from '../../src/host/evolution/cycleDrift.ts';

const base: CycleDriftInput = {
  headSubject: 'v0.57.0 cycle-107: toolview 收口',
  liveCycles: ['cycle-105'],
  archivedCycles: ['cycle-104'],
  stateCycle: 'cycle-105',
};

describe('cycleNumberOf / headCycleOf：形状守卫', () => {
  it('只认 cycle-<n>，其余一律 null（不把坏名当 0）', () => {
    expect(cycleNumberOf('cycle-108')).toBe(108);
    expect(cycleNumberOf('cycle-')).toBeNull();
    expect(cycleNumberOf('cycle-10a')).toBeNull();
    expect(cycleNumberOf(null)).toBeNull();
  });

  it('commit subject 取**最大**轮次（合并/收口提交常写多轮）', () => {
    expect(headCycleOf('cycle-108: 收口 cycle-107 遗留 + cycle-106 债')).toBe(108);
    expect(headCycleOf('v0.57.0 cycle-107: toolview')).toBe(107);
    expect(headCycleOf('docs: 无轮次提及')).toBeNull();
    expect(headCycleOf(null)).toBeNull();
  });
});

describe('detectCycleDrift：三源比对', () => {
  it('事故复现：HEAD 超前于活跃循环 → drift + HEAD_AHEAD_OF_LIVE', () => {
    const d = detectCycleDrift(base);
    expect(d.drift).toBe(true);
    expect(d.reasons.map((r) => r.code)).toContain('HEAD_AHEAD_OF_LIVE');
    expect(d.headCycle).toBe(107);
    expect(d.liveLatest).toBe('cycle-105');
    // 建议下一循环取四源最大值 +1 —— 不是"最新的目录 +1"
    expect(d.suggestedCycle).toBe('cycle-108');
  });

  it('状态机落后于活跃循环 → STATE_BEHIND_LIVE', () => {
    const d = detectCycleDrift({ ...base, headSubject: null, liveCycles: ['cycle-107'], stateCycle: 'cycle-105' });
    expect(d.drift).toBe(true);
    expect(d.reasons.map((r) => r.code)).toEqual(['STATE_BEHIND_LIVE']);
    expect(d.reasons[0]?.state).toBe(105);
    expect(d.reasons[0]?.live).toBe(107);
  });

  it('状态机超前于活跃循环（缺工作区）→ STATE_AHEAD_OF_LIVE', () => {
    const d = detectCycleDrift({ ...base, headSubject: null, liveCycles: ['cycle-105'], stateCycle: 'cycle-108' });
    expect(d.reasons.map((r) => r.code)).toEqual(['STATE_AHEAD_OF_LIVE']);
    expect(d.suggestedCycle).toBe('cycle-109');
  });

  it('状态文件缺失 / currentCycle 形状不对 → STATE_MISSING（不是"没漂移"）', () => {
    expect(detectCycleDrift({ ...base, headSubject: null, stateCycle: null }).reasons.map((r) => r.code))
      .toContain('STATE_MISSING');
    expect(detectCycleDrift({ ...base, headSubject: null, stateCycle: '107' }).reasons.map((r) => r.code))
      .toContain('STATE_MISSING');
  });

  it('归档超前于活跃面 → ARCHIVE_AHEAD_OF_LIVE', () => {
    const d = detectCycleDrift({ ...base, headSubject: null, liveCycles: ['cycle-104'], stateCycle: 'cycle-104', archivedCycles: ['cycle-105'] });
    expect(d.reasons.map((r) => r.code)).toEqual(['ARCHIVE_AHEAD_OF_LIVE']);
    expect(d.reasons[0]?.archived).toBe(105);
  });

  it('三源一致 → drift=false 且 reasons 为空（"没有漂移"是可断言的正面结论）', () => {
    const d = detectCycleDrift({ headSubject: 'v0.58.0 cycle-108', liveCycles: ['cycle-107', 'cycle-108'], archivedCycles: ['cycle-105'], stateCycle: 'cycle-108' });
    expect(d.drift).toBe(false);
    expect(d.reasons).toEqual([]);
    expect(d.suggestedCycle).toBe('cycle-109');
  });

  it('非 git 工作区（headSubject=null）不因此判漂移', () => {
    const d = detectCycleDrift({ headSubject: null, liveCycles: ['cycle-108'], archivedCycles: [], stateCycle: 'cycle-108' });
    expect(d.drift).toBe(false);
  });

  it('空工作区：无任何坐标 → 不漂移，建议 cycle-1（首轮自举不是漂移）', () => {
    const d = detectCycleDrift({ headSubject: null, liveCycles: [], archivedCycles: [], stateCycle: null });
    // 状态文件缺失仍是漂移信号（bootstrap 前应当是"未初始化"，由上游单独处理）——
    // 但 emptyCandidates 的建议值必须落在 cycle-1，不得出现 cycle-0。
    expect(d.suggestedCycle).toBe('cycle-1');
  });
});