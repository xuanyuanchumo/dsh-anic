/**
 * hitlFlow 单元测试 —— 第 4 个流程状态机（R3 阶段 4 后半）。
 *
 * 状态图：IDLE→RUNNING→PASSED/FAILED/BLOCKED；BLOCKED→RUNNING 重试恢复
 * （人类修复后重跑，无需 reset）。守卫消费三段判定（pass/fail/circuit）。
 * script 模式经 parseHitlStdout 解析技能 stdout（格式基准 = 技能
 * hitl-audit.mjs:313-360 的 console 输出形状）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HITL_FLOW, HITL_GUARDS, runHitlFlow, rebuildHitlFlowState, type HitlFlowState } from '../../src/host/flows/hitlFlow.ts';
import type { FlowEvent } from '../../src/host/flows/contracts.ts';
import { seedGitRepo, seedCycle, seedGreenLedger } from '../helpers/hitlWorkspace.ts';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-hitlflow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('HITL_FLOW 描述子', () => {
  it('状态/转移/持久化/引擎齐全', () => {
    expect(HITL_FLOW.id).toBe('hitl');
    expect(HITL_FLOW.labelKey).toBe('flows.hitl');
    expect(HITL_FLOW.states).toEqual(['IDLE', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED']);
    expect(HITL_FLOW.initial).toBe('IDLE');
    expect(HITL_FLOW.persistence).toEqual({ kind: 'projection', path: 'flows/hitl.json' });
    expect(HITL_FLOW.engine).toBe('hitlEngine');
    expect(HITL_FLOW.scriptFallback).toBe('hitl-audit');
  });

  it('五条终态转移 + BLOCKED→RUNNING 重试恢复边', () => {
    const triggers = HITL_FLOW.transitions.map((t) => `${t.from}--${t.trigger}-->${t.to}`);
    expect(triggers).toContain('RUNNING--all-pass-->PASSED');
    expect(triggers).toContain('RUNNING--any-fail-->FAILED');
    expect(triggers).toContain('RUNNING--circuit-->BLOCKED');
    expect(triggers).toContain('BLOCKED--run-->RUNNING');
    expect(triggers).toContain('PASSED--reset-->IDLE');
    expect(triggers).toContain('BLOCKED--reset-->IDLE');
  });
});

describe('HITL_GUARDS 守卫', () => {
  it('verdict-all-pass 只放行 pass', () => {
    expect(HITL_GUARDS['verdict-all-pass']!({ payload: { verdict: 'pass' } })).toEqual({ ok: true });
    expect(HITL_GUARDS['verdict-all-pass']!({ payload: { verdict: 'circuit' } }).ok).toBe(false);
    expect(HITL_GUARDS['verdict-all-pass']!({}).ok).toBe(false);
  });

  it('verdict-any-fail 只放行 fail；verdict-circuit 只放行 circuit', () => {
    expect(HITL_GUARDS['verdict-any-fail']!({ payload: { verdict: 'fail' } }).ok).toBe(true);
    expect(HITL_GUARDS['verdict-any-fail']!({ payload: { verdict: 'pass' } }).ok).toBe(false);
    expect(HITL_GUARDS['verdict-circuit']!({ payload: { verdict: 'circuit' } }).ok).toBe(true);
    expect(HITL_GUARDS['verdict-circuit']!({ payload: { verdict: 'fail' } }).ok).toBe(false);
  });
});

describe('runHitlFlow（native）', () => {
  it('全绿：IDLE→RUNNING→PASSED + 投影落盘 + 事件两条', () => {
    seedGitRepo(dir);
    seedCycle(dir, true);
    seedGreenLedger(dir);
    const r = runHitlFlow(dir, { mode: 'native' });
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.state).toBe('PASSED');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'all-pass']);
    expect(existsSync(join(dir, '.cycles', 'flows', 'hitl.json'))).toBe(true);
  });

  it('H3 熔断不可修复：RUNNING→BLOCKED + suggestedNextStep', () => {
    seedCycle(dir, false);
    const r = runHitlFlow(dir, { mode: 'native', gate: 'H3' });
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.state).toBe('BLOCKED');
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
    expect(r.error).toBe('HITL verdict: circuit');
  });

  it('BLOCKED→RUNNING→PASSED 重试恢复（人类补账本后无需 reset）', () => {
    seedCycle(dir, false);
    const first = runHitlFlow(dir, { mode: 'native', gate: 'H3' });
    expect(first.state).toBe('BLOCKED');
    // 人类介入：补齐账本与审计日志
    seedGreenLedger(dir);
    writeFileSync(join(dir, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), '# 审计日志\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n');
    const second = runHitlFlow(dir, { mode: 'native', gate: 'H3' });
    expect(second.state).toBe('PASSED');
    expect(second.verdict).toBe('pass');
    expect(second.events.map((e) => e.trigger)).toEqual(['run', 'all-pass']);
    // 投影历史累计：两次运行 4 条事件
    const projection = JSON.parse(readFileSync(join(dir, '.cycles', 'flows', 'hitl.json'), 'utf-8')) as { history: FlowEvent<HitlFlowState>[] };
    expect(projection.history).toHaveLength(4);
    expect(projection.current).toBe('PASSED');
  });

  it('崩溃恢复：事件序列重建运行态（INV-13 replay）', () => {
    seedCycle(dir, false);
    const r = runHitlFlow(dir, { mode: 'native', gate: 'H3' });
    const rebuilt = rebuildHitlFlowState(r.events);
    expect(rebuilt.rejected).toEqual([]);
    expect(rebuilt.state.current).toBe('BLOCKED');
    expect(rebuilt.state.history).toHaveLength(2);
  });
});

describe('parseHitlStdout（script 模式解析）', () => {
  it('完整三段输出：初始门/熔断标记/修复/重审全部解析', () => {
    seedGitRepo(dir);
    writeFileSync(join(dir, '.env'), 'X=1');
    const r = runHitlFlow(dir, { mode: 'script', gate: 'H1' });
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.state).toBe('PASSED');
    expect(r.checks[0]?.gate).toBe('H1');
    expect(r.checks[0]?.circuit).toBe(true); // 初始熔断由 [CIRCUIT BREAKER] 行标记
    expect(r.fixes[0]?.success).toBe(true);
    expect(r.fixes[0]?.action).toContain('.gitignore');
    expect(r.rechecks[0]?.pass).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('.env.*');
  });

  it('script 模式熔断不可修复：exit 2 → verdict circuit → BLOCKED', () => {
    seedCycle(dir, false);
    const r = runHitlFlow(dir, { mode: 'script', gate: 'H3' });
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.state).toBe('BLOCKED');
    expect(r.fixes[0]?.success).toBe(false);
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
  });
});
