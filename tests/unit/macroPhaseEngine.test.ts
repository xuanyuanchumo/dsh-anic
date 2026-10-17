/**
 * macroPhaseEngine 契约 —— 技能 workflow-state.mjs 语义逐字对齐（R3 阶段 3）。
 *
 * 钉死面：PHASES 表 / 曾通过门语义（任一历史 PASS，非每门最新）/ 只许前向 /
 * 末相免检 exit 0 / 失败零写入 / dryRun 零写入 / 消息文案逐字。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PHASES, PHASE_IDS, loadMacroState, initMacroState, readGateResults, advanceMacro,
} from '../../src/host/flows/macroPhaseEngine.ts';

let tmp = '';

beforeEach(() => {
  tmp = join(tmpdir(), `anic-macro-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, '.cycles'), { recursive: true });
});

// F-T2（cycle-13）：与其余差分测试对齐——原先无清理，每轮全量泄漏临时目录。
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeState(currentPhase: string): void {
  writeFileSync(join(tmp, '.cycles', 'workflow-state.json'), JSON.stringify({
    currentPhase, currentCycle: 'cycle-1', phaseHistory: [], nodeStatus: {}, createdAt: 't', updatedAt: 't',
  }));
}

function writeLedger(entries: Array<{ gate: string; result: string }>): void {
  mkdirSync(join(tmp, '.cycles', 'gates'), { recursive: true });
  writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
    entries: entries.map((e, i) => ({ gate: e.gate, gateName: e.gate, result: e.result, detail: 'd', timestamp: `t${i}`, previousHash: '', hash: `h${i}` })),
    chainHead: 'h',
  }));
}

describe('macroPhaseEngine', () => {
  it('PHASES 表与技能逐字同表（6 相 + 门映射）', () => {
    expect(PHASES.map((p) => [p.id, p.gates])).toEqual([
      ['plan', ['G0']], ['design', ['G0']], ['build', ['G1']],
      ['test', ['G2']], ['deploy', ['G3']], ['maintain', []],
    ]);
    expect(PHASES[0]!.name).toBe('Plan（规划）');
    expect(PHASE_IDS).toEqual(['plan', 'design', 'build', 'test', 'deploy', 'maintain']);
  });

  it('loadMacroState：缺失 → null；损坏 JSON → null；合法 → 读出', () => {
    expect(loadMacroState(tmp)).toBeNull();
    writeFileSync(join(tmp, '.cycles', 'workflow-state.json'), '{broken');
    expect(loadMacroState(tmp)).toBeNull();
    writeState('build');
    const s = loadMacroState(tmp);
    expect(s?.currentPhase).toBe('build');
    expect(s?.currentCycle).toBe('cycle-1');
  });

  it('initMacroState：无 cycle → currentCycle null；数值序取最新（cycle-10 > cycle-9）', () => {
    mkdirSync(join(tmp, '.cycles', 'cycles', 'cycle-9'), { recursive: true });
    mkdirSync(join(tmp, '.cycles', 'cycles', 'cycle-10'), { recursive: true });
    const s = initMacroState(tmp);
    expect(s.currentPhase).toBe('plan');
    expect(s.currentCycle).toBe('cycle-10');
  });

  it('readGateResults：曾 PASS / 曾 FAIL 两名单（包裹形态）；损坏 → 空', () => {
    expect(readGateResults(tmp)).toEqual({ passed: [], failed: [] });
    writeLedger([{ gate: 'G0', result: 'PASS' }, { gate: 'G1', result: 'FAIL' }, { gate: 'G0', result: 'FAIL' }]);
    const r = readGateResults(tmp);
    // G0 曾 PASS 也曾 FAIL —— 两个名单都含（技能 cmdStatus 展示序 PASS 优先）
    expect(r.passed).toEqual(['G0']);
    expect(r.failed).toEqual(['G1', 'G0']);
    writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), 'nope');
    expect(readGateResults(tmp)).toEqual({ passed: [], failed: [] });
  });

  it('readGateResults：裸数组形态可读（native 防御；技能侧只认包裹）', () => {
    mkdirSync(join(tmp, '.cycles', 'gates'), { recursive: true });
    writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), JSON.stringify([
      { gate: 'G0', result: 'PASS' },
    ]));
    expect(readGateResults(tmp).passed).toEqual(['G0']);
  });

  it('推进被拒：门未过 → 技能逐字消息 + exit 1 + 零写入', () => {
    writeState('plan'); // plan 需要 G0，无账本
    const out = advanceMacro(tmp);
    expect(out.ok).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.message).toBe('Cannot advance: gate G0 for phase Plan（规划） has not passed.');
    expect(out.gate).toBe('G0');
    expect(out.passedGates).toBe('none');
    // 失败零写入：state 文件保持 plan
    expect(loadMacroState(tmp)?.currentPhase).toBe('plan');
  });

  it('推进成功：G0 曾 PASS → plan→design；消息与 nextGates 逐字', () => {
    writeState('plan');
    writeLedger([{ gate: 'G0', result: 'PASS' }]);
    const out = advanceMacro(tmp);
    expect(out.ok).toBe(true);
    expect(out.from).toBe('plan');
    expect(out.to).toBe('design');
    expect(out.message).toBe('Advanced from Plan（规划） to Design（设计）.');
    expect(out.nextGates).toEqual(['G0']);
    const s = loadMacroState(tmp);
    expect(s?.currentPhase).toBe('design');
    expect(s?.phaseHistory).toEqual([{ phase: 'plan', exitedAt: expect.any(String) }]);
  });

  it('曾通过语义：G0 历史上 PASS 过（哪怕后来 FAIL）仍放行', () => {
    writeState('plan');
    writeLedger([{ gate: 'G0', result: 'PASS' }, { gate: 'G0', result: 'FAIL' }]);
    expect(advanceMacro(tmp).ok).toBe(true);
  });

  it('回退拒绝：design→plan → 技能逐字消息', () => {
    writeState('design');
    writeLedger([{ gate: 'G0', result: 'PASS' }]);
    const out = advanceMacro(tmp, 'plan');
    expect(out.ok).toBe(false);
    expect(out.message).toBe('Cannot advance backwards or to same phase. Current: design, Target: plan');
  });

  it('同相拒绝：design→design', () => {
    writeState('design');
    expect(advanceMacro(tmp, 'design').message)
      .toBe('Cannot advance backwards or to same phase. Current: design, Target: design');
  });

  it('未知相位：逐字消息含合法相位表', () => {
    writeState('plan');
    const out = advanceMacro(tmp, 'alpha');
    expect(out.ok).toBe(false);
    expect(out.message).toBe('Unknown phase: alpha. Valid phases: plan, design, build, test, deploy, maintain');
  });

  it('非法当前相位（状态文件被改坏）→ 逐字拒绝', () => {
    writeState('limbo');
    expect(advanceMacro(tmp).message).toBe('Invalid current phase: limbo');
  });

  it('末相再推进：exit 0 + final + 零写入', () => {
    writeState('maintain');
    const out = advanceMacro(tmp);
    expect(out.ok).toBe(true);
    expect(out.final).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.message).toBe('Already at final phase (Maintain（维护）). No more phases to advance.');
    expect(loadMacroState(tmp)?.currentPhase).toBe('maintain');
  });

  it('跳相推进：plan→test（G0 曾 PASS）一步到位', () => {
    writeState('plan');
    writeLedger([{ gate: 'G0', result: 'PASS' }]);
    const out = advanceMacro(tmp, 'test');
    expect(out.ok).toBe(true);
    expect(out.to).toBe('test');
    expect(out.nextGates).toEqual(['G2']);
    expect(loadMacroState(tmp)?.currentPhase).toBe('test');
  });

  it('dryRun：判定通过但零写入', () => {
    writeState('plan');
    writeLedger([{ gate: 'G0', result: 'PASS' }]);
    const out = advanceMacro(tmp, undefined, { dryRun: true });
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.to).toBe('design');
    expect(loadMacroState(tmp)?.currentPhase).toBe('plan'); // 未写
  });

  it('状态文件不存在 + 推进失败 → 不落盘 init 态（技能 cmdAdvance 同款）', () => {
    rmSync(join(tmp, '.cycles', 'workflow-state.json'), { force: true });
    const out = advanceMacro(tmp); // 无账本 → G0 拒绝
    expect(out.ok).toBe(false);
    expect(existsSync(join(tmp, '.cycles', 'workflow-state.json'))).toBe(false);
  });

  it('状态文件不存在 + 推进成功 → 落盘（init 态 + 推进）', () => {
    rmSync(join(tmp, '.cycles', 'workflow-state.json'), { force: true });
    writeLedger([{ gate: 'G0', result: 'PASS' }]);
    expect(advanceMacro(tmp).ok).toBe(true);
    const s = JSON.parse(readFileSync(join(tmp, '.cycles', 'workflow-state.json'), 'utf-8'));
    expect(s.currentPhase).toBe('design');
  });
});
