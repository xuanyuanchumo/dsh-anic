/**
 * 健康度「有效负裁决」语义（cycle-85 · O-84-01）。
 *
 * ## 背景（真实误判，不是假想）
 *
 * 本仓实测 `anic_status` 报：`gate-check 近期成功率 25%`、`eval-runner 36%`，
 * 且被建议「检查 stderr，定位失败原因」。但那些 exit 1 绝大多数是**门禁正确地
 * 拒绝了放行**（G1 无任务行、G2 报告缺汇总表）——守卫生效被读成工具宕机。
 * 后果不只是文案难看：改进建议、健康等级、乃至基于 health 的熔断判据全部被污染。
 *
 * ## 本文件的判据
 *
 * - 有效性 = `status==='FAILED' && exitCode===1 && stdout 有结构化裁决标记
 *   && stderr 无崩溃特征 && 脚本在裁决类白名单内`；
 * - 任一条件不满足 ⇒ 仍然是**故障**（fail-closed：宁可多报一次失败，
 *   也不把真故障洗白）；
 * - 分级用**有效成功率**；原始成功率同时保留（白盒：两个数都在）。
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeSkillHealth,
  classifyFlowOutcome,
  formatHealthSummary,
  type FlowOutcomeClass,
} from '../../src/host/runtime/continuousLearning.ts';
import type { FlowRecord, FlowTrackerState } from '../../src/host/runtime/flowTracker.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 0;
function flow(over: Partial<FlowRecord> & Pick<FlowRecord, 'script'>): FlowRecord {
  seq += 1;
  return {
    flowId: `${over.script}-${String(seq)}`,
    workspace: 'D:\\ws',
    args: [],
    status: 'DONE',
    startedAt: iso(seq),
    endedAt: iso(seq),
    exitCode: 0,
    durationMs: 100,
    ...over,
  } as FlowRecord;
}

function stateOf(flows: FlowRecord[]): FlowTrackerState {
  return { version: 1, flows } as unknown as FlowTrackerState;
}

/** 一条"门禁正确地拒绝"的记录（真实形态，取自本仓 gate-check 输出）。 */
function gateReject(minutesAgo = 1): FlowRecord {
  return flow({
    script: 'gate-check',
    status: 'FAILED',
    exitCode: 1,
    startedAt: iso(minutesAgo),
    endedAt: iso(minutesAgo),
    stdout: '[PASS] G0: Evaluation report found in cycle-84 (16 dimension rows)\n'
      + '[FAIL] G1: No task entries found (fill the task tables in 任务清单.md) §cycle-84\n',
    stderr: '\nGate check FAILED. Fix issues before proceeding.\n',
  });
}

describe('classifyFlowOutcome：五态分类', () => {
  it('DONE → done；TIMEOUT → timeout；未结束 → pending', () => {
    expect(classifyFlowOutcome(flow({ script: 'gate-check' }))).toBe<FlowOutcomeClass>('done');
    expect(classifyFlowOutcome(flow({ script: 'gate-check', status: 'TIMEOUT' }))).toBe<FlowOutcomeClass>('timeout');
    expect(classifyFlowOutcome(flow({ script: 'gate-check', status: 'RUNNING' }))).toBe<FlowOutcomeClass>('pending');
  });

  it('裁决类脚本 exit 1 + stdout 裁决行 → verdict（正常工作）', () => {
    expect(classifyFlowOutcome(gateReject())).toBe<FlowOutcomeClass>('verdict');
  });

  it('fail-closed：stdout 为空 / exitCode 非 1 / stderr 有崩溃特征 → 一律 failed', () => {
    expect(classifyFlowOutcome(flow({ script: 'gate-check', status: 'FAILED', exitCode: 1, stdout: '' })))
      .toBe<FlowOutcomeClass>('failed');
    expect(classifyFlowOutcome(flow({
      script: 'gate-check', status: 'FAILED', exitCode: 2, stdout: '[FAIL] G1: x',
    }))).toBe<FlowOutcomeClass>('failed');
    expect(classifyFlowOutcome(flow({
      script: 'gate-check', status: 'FAILED', exitCode: 1,
      stdout: '[FAIL] G1: x', stderr: "Error: Cannot find module './missing.mjs'",
    }))).toBe<FlowOutcomeClass>('failed');
  });

  it('白名单之外：stdout 有裁决行也算失败（stderr 无用法提示 ⇒ 不豁免）', () => {
    expect(classifyFlowOutcome(flow({
      script: 'workflow-state', status: 'FAILED', exitCode: 1,
      stdout: '[FAIL] 只接受 2 个位置参数',
      stderr: '',
    }))).toBe<FlowOutcomeClass>('failed');
  });


  it('反向自检：把同一记录脚本名换回 gate-check 就必须变 verdict（证明白名单真的在起作用）', () => {
    const base = flow({
      script: 'workflow-state', status: 'FAILED', exitCode: 1,
      stdout: '[FAIL] G1: No task entries', stderr: '',
    });
    expect(classifyFlowOutcome(base)).toBe<FlowOutcomeClass>('failed');
    expect(classifyFlowOutcome({ ...base, script: 'gate-check' })).toBe<FlowOutcomeClass>('verdict');
  });
});

describe('usage：调用方用法错误不计入工具测量（cycle-88）', () => {
  /** 一条"参数挡下"的记录（真实形态：workflow-state 少传位置参数）。 */
  function usageFlow(minutesAgo = 1, script = 'workflow-state'): FlowRecord {
    return flow({
      script, status: 'FAILED', exitCode: 1,
      startedAt: iso(minutesAgo), endedAt: iso(minutesAgo),
      stdout: '',
      stderr: '[workflow-state] 只接受 2 个位置参数（<project-dir> <command>），收到 1 个: D:\ws\n'
        + 'Usage: node workflow-state.mjs <project-dir> status|advance|check [--node <node-id>]',
    });
  }

  it('exit 1 + stderr 命中用法提示 → usage（不是 failed/verdict）', () => {
    expect(classifyFlowOutcome(usageFlow())).toBe<FlowOutcomeClass>('usage');
  });

  it('usage 优先于白名单：参数挡下就是 usage，无论脚本是否在裁决白名单', () => {
    expect(classifyFlowOutcome(usageFlow(1, 'gate-check'))).toBe<FlowOutcomeClass>('usage');
  });

  it('反向自检：普通故障 stderr（Cannot find module）不命中 usage 标记', () => {
    expect(classifyFlowOutcome(flow({
      script: 'workflow-state', status: 'FAILED', exitCode: 1, stdout: '', stderr: 'Error: Cannot find module x',
    }))).toBe<FlowOutcomeClass>('failed');
  });

  it('全 usage 的脚本 → insufficient（没有任何一次真实执行，比率无意义）', () => {
    const flows = [usageFlow(1), usageFlow(2), usageFlow(3)];
    const s = analyzeSkillHealth(stateOf(flows), NOW).scripts[0];
    expect(s?.usageErrors).toBe(3);
    expect(s?.level).toBe('insufficient');
  });

  it('混合：6 done + 2 usage → healthy（分母剔除 usage），usageErrors=2 白盒单列', () => {
    const flows = [
      usageFlow(1), usageFlow(2),
      ...Array.from({ length: 6 }, (_, i) => flow({ script: 'workflow-state', startedAt: iso(i + 10) })),
    ];
    const s = analyzeSkillHealth(stateOf(flows), NOW).scripts[0];
    expect(s?.usageErrors).toBe(2);
    expect(s?.recentEffectiveRate).toBe(1);
    expect(s?.level).toBe('healthy');
  });

  it('摘要必须点名「调用方用法错误 N 次不计入」——不许静默吞掉', () => {
    const flows = [usageFlow(1), flow({ script: 'workflow-state', startedAt: iso(5) })];
    const summary = formatHealthSummary(analyzeSkillHealth(stateOf(flows), NOW));
    expect(summary).toContain('用法错误 1');
    expect(summary).toContain('不计入');
  });
});

describe('analyzeSkillHealth：分级改用有效成功率', () => {
  it('门禁连续 4 次正确拒绝 + 4 次 DONE → healthy（原始成功率仅 50%）', () => {
    const flows = [
      ...Array.from({ length: 4 }, (_, i) => gateReject(i + 1)),
      ...Array.from({ length: 4 }, (_, i) => flow({ script: 'gate-check', startedAt: iso(i + 10) })),
    ];
    const s = analyzeSkillHealth(stateOf(flows), NOW).scripts[0];
    expect(s?.level).toBe('healthy');
    expect(s?.successRate).toBeCloseTo(0.5, 5);        // 原始口径保留（白盒两个数都在）
    expect(s?.recentSuccessRate).toBeCloseTo(0.5, 5);
    expect(s?.validVerdicts).toBe(4);
    expect(s?.effectiveSuccessRate).toBe(1);
    expect(s?.recentEffectiveRate).toBe(1);
  });

  it('真故障（stdout 为空）仍判 degraded 并给 critical 建议', () => {
    const flows = [
      ...Array.from({ length: 4 }, (_, i) => flow({
        script: 'gate-check', status: 'FAILED', exitCode: 1, stdout: '', startedAt: iso(i + 1),
      })),
      ...Array.from({ length: 2 }, (_, i) => flow({ script: 'gate-check', startedAt: iso(i + 10) })),
    ];
    const report = analyzeSkillHealth(stateOf(flows), NOW);
    const s = report.scripts[0];
    expect(s?.level).toBe('degraded');
    expect(s?.validVerdicts).toBe(0);
    const sug = report.suggestions.find((x) => x.script === 'gate-check');
    expect(sug?.severity).toBe('critical');
  });

  it('混合：一半正确拒绝一半真故障 → degraded（有效 0.75 < 0.8），但严重度为 warn', () => {
    const flows = [
      ...Array.from({ length: 3 }, (_, i) => gateReject(i + 1)),
      ...Array.from({ length: 3 }, (_, i) => flow({
        script: 'gate-check', status: 'FAILED', exitCode: 1, stdout: '', startedAt: iso(i + 10),
      })),
      ...Array.from({ length: 2 }, (_, i) => flow({ script: 'gate-check', startedAt: iso(i + 20) })),
    ];
    const report = analyzeSkillHealth(stateOf(flows), NOW);
    const s = report.scripts[0];
    expect(s?.validVerdicts).toBe(3);
    expect(s?.recentEffectiveRate).toBeCloseTo(0.625, 5); // (3 verdict + 2 done) / 8
    expect(s?.level).toBe('degraded');
    expect(report.suggestions.find((x) => x.script === 'gate-check')?.severity).toBe('warn');
  });

  it('全局口径同样给出有效数：overallEffectiveRate 与 totalValidVerdicts', () => {
    const flows = [gateReject(1), flow({ script: 'gate-check', startedAt: iso(5) })];
    const report = analyzeSkillHealth(stateOf(flows), NOW);
    expect(report.totalValidVerdicts).toBe(1);
    expect(report.overallEffectiveRate).toBe(1);
    expect(report.overallSuccessRate).toBeCloseTo(0.5, 5);
  });

  it('摘要里必须同时出现「有效」与「有效负裁决」（白盒：不许只报一个数）', () => {
    const flows = [
      ...Array.from({ length: 4 }, (_, i) => gateReject(i + 1)),
      flow({ script: 'gate-check', startedAt: iso(20) }),
    ];
    const summary = formatHealthSummary(analyzeSkillHealth(stateOf(flows), NOW));
    expect(summary).toContain('有效');
    expect(summary).toContain('有效负裁决 4');
  });
});
