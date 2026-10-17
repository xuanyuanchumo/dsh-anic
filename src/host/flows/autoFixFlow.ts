/**
 * autoFixFlow —— 自动修复循环流程状态机（R3 阶段 5，第 5 个专属流程）。
 *
 * 状态图：IDLE →(run)→ RUNNING →(all-pass, 守卫:verdict-pass)→ CONVERGED
 *                              →(iterating, 守卫:has-failures)→ ITERATING
 *         ITERATING →(iterating)→ ITERATING   修复未过继续下一轮（自环，轨迹进投影历史）
 *         ITERATING →(all-pass)→ CONVERGED    修复验证通过
 *         RUNNING/ITERATING →(exhausted, 守卫:verdict-circuit)→ CIRCUIT
 *         RUNNING →(run)→ RUNNING   崩溃恢复自环
 *         CIRCUIT →(run)→ RUNNING   重试恢复（人类/AI 修复后重跑，无需手动 reset）
 *         CONVERGED/CIRCUIT →(reset)→ IDLE
 *
 * 两执行模式（无 diff —— 修复循环是写动作（审计行/incident/报告），同目录双跑会
 * 双写；差分以孪生夹具契约 tests/contract/autoFixDifferential.test.ts 完成）：
 *  - script：spawn 技能 auto-fix-loop.mjs（正典路径，exit 0/2 语义；黑盒无逐轮事件）
 *  - native：autoFixEngine.runAutoFixNative + onProgress 逐 attempt 推进状态机——
 *    ITERATING 自环事件实时进投影历史（动态白盒：迭代轨迹可回放）
 *
 * 守卫纪律（INV-28）：重试耗尽永远进 CIRCUIT（exit 2 语义——需要人类介入），
 * 失败模式分析结果与 suggestedNextStep=autonomy-fallback 逐字透传。
 */
import { join } from 'node:path';
import type { FlowDescriptor, FlowEvent, GuardFn } from './contracts.ts';
import { applyTransition, initRuntimeState, replayEvents } from './machine.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';
import { runAutoFixNative, type AutoFixLoopResult } from '../evolution/autoFixEngine.ts';
import type { FailurePattern, FixAttempt } from '../evolution/autoFixAnalyze.ts';
import { resolveSkillScriptsDir, invokeSkillScript } from '../skillInvoker.ts';

export type AutoFixFlowState = 'IDLE' | 'RUNNING' | 'ITERATING' | 'CONVERGED' | 'CIRCUIT';

export const AUTO_FIX_FLOW: FlowDescriptor<AutoFixFlowState> = {
  id: 'auto-fix',
  labelKey: 'flows.autoFix',
  states: ['IDLE', 'RUNNING', 'ITERATING', 'CONVERGED', 'CIRCUIT'],
  initial: 'IDLE',
  transitions: [
    { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'RUNNING', trigger: 'run' },
    { from: 'CIRCUIT', to: 'RUNNING', trigger: 'run' },
    // 终态重入（真机 cycle-11 发现）：CONVERGED 后再次验证 = 新一轮——
    // 恢复边与 CIRCUIT→RUNNING 同语义（人类/AI 修复后重跑，无需手动 reset）
    { from: 'CONVERGED', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'CONVERGED', trigger: 'all-pass', guard: 'verdict-pass' },
    { from: 'RUNNING', to: 'ITERATING', trigger: 'iterating', guard: 'has-failures' },
    { from: 'ITERATING', to: 'ITERATING', trigger: 'iterating', guard: 'has-failures' },
    { from: 'ITERATING', to: 'CONVERGED', trigger: 'all-pass', guard: 'verdict-pass' },
    { from: 'RUNNING', to: 'CIRCUIT', trigger: 'exhausted', guard: 'verdict-circuit' },
    { from: 'ITERATING', to: 'CIRCUIT', trigger: 'exhausted', guard: 'verdict-circuit' },
    { from: 'CONVERGED', to: 'IDLE', trigger: 'reset' },
    { from: 'CIRCUIT', to: 'IDLE', trigger: 'reset' },
  ],
  persistence: { kind: 'projection', path: 'flows/auto-fix.json' },
  engine: 'autoFixEngine',
  scriptFallback: 'auto-fix-loop',
};

export const AUTO_FIX_GUARDS: Record<string, GuardFn> = {
  'verdict-pass': (ctx) => {
    const v = (ctx.payload as { verdict?: string } | undefined)?.verdict;
    if (v === 'pass') return { ok: true };
    return { ok: false, reason: `verdict is ${v ?? 'unknown'}, not pass` };
  },
  'has-failures': (ctx) => {
    const failures = (ctx.payload as { failures?: number } | undefined)?.failures;
    if (typeof failures === 'number' && failures > 0) return { ok: true };
    return { ok: false, reason: `failures is ${failures ?? 'unknown'}, expected > 0` };
  },
  'verdict-circuit': (ctx) => {
    const v = (ctx.payload as { verdict?: string } | undefined)?.verdict;
    if (v === 'circuit') return { ok: true };
    return { ok: false, reason: `verdict is ${v ?? 'unknown'}, not circuit` };
  },
};

export type AutoFixFlowMode = 'script' | 'native';

/** script/native 统一视图。script 侧 attempts 为 stdout 计数（黑盒无结构化逐轮）。 */
export interface AutoFixFlowRunResult {
  mode: AutoFixFlowMode;
  flowId: 'auto-fix';
  state: AutoFixFlowState;
  events: FlowEvent<AutoFixFlowState>[];
  verdict: 'pass' | 'circuit';
  exitCode: 0 | 1 | 2;
  testCmd: string;
  maxRetries: number;
  attempts: FixAttempt[];
  attemptsCount: number;
  pattern: FailurePattern | null;
  incidentPath: string | null;
  reportPath: string | null;
  suggestedNextStep: 'autonomy-fallback' | null;
  stdout?: string;
  error?: string;
}

/** 解析脚本 stdout：尝试计数/模式/报告路径；incident 在 stderr。 */
function parseAutoFixStdout(stdout: string, stderr: string): {
  attemptsCount: number; pattern: FailurePattern | null; incidentPath: string | null; reportPath: string | null;
} {
  let attemptsCount = 0;
  let pattern: FailurePattern | null = null;
  let reportPath: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    let m = line.match(/^--- Attempt \d+/);
    if (m) { attemptsCount++; continue; }
    m = line.match(/^Failure pattern: (repeating|cascading|transient)$/);
    if (m) { pattern = m[1] as FailurePattern; continue; }
    m = line.match(/^Fix report: (.+)$/);
    if (m) { reportPath = m[1] ?? null; continue; }
  }
  const im = stderr.match(/Incident recorded: (.+)/);
  return { attemptsCount, pattern, incidentPath: im ? (im[1] ?? null) : null, reportPath };
}

/** script 正典路径：spawn auto-fix-loop.mjs。技能目录缺失 → error 响亮返回。 */
function runAutoFixScript(
  ws: string,
  opts: { maxRetries?: number; testCmd?: string },
  timeoutMs: number,
): { exitCode: number; stdout: string; stderr: string } | { error: string } {
  const scriptsDir = resolveSkillScriptsDir(ws);
  if (!scriptsDir) return { error: 'skill scripts not found' };
  const args: string[] = [];
  if (opts.maxRetries !== undefined) args.push('--max-retries', String(opts.maxRetries));
  if (opts.testCmd) args.push('--test-cmd', opts.testCmd);
  const r = invokeSkillScript(scriptsDir, 'auto-fix-loop', args, ws, timeoutMs);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * 运行自动修复循环流程。前置错误（无 test 命令/无 cycle/技能目录缺失）不推进
 * 状态机，error 响亮返回。状态机映射：pass→CONVERGED / circuit→CIRCUIT
 * （exit 2 语义：需要人类介入）+ 逐 attempt 的 ITERATING 轨迹事件。
 */
export function runAutoFixFlow(
  workspaceRoot: string,
  opts: { mode?: AutoFixFlowMode; maxRetries?: number; testCmd?: string; timeoutMs?: number } = {},
): AutoFixFlowRunResult {
  const mode: AutoFixFlowMode = opts.mode ?? 'native';
  // 脚本内每条测试命令 120s × 每轮两跑 × 缺省 3 轮 —— spawn 超时须覆盖全循环
  const timeoutMs = Math.min(opts.timeoutMs ?? 600000, 900000);
  const cyclesDir = join(workspaceRoot, '.cycles');

  const loaded = loadFlowProjection<AutoFixFlowState>(cyclesDir, AUTO_FIX_FLOW.id);
  let state = loaded ?? initRuntimeState(AUTO_FIX_FLOW);
  const events: FlowEvent<AutoFixFlowState>[] = [];

  /** 状态机推进助手（守卫拒绝时如实记录 reason 进事件备注——诚实纪律）。 */
  function step(trigger: string, payload?: Record<string, unknown>): void {
    const res = applyTransition(AUTO_FIX_FLOW, AUTO_FIX_GUARDS, state.current, trigger, payload ? { payload } : undefined);
    if (res.ok && res.event && res.next) {
      events.push(res.event);
      state = { ...state, current: res.next, history: [...state.history, res.event], updatedAt: res.event.at };
    }
  }

  let loop: AutoFixLoopResult;
  let stdout: string | undefined;
  let attemptsCount: number;
  let pattern: FailurePattern | null;
  // 逐轮进度先缓存后回放：状态机的 run 边在引擎调用后统一推进（前置错误不推进
  // 任何事件），回放顺序与真实执行顺序一致（run → iterating×N → 终态）
  const progressTrail: Array<{ attempt: number; failures: number }> = [];
  if (mode === 'script') {
    const s = runAutoFixScript(workspaceRoot, opts, timeoutMs);
    if ('error' in s) {
      return {
        mode, flowId: 'auto-fix', state: state.current, events: [], verdict: 'pass', exitCode: 1,
        testCmd: opts.testCmd ?? '', maxRetries: opts.maxRetries ?? 3, attempts: [], attemptsCount: 0,
        pattern: null, incidentPath: null, reportPath: null, suggestedNextStep: null, error: s.error,
      };
    }
    stdout = s.stdout;
    const parsed = parseAutoFixStdout(s.stdout, s.stderr);
    attemptsCount = parsed.attemptsCount;
    pattern = parsed.pattern;
    loop = {
      verdict: s.exitCode === 0 ? 'pass' : 'circuit',
      exitCode: s.exitCode === 2 ? 2 : s.exitCode === 0 ? 0 : 1,
      testCmd: opts.testCmd ?? '(from workspace config)',
      maxRetries: opts.maxRetries ?? 3,
      attempts: [],
      analysis: parsed.pattern ? { pattern: parsed.pattern, rootCauseHypothesis: '', recommendedAction: '', failureTypes: {} } : null,
      incidentPath: parsed.incidentPath,
      reportPath: parsed.reportPath,
      suggestedNextStep: s.exitCode === 2 ? 'autonomy-fallback' : null,
      warnings: [],
    };
    if (loop.exitCode === 1 && !loop.error) loop = { ...loop, error: 'script precondition failed (exit 1)' };
  } else {
    loop = runAutoFixNative(workspaceRoot, {
      maxRetries: opts.maxRetries,
      testCmd: opts.testCmd,
      onProgress: (p) => {
        // 识别到失败即记录 ITERATING 轨迹点（无论 retest 结果——迭代过程可回放）
        if (p.failures > 0) progressTrail.push({ attempt: p.attempt, failures: p.failures });
      },
    });
    attemptsCount = loop.attempts.length;
    pattern = loop.analysis?.pattern ?? null;
  }

  // 前置错误（exit 1）：不推进状态机，error 响亮返回
  if (loop.exitCode === 1 && loop.error) {
    return {
      mode, flowId: 'auto-fix', state: state.current, events, verdict: 'pass', exitCode: 1,
      testCmd: loop.testCmd, maxRetries: loop.maxRetries, attempts: loop.attempts, attemptsCount,
      pattern, incidentPath: loop.incidentPath, reportPath: loop.reportPath,
      suggestedNextStep: null, error: loop.error, stdout,
    };
  }

  step('run');
  for (const p of progressTrail) {
    step('iterating', { attempt: p.attempt, failures: p.failures });
  }
  if (loop.verdict === 'pass') {
    step('all-pass', { verdict: 'pass' });
  } else {
    step('exhausted', { verdict: 'circuit' });
  }
  saveFlowProjection(cyclesDir, state);

  return {
    mode, flowId: 'auto-fix', state: state.current, events,
    verdict: loop.verdict, exitCode: loop.exitCode,
    testCmd: loop.testCmd, maxRetries: loop.maxRetries,
    attempts: loop.attempts, attemptsCount, pattern,
    incidentPath: loop.incidentPath, reportPath: loop.reportPath,
    suggestedNextStep: loop.suggestedNextStep, stdout,
    error: loop.verdict === 'pass' ? undefined : `Auto-fix loop ${loop.verdict}`,
  };
}

/** 崩溃恢复 / 测试共用：从事件序列重建运行态（INV-13）。 */
export function rebuildAutoFixFlowState(events: FlowEvent<AutoFixFlowState>[]) {
  return replayEvents(AUTO_FIX_FLOW, events);
}
