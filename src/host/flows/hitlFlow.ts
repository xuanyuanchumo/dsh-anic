/**
 * hitlFlow —— HITL 三段修复流程状态机（R3 阶段 4 后半，第 4 个专属流程）。
 *
 * 状态图：IDLE →(run)→ RUNNING →(all-pass, 守卫:verdict-all-pass)→ PASSED
 *                              →(any-fail, 守卫:verdict-any-fail)→ FAILED
 *                              →(circuit,  守卫:verdict-circuit)→ BLOCKED
 *         RUNNING →(run)→ RUNNING   崩溃恢复自环
 *         BLOCKED →(run)→ RUNNING   重试恢复（人类修复后重跑，无需手动 reset）
 *         PASSED/FAILED →(run)→ RUNNING   终态重入（D-1101：上一轮审计完结后，
 *                                      新一轮 HITL 审计是新的一跑——cycle-11 真机
 *                                      发现终态不可重入后统一补齐；BLOCKED 重试边
 *                                      语义不变）
 *         PASSED/FAILED/BLOCKED →(reset)→ IDLE
 *
 * 两执行模式（无 diff —— 三段修复是写动作（审计行/gitignore/incident），
 * 同目录双跑会双写；差分以孪生夹具契约 tests/contract/hitlDifferential.test.ts 完成）：
 *  - script：spawn 技能 hitl-audit.mjs（正典路径，exit 0/1/2 语义）
 *  - native：hitlThreePhase.ts（Phase0 审计→Phase1 修复→Phase2 重审）
 *
 * 守卫纪律（INV-28）：circuit 判定永远进 BLOCKED（exit 2 语义——需要人类介入），
 * 失败原因与 suggestedNextStep=autonomy-fallback 逐字透传。
 */
import { join } from 'node:path';
import type { FlowDescriptor, FlowEvent, GuardFn } from './contracts.ts';
import { applyTransition, initRuntimeState, replayEvents } from './machine.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';
import { applyReset, loadForReset } from './flowReset.ts';
import { runHitlThreePhaseNative, type HitlGateId, type HitlThreePhaseResult, type HitlVerdict } from '../governance/hitlThreePhase.ts';
import { resolveSkillScriptsDir, invokeSkillScript } from '../skillInvoker.ts';
// 超时 cap 单一事实源（cycle-79 O-03）：原先独立写死 120000，与技能入口 240000 不一致。
// 默认值（60s）保持本流程原语义不变，只把 cap 统一到同一常量。
import { MAX_SKILL_INVOKE_TIMEOUT_MS } from '../runtime/bootstrapBudget.ts';

export type HitlFlowState = 'IDLE' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED';

export const HITL_FLOW: FlowDescriptor<HitlFlowState> = {
  id: 'hitl',
  labelKey: 'flows.hitl',
  states: ['IDLE', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED'],
  initial: 'IDLE',
  transitions: [
    { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'RUNNING', trigger: 'run' },
    { from: 'BLOCKED', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'PASSED', trigger: 'all-pass', guard: 'verdict-all-pass' },
    { from: 'RUNNING', to: 'FAILED', trigger: 'any-fail', guard: 'verdict-any-fail' },
    { from: 'RUNNING', to: 'BLOCKED', trigger: 'circuit', guard: 'verdict-circuit' },
    { from: 'PASSED', to: 'RUNNING', trigger: 'run' },
    { from: 'FAILED', to: 'RUNNING', trigger: 'run' },
    { from: 'PASSED', to: 'IDLE', trigger: 'reset' },
    { from: 'FAILED', to: 'IDLE', trigger: 'reset' },
    { from: 'BLOCKED', to: 'IDLE', trigger: 'reset' },
  ],
  persistence: { kind: 'projection', path: 'flows/hitl.json' },
  engine: 'hitlEngine',
  scriptFallback: 'hitl-audit',
};

export const HITL_GUARDS: Record<string, GuardFn> = {
  'verdict-all-pass': (ctx) => {
    const v = (ctx.payload as { verdict?: string } | undefined)?.verdict;
    if (v === 'pass') return { ok: true };
    return { ok: false, reason: `verdict is ${v ?? 'unknown'}, not pass` };
  },
  'verdict-any-fail': (ctx) => {
    const v = (ctx.payload as { verdict?: string } | undefined)?.verdict;
    if (v === 'fail') return { ok: true };
    return { ok: false, reason: `verdict is ${v ?? 'unknown'}, not fail` };
  },
  'verdict-circuit': (ctx) => {
    const v = (ctx.payload as { verdict?: string } | undefined)?.verdict;
    if (v === 'circuit') return { ok: true };
    return { ok: false, reason: `verdict is ${v ?? 'unknown'}, not circuit` };
  },
};

export type HitlFlowMode = 'script' | 'native';
export type HitlGateArg = 'all' | HitlGateId;

/** script/native 统一视图：脚本侧 incidents 不回传路径（技能不打印），以 gate 计数对齐。 */
export interface HitlFlowRunResult {
  mode: HitlFlowMode;
  flowId: 'hitl';
  state: HitlFlowState;
  events: FlowEvent<HitlFlowState>[];
  verdict: HitlVerdict;
  exitCode: 0 | 1 | 2;
  checks: HitlThreePhaseResult['checks'];
  circuits: HitlGateId[];
  fixes: HitlThreePhaseResult['fixes'];
  rechecks: HitlThreePhaseResult['rechecks'];
  incidents: HitlThreePhaseResult['incidents'];
  auditLogPath: string | null;
  suggestedNextStep: 'autonomy-fallback' | null;
  stdout?: string;
  error?: string;
}

/** 解析脚本 stdout：初始门（未缩进 [PASS|FAIL]）/熔断标记/修复结局/重审（缩进）。 */
function parseHitlStdout(stdout: string): Pick<HitlThreePhaseResult, 'checks' | 'fixes' | 'rechecks'> & { circuits: HitlGateId[] } {
  const checks: HitlThreePhaseResult['checks'] = [];
  const rechecks: HitlThreePhaseResult['rechecks'] = [];
  const fixes: HitlThreePhaseResult['fixes'] = [];
  const circuits: HitlGateId[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    let m = line.match(/^\[(PASS|FAIL)\] (H[1-4]): (.*)$/);
    if (m) {
      checks.push({ gate: m[2] as HitlGateId, pass: m[1] === 'PASS', circuit: false, detail: m[3] ?? '' });
      continue;
    }
    m = line.match(/^  \[(PASS|FAIL)\] (H[1-4]): (.*)$/);
    if (m) {
      rechecks.push({ gate: m[2] as HitlGateId, pass: m[1] === 'PASS', circuit: m[1] !== 'PASS', detail: m[3] ?? '' });
      continue;
    }
    m = line.match(/^  \[(FIXED|FIX FAILED)\] (H[1-4]): (.*)$/);
    if (m) {
      fixes.push({ gate: m[2] as HitlGateId, success: m[1] === 'FIXED', action: m[1] === 'FIXED' ? m[3] : undefined, reason: m[1] === 'FIXED' ? undefined : m[3] });
      continue;
    }
    m = line.match(/^  \[CIRCUIT BREAKER\] (H[1-4]) triggered/);
    if (m) {
      const g = m[1] as HitlGateId;
      const c = checks.find((x) => x.gate === g);
      if (c) c.circuit = true;
      if (!circuits.includes(g)) circuits.push(g);
    }
  }
  return { checks, fixes, rechecks, circuits };
}

/** script 正典路径：spawn hitl-audit.mjs。技能目录缺失 → error 响亮返回。 */
function runHitlScript(
  ws: string,
  gate: HitlGateArg,
  timeoutMs: number,
): { exitCode: number; stdout: string; stderr: string } | { error: string } {
  const scriptsDir = resolveSkillScriptsDir(ws);
  if (!scriptsDir) return { error: 'skill scripts not found' };
  const args = gate === 'all' ? [] : ['--gate', gate];
  const r = invokeSkillScript(scriptsDir, 'hitl-audit', args, ws, timeoutMs);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * 运行 HITL 三段修复流程。执行错误（技能目录缺失等）不推进状态机，error 响亮返回。
 * 状态机映射：pass→PASSED / fail→FAILED / circuit→BLOCKED（exit 2 语义：需要人类介入）。
 */
export function runHitlFlow(
  workspaceRoot: string,
  opts: { gate?: HitlGateArg; mode?: HitlFlowMode; timeoutMs?: number; reset?: boolean } = {},
): HitlFlowRunResult {
  const mode: HitlFlowMode = opts.mode ?? 'native';
  const gate: HitlGateArg = opts.gate ?? 'all';
  // cap 统一到技能调用上限（cycle-79 O-03）；显式传参优先语义不变，默认 60s 不变
  const timeoutMs = Math.min(opts.timeoutMs ?? 60000, MAX_SKILL_INVOKE_TIMEOUT_MS);
  const cyclesDir = join(workspaceRoot, '.cycles');

  // cycle-91：先重置（若请求），再跑本轮 —— 顺序不可颠倒。
  if (opts.reset === true) {
    const loaded = loadForReset(HITL_FLOW, cyclesDir);
    applyReset(HITL_FLOW, cyclesDir, loaded);
  }

  let three: HitlThreePhaseResult;
  let stdout: string | undefined;
  if (mode === 'script') {
    const s = runHitlScript(workspaceRoot, gate, timeoutMs);
    if ('error' in s) {
      return {
        mode, flowId: 'hitl', state: 'IDLE', events: [], verdict: 'fail', exitCode: 1,
        checks: [], circuits: [], fixes: [], rechecks: [], incidents: [],
        auditLogPath: null, suggestedNextStep: null, error: s.error,
      };
    }
    stdout = s.stdout;
    const parsed = parseHitlStdout(s.stdout);
    const verdict: HitlVerdict = s.exitCode === 0 ? 'pass' : s.exitCode === 2 ? 'circuit' : 'fail';
    three = {
      verdict,
      exitCode: s.exitCode === 0 ? 0 : s.exitCode === 2 ? 2 : 1,
      checks: parsed.checks,
      circuits: parsed.circuits,
      fixes: parsed.fixes,
      rechecks: parsed.rechecks,
      incidents: [], // 技能不打印 incident 路径；差分契约以文件存在性对齐
      auditLogPath: null,
      suggestedNextStep: verdict === 'circuit' ? 'autonomy-fallback' : null,
    };
  } else {
    three = runHitlThreePhaseNative(workspaceRoot, gate);
  }

  // 状态机推进：run → all-pass/any-fail/circuit（守卫消费三段判定）
  const loaded = loadFlowProjection<HitlFlowState>(cyclesDir, HITL_FLOW.id);
  let state = loaded ?? initRuntimeState(HITL_FLOW);
  const events: FlowEvent<HitlFlowState>[] = [];

  const runRes = applyTransition(HITL_FLOW, HITL_GUARDS, state.current, 'run');
  if (runRes.ok && runRes.event && runRes.next) {
    events.push(runRes.event);
    state = { ...state, current: runRes.next, history: [...state.history, runRes.event], updatedAt: runRes.event.at };
  }
  const trigger = three.verdict === 'pass' ? 'all-pass' : three.verdict === 'fail' ? 'any-fail' : 'circuit';
  const verdictRes = applyTransition(HITL_FLOW, HITL_GUARDS, state.current, trigger, { payload: { verdict: three.verdict } });
  if (verdictRes.ok && verdictRes.event && verdictRes.next) {
    events.push(verdictRes.event);
    state = { ...state, current: verdictRes.next, history: [...state.history, verdictRes.event], updatedAt: verdictRes.event.at };
  }
  saveFlowProjection(cyclesDir, state);

  return {
    mode, flowId: 'hitl', state: state.current, events,
    verdict: three.verdict, exitCode: three.exitCode,
    checks: three.checks, circuits: three.circuits, fixes: three.fixes,
    rechecks: three.rechecks, incidents: three.incidents, auditLogPath: three.auditLogPath,
    suggestedNextStep: three.suggestedNextStep, stdout,
    error: three.verdict === 'pass' ? undefined : `HITL verdict: ${three.verdict}`,
  };
}

/** 崩溃恢复 / 测试共用：从事件序列重建运行态（INV-13）。 */
export function rebuildHitlFlowState(events: FlowEvent<HitlFlowState>[]) {
  return replayEvents(HITL_FLOW, events);
}
