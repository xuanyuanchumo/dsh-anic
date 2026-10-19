import { describe, it, expect } from 'vitest';
import {
  initialBootstrapState,
  advanceBootstrap,
  transitionBootstrap,
  canTransitionBootstrap,
  findBootstrapTransition,
  BOOTSTRAP_TRANSITIONS,
  BOOTSTRAP_PHASES,
  type BootstrapState,
  type BootstrapStatus,
} from '../../src/host/selfBootstrap.ts';
import {
  isAllowedScript,
  listSkillScripts,
  validateWorkspace,
} from '../../src/host/skillInvoker.ts';

describe('selfBootstrap state machine', () => {
  it('initial state is IDLE with round 0', () => {
    const s = initialBootstrapState();
    expect(s.status).toBe('IDLE');
    expect(s.round).toBe(0);
    expect(s.maxRounds).toBe(3);
    expect(s.history).toEqual([]);
  });

  it('advanceBootstrap: PASS → CONVERGED', () => {
    const s = initialBootstrapState();
    const next = advanceBootstrap(s, 0.95, 'PASS', null);
    expect(next.status).toBe('CONVERGED');
    expect(next.round).toBe(1);
    expect(next.lastEvalScore).toBe(0.95);
    expect(next.history).toHaveLength(1);
  });

  it('advanceBootstrap: approve → CONVERGED', () => {
    const s = initialBootstrapState();
    const next = advanceBootstrap(s, 0.9, 'approve', null);
    expect(next.status).toBe('CONVERGED');
  });

  it('advanceBootstrap: FAIL + round < max → FIXING', () => {
    const s = initialBootstrapState(3);
    const next = advanceBootstrap(s, 0.7, 'FAIL', 'fix-N3');
    expect(next.status).toBe('FIXING');
    expect(next.round).toBe(1);
    expect(next.history[0]?.fixApplied).toBe('fix-N3');
  });

  it('advanceBootstrap: FAIL + round >= max → EXHAUSTED', () => {
    let s: BootstrapState = initialBootstrapState(2);
    s = advanceBootstrap(s, 0.7, 'FAIL', 'fix-1');
    s = advanceBootstrap(s, 0.75, 'FAIL', 'fix-2');
    expect(s.status).toBe('EXHAUSTED');
    expect(s.round).toBe(2);
    expect(s.history).toHaveLength(2);
  });

  it('advanceBootstrap: doubt → FIXING (not CONVERGED)', () => {
    const s = initialBootstrapState();
    const next = advanceBootstrap(s, 0.6, 'doubt', null);
    expect(next.status).toBe('FIXING');
  });
});

// ── cycle-38：表驱动状态机（修 doc18 P1-6「中间态空转」）──
//
// 旧实现只有 advanceBootstrap 一条写路径，只会产出 CONVERGED/EXHAUSTED/FIXING；
// EVALUATING / GATE_CHECKING / VERIFYING 靠路由直接改字段，VERIFYING 更是零赋值。
// 以下用例钉死两件事：中间态**可达且落盘**，非法转移**被拒绝而非静默纠正**。

describe('bootstrap transition table', () => {
  it('声明的每个状态都可达（无死状态）', () => {
    const reachable = new Set<BootstrapStatus>(['IDLE']);
    // 从 IDLE 出发按表做闭包：只要有一条边的起点是通配或已可达状态，终点即可达
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of BOOTSTRAP_TRANSITIONS) {
        if (t.from === '*' || reachable.has(t.from)) {
          if (!reachable.has(t.to)) { reachable.add(t.to); changed = true; }
        }
      }
    }
    const declared: BootstrapStatus[] = [
      'IDLE', 'EVALUATING', 'GATE_CHECKING', 'FIXING', 'VERIFYING', 'CONVERGED', 'EXHAUSTED',
    ];
    for (const st of declared) expect(reachable.has(st)).toBe(true);
  });

  it('中间态相位可从 IDLE 依次推进：start → eval-done → gate-fail → fix-done', () => {
    let s = initialBootstrapState();
    const seq: Array<[Parameters<typeof transitionBootstrap>[1], BootstrapStatus]> = [
      ['start', 'EVALUATING'],
      ['eval-done', 'GATE_CHECKING'],
      ['gate-fail', 'FIXING'],
      ['fix-done', 'VERIFYING'],
      ['verify-fail', 'GATE_CHECKING'],
    ];
    for (const [trigger, expected] of seq) {
      const moved = transitionBootstrap(s, trigger);
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.state.status).toBe(expected);
      s = moved.state;
    }
  });

  it('相位推进边不用通配：顺序错误即拒绝（fail-closed）', () => {
    const idle = initialBootstrapState();
    // 没查过门禁就报 gate-fail / 没修复就进复检 / 没复检就重查 —— 全部非法
    for (const trigger of ['gate-fail', 'fix-done', 'verify-fail'] as const) {
      const moved = transitionBootstrap(idle, trigger);
      expect(moved.ok).toBe(false);
      if (moved.ok) return;
      expect(moved.reason).toContain('illegal bootstrap transition');
      // 拒绝时状态原样返回，不伪造进展
      expect(moved.state.status).toBe('IDLE');
    }
  });

  it('canTransitionBootstrap 与 findBootstrapTransition 同判据', () => {
    expect(canTransitionBootstrap('IDLE', 'start')).toBe(true);
    expect(canTransitionBootstrap('IDLE', 'gate-fail')).toBe(false);
    expect(findBootstrapTransition('GATE_CHECKING', 'gate-fail')?.to).toBe('FIXING');
    expect(findBootstrapTransition('IDLE', 'gate-fail')).toBeNull();
    // settle-* 与 reset 是通配边：任何起点都合法
    expect(canTransitionBootstrap('VERIFYING', 'settle-pass')).toBe(true);
    expect(canTransitionBootstrap('CONVERGED', 'reset')).toBe(true);
  });

  it('transitionBootstrap 只改 status 与被 patch 的字段，不动 round/history', () => {
    const s = advanceBootstrap(initialBootstrapState(), 0.5, 'FAIL', null);
    const moved = transitionBootstrap(s, 'start', { lastEvalScore: 0.77 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.status).toBe('EVALUATING');
    expect(moved.state.round).toBe(s.round);
    expect(moved.state.history).toEqual(s.history);
    expect(moved.state.lastEvalScore).toBe(0.77);
  });

  it('BOOTSTRAP_PHASES 是中间态子集（不含终态与 IDLE）', () => {
    for (const p of BOOTSTRAP_PHASES) {
      expect(['EVALUATING', 'GATE_CHECKING', 'FIXING', 'VERIFYING']).toContain(p);
    }
    expect(BOOTSTRAP_PHASES).toHaveLength(4);
  });
});

describe('skillInvoker', () => {
  it('isAllowedScript accepts known scripts', () => {
    expect(isAllowedScript('eval-runner')).toBe(true);
    expect(isAllowedScript('gate-check')).toBe(true);
    expect(isAllowedScript('init-workflow')).toBe(true);
  });

  it('isAllowedScript rejects unknown scripts', () => {
    expect(isAllowedScript('rm-rf')).toBe(false);
    expect(isAllowedScript('../../../etc/passwd')).toBe(false);
    expect(isAllowedScript('')).toBe(false);
  });

  it('listSkillScripts returns 15 scripts', () => {
    const scripts = listSkillScripts();
    expect(scripts).toHaveLength(15);
    expect(scripts).toContain('eval-runner');
    expect(scripts).toContain('gate-check');
    expect(scripts).toContain('archive-cycle');
  });

  it('validateWorkspace rejects path traversal', () => {
    const r = validateWorkspace('../../../etc');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('traversal');
  });

  it('validateWorkspace rejects non-existent', () => {
    const r = validateWorkspace('/nonexistent/path/xyz');
    expect(r.ok).toBe(false);
  });

  it('validateWorkspace rejects empty', () => {
    const r = validateWorkspace('');
    expect(r.ok).toBe(false);
  });
});
