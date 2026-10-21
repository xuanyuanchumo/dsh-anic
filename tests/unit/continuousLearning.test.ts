/**
 * 持续学习层（M10-e）单元测试。
 *
 * 覆盖：健康等级判定 / 改进建议生成 / 格式化摘要 / 边界条件。
 */
import { describe, it, expect } from 'vitest';
import { analyzeSkillHealth, formatHealthSummary } from '../../src/host/runtime/continuousLearning.ts';

// cycle-57 T-5702：computeScriptHealth 增时间窗（7 天）——夹具时间戳是 2026-01-02,
// 真实 Date.now() 已 2026-10 月，全部出窗会把既有用例打成 insufficient。
// 测试时钟钉在夹具次日（全部夹具距 T57_NOW ≤ 7 天，时间窗不改变既有断言语义）。
const T57_NOW = Date.parse('2026-01-03T00:00:00.000Z'); // 基础夹具（2026-01-01..02）次日
const T53_OCT = Date.parse('2026-10-22T00:00:00.000Z'); // cycle-53 真实时间夹具（10-17..21）次日
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
      const report = analyzeSkillHealth(makeState([]), T57_NOW);
      expect(report.totalInvocations).toBe(0);
      expect(report.overallSuccessRate).toBe(0);
      expect(report.scripts).toEqual([]);
      expect(report.suggestions).toEqual([]);
    });

    it('healthy 脚本：成功率≥80% 且无超时', () => {
      const flows = Array.from({ length: 5 }, () => makeFlow({ script: 'gate-check', status: 'DONE', exitCode: 0 }));
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].level).toBe('healthy');
      expect(report.scripts[0].successRate).toBe(1);
      expect(report.suggestions).toEqual([]);
    });

    it('degraded 脚本：成功率<80% 生成 warn/critical 建议', () => {
      const flows = [
        ...Array.from({ length: 2 }, () => makeFlow({ script: 'eval-runner', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'eval-runner', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
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
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].level).toBe('slow');
      expect(report.scripts[0].timeoutRate).toBe(1 / 3);
      expect(report.suggestions[0].id).toBe('speed-auto-fix-loop');
    });

    it('expensive 脚本：平均耗时>30s 生成 info 建议', () => {
      const flows = Array.from({ length: 5 }, () =>
        makeFlow({ script: 'multi-agent-gate', status: 'DONE', durationMs: 45000 }),
      );
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].level).toBe('expensive');
      expect(report.scripts[0].avgDurationMs).toBe(45000);
      expect(report.suggestions[0].id).toBe('perf-multi-agent-gate');
    });

    it('insufficient 脚本：样本<3 不评估不建议', () => {
      const flows = [makeFlow({ script: 'init-workflow', status: 'DONE' })];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].level).toBe('insufficient');
      expect(report.suggestions).toEqual([]);
    });

    it('多脚本按 total 降序排列', () => {
      const flows = [
        ...Array.from({ length: 5 }, () => makeFlow({ script: 'a', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'b', status: 'DONE' })),
      ];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].script).toBe('a');
      expect(report.scripts[1].script).toBe('b');
    });

    it('全局成功率跨脚本聚合', () => {
      const flows = [
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'a', status: 'DONE' })),
        ...Array.from({ length: 1 }, () => makeFlow({ script: 'b', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.totalInvocations).toBe(4);
      expect(report.overallSuccessRate).toBe(0.75);
    });

    it('lastInvoked 取最后一条记录的 startedAt', () => {
      const flows = [
        makeFlow({ script: 'a', status: 'DONE', startedAt: '2026-01-01T00:00:00.000Z' }),
        makeFlow({ script: 'a', status: 'DONE', startedAt: '2026-01-02T00:00:00.000Z' }),
      ];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      expect(report.scripts[0].lastInvoked).toBe('2026-01-02T00:00:00.000Z');
    });
  });

  describe('formatHealthSummary', () => {
    it('空报告生成基本摘要', () => {
      const report = analyzeSkillHealth(makeState([]), T57_NOW);
      const summary = formatHealthSummary(report);
      expect(summary).toContain('技能健康报告');
      expect(summary).toContain('总调用 0 次');
    });

    it('含建议的报告列出改进建议（cycle-53：建议描述用近期/全史双量纲）', () => {
      const flows = [
        ...Array.from({ length: 2 }, () => makeFlow({ script: 'eval-runner', status: 'DONE' })),
        ...Array.from({ length: 3 }, () => makeFlow({ script: 'eval-runner', status: 'FAILED', exitCode: 1 })),
      ];
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
      const summary = formatHealthSummary(report);
      expect(summary).toContain('改进建议');
      // cycle-53 T-5301 改钉：建议描述从「成功率 X%」改为「近期 X%/全史 Y%」双量纲。
      expect(summary).toContain('eval-runner 近期成功率');
      expect(summary).toContain('全史 40%');
    });

    it('healthy 脚本用 ✅ 标记', () => {
      const flows = Array.from({ length: 5 }, () => makeFlow({ script: 'gate-check', status: 'DONE' }));
      const report = analyzeSkillHealth(makeState(flows), T57_NOW);
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
      ...Array.from({ length: 8 }, (_, i) => makeFlow({ script: 'workflow-state', status: 'DONE', startedAt: `2026-10-${['19','19','19','19','20','20','21','21'][i]}T12:00:00.000Z` })),
    ];
    // 3F + 8D = 11 条：RECENT_WINDOW=8 → 窗口=最近 8 条全 DONE（3 条旧失败被挤出）。
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
    const ws = report.scripts.find((s) => s.script === 'workflow-state');
    expect(ws?.level).toBe('healthy');
    expect(ws?.successRate).toBeCloseTo(8 / 11, 5); // 全史 8/11 保留统计真相
    expect(ws?.recentSuccessRate).toBe(1); // 近期窗口全成功
  });

  it('窗口边界：恰好 RECENT_WINDOW 条全成功（历史失败被挤出窗口）→ healthy', () => {
    const flows = [
      ...Array.from({ length: 12 }, (_, i) => makeFlow({ script: 'gate-check', status: 'FAILED', startedAt: `2026-10-${String(8 + Math.floor(i / 4)).padStart(2, "0")}T0${i % 10}:00:00.000Z`, exitCode: 1 })),
      ...['15', '16', '17', '18', '19', '20', '21', '21'].map((d) => makeFlow({ script: 'gate-check', status: 'DONE', startedAt: `2026-10-${d}T12:00:00.000Z` })),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
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
    const report = analyzeSkillHealth(makeState(flows), T57_NOW);
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
    const report = analyzeSkillHealth(makeState(flows), T57_NOW);
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
    const report = analyzeSkillHealth(makeState([...mixed, ...same]), T57_NOW);
    const summary = formatHealthSummary(report);
    expect(summary).toContain('m-a: healthy（14 次，近期 100%/全史 57%）');
    expect(summary).toContain('m-b: healthy（5 次，100%）');
  });
});

describe('cycle-57 T-5702 时间窗健康（计数窗结构性根因修复）', () => {
  it('近 7 天无调用 → insufficient + recentSuccessRate=undefined（不拿全史冒充近期）', () => {
    // 根因场景：脚本修复后 1-2 天有成功调用，之后再无调用——计数窗 last-8 里
    // 旧失败永不出窗，面板永久 degraded。时间窗裁决：近 7 天无数据 → 当前状态
    // 不可判定 → insufficient（诚实），而非拿全史冒充。
    const flows = [
      ...Array.from({ length: 3 }, (_, i) => makeFlow({ script: 'legacy-fix', status: 'FAILED', startedAt: `2026-01-01T0${i}:00:00.000Z`, exitCode: 1 })),
      ...Array.from({ length: 5 }, (_, i) => makeFlow({ script: 'legacy-fix', status: 'DONE', startedAt: `2026-01-02T0${i}:00:00.000Z` })),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT); // 1 月数据距 10 月全出窗
    const lf = report.scripts.find((s) => s.script === 'legacy-fix');
    expect(lf?.level).toBe('insufficient');
    expect(lf?.recentSuccessRate).toBeUndefined();
    expect(lf?.successRate).toBeCloseTo(5 / 8, 5); // 全史统计保留
  });

  it('时间窗内失败仍在窗（7 天=一周朴素语义，修复论不掩护当前问题）', () => {
    // 今日 3-5 天前的失败仍在 7 天窗内——诚实展示，非按当日面板表现调参洗白。
    const flows = [
      ...Array.from({ length: 5 }, (_, i) => makeFlow({ script: 'recent-fail', status: 'DONE', startedAt: `2026-10-15T0${i}:00:00.000Z` })),
      ...Array.from({ length: 3 }, (_, i) => makeFlow({ script: 'recent-fail', status: 'FAILED', startedAt: `2026-10-19T0${i}:00:00.000Z`, exitCode: 1 })),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
    const rf = report.scripts.find((s) => s.script === 'recent-fail');
    expect(rf?.level).toBe('degraded'); // 近期 5/8=0.625 < 0.8
    expect(rf?.recentSuccessRate).toBeCloseTo(0.625, 5);
  });

  it('未来时间戳排除（时钟漂移防御：nowMs - t >= 0）', () => {
    // 未来时间戳（系统时钟漂移/手工改文件）不进窗——否则永不出窗污染近期面。
    const flows = [
      ...Array.from({ length: 8 }, (_, i) => makeFlow({ script: 'future-check', status: 'DONE', startedAt: `2026-10-2${0 + i}:00:00:00.000Z` })),
      makeFlow({ script: 'future-check', status: 'FAILED', startedAt: '2027-01-01T00:00:00.000Z', exitCode: 1 }),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
    const fc = report.scripts.find((s) => s.script === 'future-check');
    expect(fc?.level).toBe('healthy'); // 未来 F 不进窗 → 窗内 8D 全成功
    expect(fc?.successRate).toBeCloseTo(8 / 9, 5); // 全史含未来 F 的统计真相
  });

  it('乱序数组按时间序取最近（追加序≠时间序——真实缺陷回归钉）', () => {
    // 3F(10-18) 追加在前、8D(10-14..21) 追加在后但时间跨越失败日两侧。
    // 错误实现 slice(-8) 取「最晚追加」→ 含 1F 出 0.875；
    // 正确实现按时间排序取「最近发生」→ 失败日后成功挤走失败 → healthy。
    const flows = [
      ...Array.from({ length: 3 }, (_, i) => makeFlow({ script: 'order-check', status: 'FAILED', startedAt: `2026-10-18T0${i}:00:00.000Z`, exitCode: 1 })),
      ...Array.from({ length: 4 }, (_, i) => makeFlow({ script: 'order-check', status: 'DONE', startedAt: `2026-10-1${4 + i}T00:00:00.000Z` })),
      ...['19', '19', '20', '20', '20', '21', '21', '21'].map((d) => makeFlow({ script: 'order-check', status: 'DONE', startedAt: `2026-10-${d}T12:00:00.000Z` })),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
    const oc = report.scripts.find((s) => s.script === 'order-check');
    expect(oc?.level).toBe('healthy'); // 时间序尾 8 = D(10-17..21) 全 DONE
    expect(oc?.recentSuccessRate).toBe(1);
  });

  it('suggestFromHealth：insufficient 不生成建议（无近期数据≠当前故障，不催修）', () => {
    const flows = [
      ...Array.from({ length: 3 }, (_, i) => makeFlow({ script: 'stale-script', status: 'FAILED', startedAt: `2026-01-01T0${i}:00:00.000Z`, exitCode: 1 })),
    ];
    const report = analyzeSkillHealth(makeState(flows), T53_OCT);
    const sug = report.suggestions.find((s) => s.script === 'stale-script');
    // 全史 0% 但近 7 天无调用 → 当前状态不可判定 → 不生成建议（不拿历史冒充当前
    // 故障催修——历史欠账已由 cycle-55/56 tech-debt 队列管理，健康面只报当前）。
    expect(sug).toBeUndefined();
  });
});
