/**
 * 持续学习层（M10-e）单元测试。
 *
 * 覆盖：健康等级判定 / 改进建议生成 / 格式化摘要 / 边界条件。
 */
import { describe, it, expect } from 'vitest';
import { analyzeSkillHealth, formatHealthSummary } from '../../src/host/runtime/continuousLearning.ts';
import type { FlowTrackerState, FlowRecord } from '../../src/host/runtime/flowTracker.ts';

function makeFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    flowId: `test-${Math.random().toString(36).slice(2)}`,
    script: 'eval-runner',
    workspace: '/tmp/test',
    args: [],
    status: 'DONE',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1000,
    ...overrides,
  };
}

function makeState(flows: FlowRecord[]): FlowTrackerState {
  return { flows, counter: flows.length };
}

describe('continuousLearning', () => {
  describe('analyzeSkillHealth', () => {
    it('空状态返回零调用报告', () => {
      const report = analyzeSkillHealth(makeState([]));
      expect(report.totalInvocations).toBe(0);
      expect(report.overallSuccessRate).toBe(0);
      expect(report.scripts).toEqual([]);
      expect(report.suggestions).toEqual([]);
    });

    it('healthy 脚本：成功率≥80% 且无超时', () => {
      const flows = Array.from({ length: 5 }, () => makeFlow({ script: 'gate-check', status: 'DONE', exitCode: 0 }));
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].level).toBe('healthy');
      expect(report.scripts[0].successRate).toBe(1);
      expect(report.suggestions).toEqual([]);
    });

    it('degraded 脚本：成功率<80% 生成 warn/critical 建议', () => {
      const flows = [
        ...Array.from({ length: 2 }, () => makeFlow({ script: 'eval-runner', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'eval-runner', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].level).toBe('degraded');
      expect(report.scripts[0].successRate).toBe(0.4);
      expect(report.suggestions).toHaveLength(1);
      expect(report.suggestions[0].severity).toBe('critical'); // <50% → critical
      expect(report.suggestions[0].id).toBe('fix-eval-runner');
    });

    it('slow 脚本：超时率>20% 生成 warn 建议', () => {
      const flows = [
        ...Array.from({ length: 4 }, () => makeFlow({ script: 'auto-fix-loop', status: 'DONE' })),
        ...Array.from({ length: 2 }, () => makeFlow({ script: 'auto-fix-loop', status: 'TIMEOUT' })),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].level).toBe('slow');
      expect(report.scripts[0].timeoutRate).toBe(1 / 3);
      expect(report.suggestions[0].id).toBe('speed-auto-fix-loop');
    });

    it('expensive 脚本：平均耗时>30s 生成 info 建议', () => {
      const flows = Array.from({ length: 5 }, () =>
        makeFlow({ script: 'multi-agent-gate', status: 'DONE', durationMs: 45000 }),
      );
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].level).toBe('expensive');
      expect(report.scripts[0].avgDurationMs).toBe(45000);
      expect(report.suggestions[0].id).toBe('perf-multi-agent-gate');
    });

    it('insufficient 脚本：样本<3 不评估不建议', () => {
      const flows = [makeFlow({ script: 'init-workflow', status: 'DONE' })];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].level).toBe('insufficient');
      expect(report.suggestions).toEqual([]);
    });

    it('多脚本按 total 降序排列', () => {
      const flows = [
        ...Array.from({ length: 5 }, () => makeFlow({ script: 'a', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'b', status: 'DONE' })),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].script).toBe('a');
      expect(report.scripts[1].script).toBe('b');
    });

    it('全局成功率跨脚本聚合', () => {
      const flows = [
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'a', status: 'DONE' })),
        ...Array.from({ length: 1 }, () => makeFlow({ script: 'b', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.totalInvocations).toBe(4);
      expect(report.overallSuccessRate).toBe(0.75);
    });

    it('lastInvoked 取最后一条记录的 startedAt', () => {
      const flows = [
        makeFlow({ script: 'a', status: 'DONE', startedAt: '2026-01-01T00:00:00.000Z' }),
        makeFlow({ script: 'a', status: 'DONE', startedAt: '2026-01-02T00:00:00.000Z' }),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      expect(report.scripts[0].lastInvoked).toBe('2026-01-02T00:00:00.000Z');
    });
  });

  describe('formatHealthSummary', () => {
    it('空报告生成基本摘要', () => {
      const report = analyzeSkillHealth(makeState([]));
      const summary = formatHealthSummary(report);
      expect(summary).toContain('技能健康报告');
      expect(summary).toContain('总调用 0 次');
    });

    it('含建议的报告列出改进建议（cycle-53：建议描述用近期/全史双量纲）', () => {
      const flows = [
        ...Array.from({ length: 2 }, () => makeFlow({ script: 'eval-runner', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'eval-runner', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows));
      const summary = formatHealthSummary(report);
      expect(summary).toContain('改进建议');
      // cycle-53 T-5301 改钉：建议描述从「成功率 X%」改为「近期 X%/全史 Y%」双量纲。
      expect(summary).toContain('eval-runner 近期成功率');
      expect(summary).toContain('全史 40%');
    });

    it('healthy 脚本用 ✅ 标记', () => {
      const flows = Array.from({ length: 5 }, () => makeFlow({ script: 'gate-check', status: 'DONE' }));
      const report = analyzeSkillHealth(makeState(flows));
      const summary = formatHealthSummary(report);
      expect(summary).toContain('✅');
      expect(summary).not.toContain('改进建议');
    });
  });
});

describe('cycle-53 T-5301 近期窗口健康分级（修复被健康面承认）', () => {
  it('历史失败+近期连续成功 → healthy（全史统计仍 40%——分级看近期）', () => {
    // 本仓 workflow-state 真实形态同构：3 条旧 bug 失败（2026-10-18 args 双目录），
    // T-3805 修复后连续成功——修复必须被健康面承认（否则永久 critical 0%）。
    const flows = [
      ...Array.from({ length: 3 }, (_, i) => makeFlow({ script: 'workflow-state', status: 'FAILED', startedAt: `2026-10-18T0${i}:00:00.000Z`, exitCode: 1 })),
      ...Array.from({ length: 8 }, (_, i) => makeFlow({ script: 'workflow-state', status: 'DONE', startedAt: `2026-10-2${1 + i}T00:00:00.000Z` })),
    ];
    // 3F + 8D = 11 条：RECENT_WINDOW=8 → 窗口=最近 8 条全 DONE（3 条旧失败被挤出）。
    const report = analyzeSkillHealth(makeState(flows));
    const ws = report.scripts.find((s) => s.script === 'workflow-state');
    expect(ws?.level).toBe('healthy');
    expect(ws?.successRate).toBeCloseTo(8 / 11, 5); // 全史 8/11 保留统计真相
    expect(ws?.recentSuccessRate).toBe(1); // 近期窗口全成功
  });

  it('窗口边界：恰好 RECENT_WINDOW 条全成功（历史失败被挤出窗口）→ healthy', () => {
    const flows = [
      ...Array.from({ length: 12 }, (_, i) => makeFlow({ script: 'gate-check', status: 'FAILED', startedAt: `2026-10-17T0${i % 10}:00:00.000Z`, exitCode: 1 })),
      ...Array.from({ length: 8 }, (_, i) => makeFlow({ script: 'gate-check', status: 'DONE', startedAt: `2026-10-2${0 + i}:00:00:00.000Z` })),
    ];
    const report = analyzeSkillHealth(makeState(flows));
    const gc = report.scripts.find((s) => s.script === 'gate-check');
    expect(gc?.level).toBe('healthy');
    expect(gc?.recentSuccessRate).toBe(1);
    expect(gc?.successRate).toBeLessThan(0.5); // 全史真相保留
  });

  it('近期窗口内失败仍要 degraded（修复论不掩护当前问题）', () => {
    const flows = [
      ...Array.from({ length: 10 }, () => makeFlow({ script: 'quick-validate', status: 'DONE' })),
      ...Array.from({ length: 5 }, () => makeFlow({ script: 'quick-validate', status: 'FAILED', exitCode: 1 })),
    ];
    const report = analyzeSkillHealth(makeState(flows));
    const qv = report.scripts.find((s) => s.script === 'quick-validate');
    expect(qv?.level).toBe('degraded'); // 近期 3/8=0.375 < 0.8
    expect(qv?.recentSuccessRate).toBe(0.375);
  });

  it('建议 severity 跟近期窗口（历史 critical 但近期已恢复 → warn 不再 critical）', () => {
    const flows = [
      ...Array.from({ length: 8 }, () => makeFlow({ script: 'gate-check', status: 'FAILED', exitCode: 1 })),
      ...Array.from({ length: 6 }, () => makeFlow({ script: 'gate-check', status: 'DONE' })),
    ];
    // 近期窗口 8 条 = 2 FAILED + 6 DONE → recent=0.75 <0.8 degraded，但 ≥0.5 → warn 非 critical
    const report = analyzeSkillHealth(makeState(flows));
    const sug = report.suggestions.find((s) => s.script === 'gate-check');
    expect(sug?.severity).toBe('warn');
    expect(sug?.description).toContain('全史');
  });

  it('格式化双量纲展示：近期与全史不同时「近期 X%/全史 Y%」，相同时单值', () => {
    // m-a：6F+8D=14 条 → 窗口 8 条全 DONE，近期 100% ≠ 全史 8/14≈57% → 双量纲形态。
    // m-b：5D → 近期=全史=100% → 单值形态。
    const mixed = [
      ...Array.from({ length: 6 }, () => makeFlow({ script: 'm-a', status: 'FAILED', exitCode: 1 })),
      ...Array.from({ length: 8 }, () => makeFlow({ script: 'm-a', status: 'DONE' })),
    ];
    const same = Array.from({ length: 5 }, () => makeFlow({ script: 'm-b', status: 'DONE' }));
    const report = analyzeSkillHealth(makeState([...mixed, ...same]));
    const summary = formatHealthSummary(report);
    expect(summary).toContain('m-a: healthy（14 次，近期 100%/全史 57%）');
    expect(summary).toContain('m-b: healthy（5 次，100%）');
  });
});
