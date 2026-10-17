/**
 * D-1101 终态重入契约 —— 四个 task 型流程状态机的终态→RUNNING 'run' 边。
 *
 * 背景：cycle-11 真机发现框架级 P1「终态不可重入」——auto-fix 首轮 CONVERGED 后
 * 第二轮 run 的全部转移被拒（events 空、状态卡死）。当场为 auto-fix 补了
 * CONVERGED/CIRCUIT→RUNNING 边；本契约把同一修复推广到 gate-check/archive/hitl
 * 三个先行流程，并钉死 macro-phase 的**排除决议**（技能正典无 reset 语义）。
 *
 * 承重断言：
 *  - 描述子层：每个 task 流程的每个终态都有 'run' 重入边（macro-phase 除外）
 *  - 机器层：applyTransition(终态, 'run') 全部放行（不依赖守卫——重入是图形状）
 *  - 集成层：archive 二连跑（DONE 后再 run 新 cycle）与 hitl PASSED 后重跑
 *    都不需要 reset——与技能侧语义一致（每个 cycle 是独立一跑）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GATE_CHECK_FLOW } from '../../src/host/flows/gateCheckFlow.ts';
import { ARCHIVE_FLOW, runArchiveFlow } from '../../src/host/flows/archiveFlow.ts';
import { HITL_FLOW, runHitlFlow } from '../../src/host/flows/hitlFlow.ts';
import { AUTO_FIX_FLOW } from '../../src/host/flows/autoFixFlow.ts';
import { MACRO_PHASE_FLOW } from '../../src/host/flows/macroPhaseFlow.ts';
import { applyTransition, validateDescriptor } from '../../src/host/flows/machine.ts';
import { __resetFlowRegistryForTests } from '../../src/host/flows/registry.ts';
import { seedGitRepo, seedCycle, seedGreenLedger } from '../helpers/hitlWorkspace.ts';

let root: string;

const DONE_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 完成 |';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-reentry-'));
  __resetFlowRegistryForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('D-1101 描述子层：终态重入边齐全', () => {
  it('四个描述子仍合法（新增边不破坏图约束）', () => {
    for (const d of [GATE_CHECK_FLOW, ARCHIVE_FLOW, HITL_FLOW, AUTO_FIX_FLOW, MACRO_PHASE_FLOW]) {
      expect(validateDescriptor(d), d.id).toEqual([]);
    }
  });

  it('gate-check：PASSED 与 FAILED 都有 run→RUNNING 重入边', () => {
    const edges = GATE_CHECK_FLOW.transitions
      .filter((t) => t.trigger === 'run' && t.to === 'RUNNING')
      .map((t) => t.from);
    expect(edges).toContain('IDLE');
    expect(edges).toContain('RUNNING');
    expect(edges).toContain('PASSED');
    expect(edges).toContain('FAILED');
  });

  it('archive：DONE 有 run→RUNNING 重入边（不同 cycle 是全新合法运行）', () => {
    const edges = ARCHIVE_FLOW.transitions
      .filter((t) => t.trigger === 'run' && t.to === 'RUNNING')
      .map((t) => t.from);
    expect(edges).toContain('IDLE');
    expect(edges).toContain('DONE');
    expect(edges).toContain('BLOCKED');
  });

  it('hitl：PASSED 与 FAILED 都有 run→RUNNING 重入边（BLOCKED 重试边语义不变）', () => {
    const edges = HITL_FLOW.transitions
      .filter((t) => t.trigger === 'run' && t.to === 'RUNNING')
      .map((t) => t.from);
    expect(edges).toContain('IDLE');
    expect(edges).toContain('PASSED');
    expect(edges).toContain('FAILED');
    expect(edges).toContain('BLOCKED');
  });

  it('auto-fix：CONVERGED/CIRCUIT 重入边已在（cycle-11 修复的回归钉；ITERATING 是中间态自环非终态）', () => {
    const edges = AUTO_FIX_FLOW.transitions
      .filter((t) => t.trigger === 'run' && t.to === 'RUNNING')
      .map((t) => t.from);
    expect(edges).toContain('CONVERGED');
    expect(edges).toContain('CIRCUIT');
    // ITERATING 不需要 run 重入边：它是迭代内中间态（iterating 自环 + all-pass/exhausted 出口）
    expect(edges).not.toContain('ITERATING');
  });

  it('macro-phase 排除决议：无 run 触发词、无回退边（技能正典 maintain 无出口）', () => {
    expect(MACRO_PHASE_FLOW.transitions.some((t) => t.trigger === 'run')).toBe(false);
    const maintain = MACRO_PHASE_FLOW.transitions.filter((t) => t.from === 'maintain');
    expect(maintain).toEqual([]);
    // 全部边都是前向（from 下标 < to 下标）——「禁回退」由图形状承载
    const order = ['plan', 'design', 'build', 'test', 'deploy', 'maintain'];
    for (const t of MACRO_PHASE_FLOW.transitions) {
      expect(order.indexOf(t.to), `${t.from} -> ${t.to}`).toBeGreaterThan(order.indexOf(t.from));
    }
  });
});

describe('D-1101 机器层：applyTransition(终态, run) 放行', () => {
  it('终态重入不依赖守卫负载（图形状放行，守卫只管终态判定边）', () => {
    const cases: Array<[typeof GATE_CHECK_FLOW, string]> = [
      [GATE_CHECK_FLOW, 'PASSED'], [GATE_CHECK_FLOW, 'FAILED'],
      [ARCHIVE_FLOW, 'DONE'],
      [HITL_FLOW, 'PASSED'], [HITL_FLOW, 'FAILED'], [HITL_FLOW, 'BLOCKED'],
      [AUTO_FIX_FLOW, 'CONVERGED'], [AUTO_FIX_FLOW, 'CIRCUIT'],
    ];
    for (const [flow, from] of cases) {
      const res = applyTransition(flow, {}, from as never, 'run');
      expect(res.ok, `${flow.id} ${from} --run-->`).toBe(true);
    }
  });
});

describe('D-1101 集成层：终态后二连跑无需 reset', () => {
  it('archive：cycle-1 DONE 后归档 cycle-2 是独立一跑（DONE→RUNNING→DONE）', () => {
    const c1 = join(root, '.cycles', 'cycles', 'cycle-1');
    mkdirSync(c1, { recursive: true });
    writeFileSync(join(c1, '任务清单.md'), DONE_TASKS);
    const r1 = runArchiveFlow(root, { cycle: 1, mode: 'native' });
    expect(r1.state).toBe('DONE');

    const c2 = join(root, '.cycles', 'cycles', 'cycle-2');
    mkdirSync(c2, { recursive: true });
    writeFileSync(join(c2, '任务清单.md'), DONE_TASKS);
    const r2 = runArchiveFlow(root, { cycle: 2, mode: 'native' });
    expect(r2.ok).toBe(true);
    expect(r2.state).toBe('DONE');
    // 第二跑的事件是全新一跑的形状（run+success），不是空事件
    expect(r2.events.map((e) => e.trigger)).toEqual(['run', 'success']);
  });

  it('hitl：全绿 PASSED 后新一轮审计直接重跑（PASSED→RUNNING→PASSED）', () => {
    seedGitRepo(root);
    seedCycle(root, true);
    seedGreenLedger(root);
    const r1 = runHitlFlow(root, { mode: 'native' });
    expect(r1.verdict).toBe('pass');
    expect(r1.state).toBe('PASSED');

    const r2 = runHitlFlow(root, { mode: 'native' });
    expect(r2.verdict).toBe('pass');
    expect(r2.exitCode).toBe(0);
    expect(r2.state).toBe('PASSED');
    expect(r2.events.map((e) => e.trigger)).toEqual(['run', 'all-pass']);
  });
});
