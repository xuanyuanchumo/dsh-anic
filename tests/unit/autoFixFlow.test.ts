/**
 * autoFixFlow 单测 —— 第 5 流程状态机（IDLE→RUNNING→ITERATING↺→CONVERGED/CIRCUIT）。
 * 重点：ITERATING 自环轨迹进投影历史（动态白盒）、CIRCUIT→RUNNING 恢复边、
 * INV-13 replay、script 模式 stdout 解析、前置错误不推进状态机。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUTO_FIX_FLOW, AUTO_FIX_GUARDS, runAutoFixFlow, rebuildAutoFixFlowState,
} from '../../src/host/flows/autoFixFlow.ts';
import { loadFlowProjection } from '../../src/host/flows/persistence.ts';
import { replayEvents } from '../../src/host/flows/machine.ts';
import { seedAutoFixWorkspace, PASSING_CMD, FAILING_CMD, transientCmd } from '../helpers/autoFixWorkspace.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-autofixflow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('流程描述子（第 5 流程）', () => {
  it('五状态 + 投影路径 + 引擎 + 技能回退名', () => {
    expect(AUTO_FIX_FLOW.id).toBe('auto-fix');
    expect(AUTO_FIX_FLOW.states).toEqual(['IDLE', 'RUNNING', 'ITERATING', 'CONVERGED', 'CIRCUIT']);
    expect(AUTO_FIX_FLOW.persistence).toEqual({ kind: 'projection', path: 'flows/auto-fix.json' });
    expect(AUTO_FIX_FLOW.engine).toBe('autoFixEngine');
    expect(AUTO_FIX_FLOW.scriptFallback).toBe('auto-fix-loop');
  });

  it('ITERATING 自环 + CIRCUIT→RUNNING 恢复边 + 终态重入边齐全', () => {
    const edges = AUTO_FIX_FLOW.transitions.map((t) => `${t.from}--${t.trigger}-->${t.to}`);
    expect(edges).toContain('ITERATING--iterating-->ITERATING');
    expect(edges).toContain('CIRCUIT--run-->RUNNING');
    expect(edges).toContain('CONVERGED--run-->RUNNING');
    expect(edges).toContain('ITERATING--all-pass-->CONVERGED');
    expect(edges).toContain('ITERATING--exhausted-->CIRCUIT');
    expect(edges).toContain('CONVERGED--reset-->IDLE');
  });

  it('守卫三件：verdict-pass / has-failures>0 / verdict-circuit', () => {
    expect(AUTO_FIX_GUARDS['verdict-pass']!({ payload: { verdict: 'pass' } })).toEqual({ ok: true });
    expect(AUTO_FIX_GUARDS['verdict-pass']!({ payload: { verdict: 'circuit' } }).ok).toBe(false);
    expect(AUTO_FIX_GUARDS['has-failures']!({ payload: { failures: 2 } })).toEqual({ ok: true });
    expect(AUTO_FIX_GUARDS['has-failures']!({ payload: { failures: 0 } }).ok).toBe(false);
    expect(AUTO_FIX_GUARDS['verdict-circuit']!({ payload: { verdict: 'circuit' } })).toEqual({ ok: true });
  });
});

describe('native 模式全生命周期', () => {
  it('首轮全绿 → CONVERGED + run/all-pass 两事件 + 投影落盘', () => {
    seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD });
    const r = runAutoFixFlow(dir, {});
    expect(r.state).toBe('CONVERGED');
    expect(r.verdict).toBe('pass');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'all-pass']);
    const projection = loadFlowProjection(join(dir, '.cycles'), 'auto-fix');
    expect(projection?.current).toBe('CONVERGED');
  });

  it('恒败 maxRetries=3 → CIRCUIT + ITERATING 轨迹×3 进投影历史（动态白盒）', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const r = runAutoFixFlow(dir, { maxRetries: 3 });
    expect(r.state).toBe('CIRCUIT');
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.pattern).toBe('repeating');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'iterating', 'iterating', 'iterating', 'exhausted']);
    const projection = loadFlowProjection(join(dir, '.cycles'), 'auto-fix');
    expect(projection?.current).toBe('CIRCUIT');
    expect(projection?.history.filter((e) => e.trigger === 'iterating')).toHaveLength(3);
    expect(existsSync(r.incidentPath ?? '')).toBe(true);
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
  });

  it('瞬态失败（标记命令）→ ITERATING→CONVERGED（retest 过）', () => {
    const marker = join(dir, 'transient-marker.txt');
    seedAutoFixWorkspace(dir, { testCmd: transientCmd(marker), config: false });
    const r = runAutoFixFlow(dir, { testCmd: transientCmd(marker), maxRetries: 2 });
    expect(r.state).toBe('CONVERGED');
    // run → iterating（识别失败）→ all-pass（retest 过——onProgress fixSuccess 不再推 iterating）
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'iterating', 'all-pass']);
  });

  it('CIRCUIT →（重跑全绿）→ RUNNING → CONVERGED 恢复路径', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const first = runAutoFixFlow(dir, { maxRetries: 1 });
    expect(first.state).toBe('CIRCUIT');
    // 修复后（换通过命令）重跑：CIRCUIT→RUNNING→CONVERGED
    const r = runAutoFixFlow(dir, { maxRetries: 1, testCmd: PASSING_CMD, mode: 'native' });
    expect(r.state).toBe('CONVERGED');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'all-pass']);
    const projection = loadFlowProjection(join(dir, '.cycles'), 'auto-fix');
    expect(projection?.history.length).toBeGreaterThanOrEqual(4);
  });

  it('终态重入（真机 cycle-11 发现）：CONVERGED 后再跑恒败 → 新一轮 CIRCUIT', () => {
    seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD });
    const green = runAutoFixFlow(dir, {});
    expect(green.state).toBe('CONVERGED');
    // 全绿后立即再跑恒败：CONVERGED→RUNNING→ITERATING→CIRCUIT（不卡死在终态）
    const r = runAutoFixFlow(dir, { maxRetries: 1, testCmd: FAILING_CMD });
    expect(r.state).toBe('CIRCUIT');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'iterating', 'exhausted']);
    expect(r.verdict).toBe('circuit');
  });

  it('INV-13：replayEvents 重建与投影一致（拒绝非法转移）', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const r = runAutoFixFlow(dir, { maxRetries: 2 });
    const projection = loadFlowProjection(join(dir, '.cycles'), 'auto-fix');
    const rebuilt = rebuildAutoFixFlowState(projection?.history ?? []);
    expect(rebuilt.state.current).toBe('CIRCUIT');
    expect(rebuilt.rejected).toEqual([]);
    // 非法转移被拒：终态上触发 reset 后再触发 exhausted（from ≠ 折叠当前态）
    const bad = replayEvents(AUTO_FIX_FLOW, [
      ...projection?.history ?? [],
      { id: 'evt-bad', at: new Date().toISOString(), from: 'IDLE', trigger: 'exhausted', to: 'CIRCUIT' },
    ]);
    expect(bad.state.current).toBe(projection?.current);
    expect(bad.rejected).toHaveLength(1);
  });

  it('前置错误（无 test 命令）→ 不推进状态机 + error 响亮', () => {
    mkdirSync(join(dir, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
    const r = runAutoFixFlow(dir, {});
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('No test command found');
    expect(r.state).toBe('IDLE');
    expect(r.events).toEqual([]);
    expect(loadFlowProjection(join(dir, '.cycles'), 'auto-fix')).toBeNull();
  });
});

describe('script 模式（spawn 技能 auto-fix-loop.mjs）', () => {
  it('全绿 → CONVERGED + attemptsCount 从 stdout 计数', () => {
    seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD });
    const r = runAutoFixFlow(dir, { mode: 'script' });
    expect(r.state).toBe('CONVERGED');
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.attemptsCount).toBe(1);
    expect(r.stdout).toContain('All tests passed');
  }, 60000);

  it('恒败 → CIRCUIT + pattern 提取 + incident 路径（stderr）', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const r = runAutoFixFlow(dir, { mode: 'script', maxRetries: 3 });
    expect(r.state).toBe('CIRCUIT');
    expect(r.exitCode).toBe(2);
    expect(r.pattern).toBe('repeating');
    expect(r.attemptsCount).toBe(3);
    expect(existsSync(r.incidentPath ?? '')).toBe(true);
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
  }, 120000);
});
