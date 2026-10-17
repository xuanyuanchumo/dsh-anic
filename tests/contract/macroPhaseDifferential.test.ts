/**
 * macroPhase 差分契约 —— 孪生夹具：script 正典 vs native 引擎逐字段比对（R3 阶段 3）。
 *
 * advance 是写动作，不能像 gate-check 那样同目录双跑（会双推进）。差分以
 * 「两份完全相同的夹具各跑一侧」完成：比对落盘的 workflow-state.json
 * （currentPhase / phaseHistory 相位序列）与拒绝消息的逐字相等。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { advanceMacro } from '../../src/host/flows/macroPhaseEngine.ts';
import { invokeSkillScript } from '../../src/host/skillInvoker.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('../../assets/skill/scripts/', import.meta.url));

let base = '';

beforeEach(() => {
  base = join(tmpdir(), `anic-macro-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

// F-T2（cycle-13）：原先无清理——每轮全量跑泄漏 ~20 个 anic-macro-diff-* 临时
// 目录（cycle-13 清理时积压 74 个 anic-*）。与其余四个差分测试的 afterEach 对齐。
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  state?: string;
  ledger?: Array<{ gate: string; result: string }>;
}

function makeFixture(name: string, f: Fixture): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '.cycles'), { recursive: true });
  writeFileSync(join(dir, '.cycles', 'workflow-state.json'), JSON.stringify({
    currentPhase: f.state ?? 'plan',
    currentCycle: 'cycle-1',
    phaseHistory: [],
    nodeStatus: {},
    createdAt: 't',
    updatedAt: 't',
  }));
  mkdirSync(join(dir, '.cycles', 'gates'), { recursive: true });
  writeFileSync(join(dir, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
    entries: (f.ledger ?? []).map((e, i) => ({
      gate: e.gate, gateName: e.gate, result: e.result, detail: 'd',
      timestamp: `t${i}`, previousHash: '', hash: `h${i}`,
    })),
    chainHead: 'h',
  }));
  return dir;
}

/** 孪生夹具：A 跑 script、B 跑 native，比对落盘状态。 */
function differential(f: Fixture, target?: string) {
  const a = makeFixture('script-side', f);
  const b = makeFixture('native-side', f);
  const script = invokeSkillScript(SCRIPTS_DIR, 'workflow-state', ['advance', ...(target ? ['--node', target] : [])], a, 30000);
  const native = advanceMacro(b, target);
  const readState = (dir: string) => {
    const raw = JSON.parse(readFileSync(join(dir, '.cycles', 'workflow-state.json'), 'utf-8'));
    return {
      currentPhase: raw.currentPhase as string,
      history: (raw.phaseHistory as Array<{ phase: string }>).map((h) => h.phase),
    };
  };
  return { script, native, scriptState: readState(a), nativeState: readState(b) };
}

describe('macroPhase 差分契约（script vs native）', () => {
  it('全绿夹具：plan + G0 PASS → 两侧 currentPhase/phaseHistory 全等', () => {
    const { script, native, scriptState, nativeState } = differential({ state: 'plan', ledger: [{ gate: 'G0', result: 'PASS' }] });
    expect(script.exitCode).toBe(0);
    expect(native.ok).toBe(true);
    expect(nativeState.currentPhase).toBe(scriptState.currentPhase);
    expect(nativeState.currentPhase).toBe('design');
    expect(nativeState.history).toEqual(scriptState.history);
    expect(nativeState.history).toEqual(['plan']);
  });

  it('红夹具：无账本 → 两侧拒绝消息逐字相等、状态零变化', () => {
    const { script, native, scriptState, nativeState } = differential({ state: 'plan' });
    expect(script.exitCode).toBe(1);
    expect(native.ok).toBe(false);
    expect(native.message).toBe(script.stderr.split('\n')[0]);
    expect(scriptState.currentPhase).toBe('plan');
    expect(nativeState.currentPhase).toBe('plan');
  });

  it('跳相夹具：plan→test（G0 PASS）→ 两侧一步到 test', () => {
    const { script, native, scriptState, nativeState } = differential(
      { state: 'plan', ledger: [{ gate: 'G0', result: 'PASS' }] },
      'test',
    );
    expect(script.exitCode).toBe(0);
    expect(native.ok).toBe(true);
    expect(nativeState.currentPhase).toBe(scriptState.currentPhase);
    expect(nativeState.currentPhase).toBe('test');
    expect(nativeState.history).toEqual(scriptState.history);
  });

  it('build 门夹具：build 需要 G1（只有 G0 PASS）→ 两侧同拒', () => {
    const { script, native } = differential({ state: 'build', ledger: [{ gate: 'G0', result: 'PASS' }] });
    expect(script.exitCode).toBe(1);
    expect(native.ok).toBe(false);
    expect(native.message).toBe(script.stderr.split('\n')[0]);
    expect(native.message).toBe('Cannot advance: gate G1 for phase Build（构建） has not passed.');
  });

  it('末相夹具：maintain → 两侧 final 语义（exit 0 + 零推进）', () => {
    const { script, native, scriptState, nativeState } = differential({ state: 'maintain' });
    expect(script.exitCode).toBe(0);
    expect(native.ok).toBe(true);
    expect(native.final).toBe(true);
    expect(nativeState.currentPhase).toBe('maintain');
    expect(scriptState.currentPhase).toBe('maintain');
  });
});
