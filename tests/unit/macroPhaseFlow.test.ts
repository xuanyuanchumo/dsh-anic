/**
 * macroPhaseFlow —— FlowRegistry 第二实例的机器面契约（R3 阶段 3）。
 *
 * 钉死面：描述子 15 条前向边（邻接 advance / 跳相 jump:from:to）/ 守卫
 * phase-gates-passed / native 推进 + 投影 / dryRun 零写 / replay 全等。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MACRO_PHASE_FLOW, MACRO_PHASE_GUARDS, runMacroPhaseFlow, statusMacroPhase,
  rebuildMacroFlowState, type MacroPhaseState,
} from '../../src/host/flows/macroPhaseFlow.ts';
import { validateDescriptor } from '../../src/host/flows/machine.ts';
import { registerFlow, getFlow, listFlows, __resetFlowRegistryForTests } from '../../src/host/flows/registry.ts';
import { loadFlowProjection } from '../../src/host/flows/persistence.ts';

let tmp = '';

beforeEach(() => {
  tmp = join(tmpdir(), `anic-macro-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, '.cycles'), { recursive: true });
});

// F-T2（cycle-13）：与其余差分测试对齐——原先无清理，每轮全量泄漏临时目录。
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedState(currentPhase: string): void {
  writeFileSync(join(tmp, '.cycles', 'workflow-state.json'), JSON.stringify({
    currentPhase, currentCycle: 'cycle-1', phaseHistory: [], nodeStatus: {}, createdAt: 't', updatedAt: 't',
  }));
}

function seedLedger(entries: Array<{ gate: string; result: string }>): void {
  mkdirSync(join(tmp, '.cycles', 'gates'), { recursive: true });
  writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
    entries: entries.map((e, i) => ({ gate: e.gate, gateName: e.gate, result: e.result, detail: 'd', timestamp: `t${i}`, previousHash: '', hash: `h${i}` })),
    chainHead: 'h',
  }));
}

describe('macroPhaseFlow 描述子与守卫', () => {
  it('描述子合法（validateDescriptor 零问题）', () => {
    expect(validateDescriptor(MACRO_PHASE_FLOW)).toEqual([]);
  });

  it('15 条前向边：5 条邻接 advance + 10 条跳相 jump:from:to，全部带守卫', () => {
    const t = MACRO_PHASE_FLOW.transitions;
    expect(t).toHaveLength(15);
    const adjacent = t.filter((x) => x.trigger === 'advance');
    const jumps = t.filter((x) => x.trigger.startsWith('jump:'));
    expect(adjacent).toHaveLength(5);
    expect(jumps).toHaveLength(10);
    expect(adjacent.map((x) => `${x.from}->${x.to}`)).toEqual([
      'plan->design', 'design->build', 'build->test', 'test->deploy', 'deploy->maintain',
    ]);
    expect(t.every((x) => x.guard === 'phase-gates-passed')).toBe(true);
    // 无回退边（禁回退由图形状承载）
    const ids = ['plan', 'design', 'build', 'test', 'deploy', 'maintain'];
    expect(t.every((x) => ids.indexOf(x.from) < ids.indexOf(x.to))).toBe(true);
  });

  it('守卫：当前相门禁曾全绿 → ok；缺门 → 技能逐字 reason', () => {
    const ok = MACRO_PHASE_GUARDS['phase-gates-passed']!({ payload: { currentPhase: 'plan', gatesPassed: ['G0'] } });
    expect(ok).toEqual({ ok: true });
    const no = MACRO_PHASE_GUARDS['phase-gates-passed']!({ payload: { currentPhase: 'plan', gatesPassed: [] } });
    expect(ok.ok).toBe(true);
    expect(no.ok).toBe(false);
    expect(no.reason).toBe('Cannot advance: gate G0 for phase Plan（规划） has not passed.');
    // maintain 无门 → 恒 ok
    expect(MACRO_PHASE_GUARDS['phase-gates-passed']!({ payload: { currentPhase: 'maintain', gatesPassed: [] } })).toEqual({ ok: true });
    // 未知相位 → fail-closed
    expect(MACRO_PHASE_GUARDS['phase-gates-passed']!({ payload: { currentPhase: 'limbo' } }).ok).toBe(false);
  });

  it('注册进 FlowRegistry（同 id 首个胜出）', () => {
    __resetFlowRegistryForTests();
    const d = registerFlow(MACRO_PHASE_FLOW);
    expect(getFlow('macro-phase')?.id).toBe('macro-phase');
    expect(listFlows().map((f) => f.id)).toContain('macro-phase');
    d?.();
    expect(getFlow('macro-phase')).toBeUndefined();
  });
});

describe('runMacroPhaseFlow（native）', () => {
  it('推进成功：plan→design + 投影落盘 + 事件 1 条', () => {
    seedState('plan');
    seedLedger([{ gate: 'G0', result: 'PASS' }]);
    const r = runMacroPhaseFlow(tmp, { mode: 'native' });
    expect(r.ok).toBe(true);
    expect(r.from).toBe('plan');
    expect(r.to).toBe('design');
    expect(r.state).toBe('design');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ trigger: 'advance', from: 'plan', to: 'design' });
    const proj = loadFlowProjection<MacroPhaseState>(join(tmp, '.cycles'), 'macro-phase');
    expect(proj?.current).toBe('design');
    expect(proj?.history).toHaveLength(1);
  });

  it('门未过：ok:false + 消息逐字 + 不动投影', () => {
    seedState('plan');
    const r = runMacroPhaseFlow(tmp, { mode: 'native' });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Cannot advance: gate G0 for phase Plan（规划） has not passed.');
    expect(loadFlowProjection<MacroPhaseState>(join(tmp, '.cycles'), 'macro-phase')).toBeNull();
  });

  it('跳相：plan→test 走 jump:plan:test 边', () => {
    seedState('plan');
    seedLedger([{ gate: 'G0', result: 'PASS' }]);
    const r = runMacroPhaseFlow(tmp, { mode: 'native', target: 'test' });
    expect(r.ok).toBe(true);
    expect(r.to).toBe('test');
    expect(r.events[0]?.trigger).toBe('jump:plan:test');
  });

  it('dryRun：通过但状态文件与投影零变化', () => {
    seedState('plan');
    seedLedger([{ gate: 'G0', result: 'PASS' }]);
    const r = runMacroPhaseFlow(tmp, { mode: 'native', dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.to).toBe('design');
    expect(r.events).toHaveLength(0);
    expect(loadFlowProjection<MacroPhaseState>(join(tmp, '.cycles'), 'macro-phase')).toBeNull();
    // 状态文件未被推进（仍是 plan）
    expect(statusMacroPhase(tmp).currentPhase).toBe('plan');
  });

  it('末相：final 语义 + 零事件', () => {
    seedState('maintain');
    const r = runMacroPhaseFlow(tmp, { mode: 'native' });
    expect(r.ok).toBe(true);
    expect(r.final).toBe(true);
    expect(r.events).toHaveLength(0);
    expect(r.message).toBe('Already at final phase (Maintain（维护）). No more phases to advance.');
  });

  it('replay 与在线推进全等（INV-13）', () => {
    seedState('plan');
    seedLedger([{ gate: 'G0', result: 'PASS' }]);
    const r1 = runMacroPhaseFlow(tmp, { mode: 'native' }); // plan→design
    expect(r1.to).toBe('design');
    const r2 = runMacroPhaseFlow(tmp, { mode: 'native' }); // design→build（design 门也是 G0）
    expect(r2.to).toBe('build');
    const events = [...(r1.events ?? []), ...(r2.events ?? [])];
    expect(events).toHaveLength(2);
    const replayed = rebuildMacroFlowState(events);
    expect(replayed.state.current).toBe('build');
    expect(replayed.rejected).toEqual([]);
  });
});

describe('statusMacroPhase（只读视图）', () => {
  it('无状态文件：projectionSeeded=false + 零伪造', () => {
    const s = statusMacroPhase(tmp);
    expect(s.currentPhase).toBeNull();
    expect(s.projectionSeeded).toBe(false);
    expect(s.gates).toEqual([]);
  });

  it('有状态：相位名 + 门三态（曾 PASS 优先于曾 FAIL）', () => {
    seedState('build');
    seedLedger([{ gate: 'G1', result: 'FAIL' }, { gate: 'G1', result: 'PASS' }]);
    const s = statusMacroPhase(tmp);
    expect(s.currentPhase).toBe('build');
    expect(s.phaseName).toBe('Build（构建）');
    expect(s.gates).toEqual([{ gate: 'G1', status: 'PASS' }]);
  });

  it('PENDING：门从未评估', () => {
    seedState('test');
    seedLedger([]);
    expect(statusMacroPhase(tmp).gates).toEqual([{ gate: 'G2', status: 'PENDING' }]);
  });
});
