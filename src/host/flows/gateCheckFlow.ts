/**
 * gateCheckFlow —— 首个专属流程状态流转机实例（R3 阶段 2）。
 *
 * 状态图：IDLE →(run)→ RUNNING →(all-pass, 守卫:引擎全绿)→ PASSED
 *                              →(any-fail, 守卫:引擎有红)→ FAILED
 *         RUNNING →(run)→ RUNNING   崩溃恢复自环（进程死于 RUNNING 时无需人工 reset）
 *         PASSED/FAILED →(run)→ RUNNING   终态重入（D-1101：下一 cycle 的 gate-check
 *                                        是新的一跑，不是同一跑的恢复——cycle-11 真机
 *                                        发现终态不可重入后统一补齐）
 *         PASSED/FAILED →(reset)→ IDLE   显式复位（语义保留）
 *
 * 三执行模式（引擎侧实现在 gateCheckRunners.ts）：
 *  - script：正典路径（技能脚本是账本正典写入者，行为零变化）
 *  - native：gateEngine 原生判定 + 插件侧账本记录（与脚本同一去重语义）
 *  - diff  ：双跑对账（差分测试的运行时形态；观测专用，不写账本）
 *
 * 守卫纪律（INV-28）：FAILED 的引擎结果永远进不了 PASSED —— 守卫消费引擎裁决
 * 负载，描述子里没有任何「无条件转移」通向终态正极。
 */
import { join } from 'node:path';
import type { FlowDescriptor, FlowEvent, GuardFn } from './contracts.ts';
import { applyTransition, initRuntimeState, replayEvents } from './machine.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';
import { applyReset, loadForReset } from './flowReset.ts';
import type { GateCheckResult } from './gateTypes.ts';
import { runNativeSide, runScriptSide, recordNative, type EngineSide } from './gateCheckRunners.ts';
// 超时 cap 单一事实源（cycle-79 O-03）：原先独立写死 120000，与技能入口 240000 不一致。
// 默认值（120s）保持本流程原语义不变，只把 cap 统一到同一常量。
import { MAX_SKILL_INVOKE_TIMEOUT_MS } from '../runtime/bootstrapBudget.ts';

export type GateCheckState = 'IDLE' | 'RUNNING' | 'PASSED' | 'FAILED';

export const GATE_CHECK_FLOW: FlowDescriptor<GateCheckState> = {
  id: 'gate-check',
  labelKey: 'flows.gateCheck',
  states: ['IDLE', 'RUNNING', 'PASSED', 'FAILED'],
  initial: 'IDLE',
  transitions: [
    { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'PASSED', trigger: 'all-pass', guard: 'gate-verdict-all-pass' },
    { from: 'RUNNING', to: 'FAILED', trigger: 'any-fail', guard: 'gate-verdict-any-fail' },
    { from: 'PASSED', to: 'RUNNING', trigger: 'run' },
    { from: 'FAILED', to: 'RUNNING', trigger: 'run' },
    { from: 'PASSED', to: 'IDLE', trigger: 'reset' },
    { from: 'FAILED', to: 'IDLE', trigger: 'reset' },
  ],
  persistence: { kind: 'projection', path: 'flows/gate-check.json' },
  engine: 'gateEngine',
  scriptFallback: 'gate-check',
};

/** 守卫（引用键，无内联闭包进描述子）。负载 = 引擎裁决 {allPass}。 */
export const GATE_CHECK_GUARDS: Record<string, GuardFn> = {
  'gate-verdict-all-pass': (ctx) => {
    const verdict = ctx.payload as { allPass?: boolean } | undefined;
    if (verdict?.allPass === true) return { ok: true };
    return { ok: false, reason: 'engine verdict is not all-pass (no evidence to close gates)' };
  },
  'gate-verdict-any-fail': (ctx) => {
    const verdict = ctx.payload as { allPass?: boolean } | undefined;
    if (verdict?.allPass === false) return { ok: true };
    return { ok: false, reason: 'engine verdict is all-pass (nothing to fail on)' };
  },
};

/** 注册入口已移至 builtin.ts（R3 阶段 3 起多流程聚合；避免反向依赖）。 */

export type GateFlowMode = 'script' | 'native' | 'diff';

export interface GateFlowRunResult {
  mode: GateFlowMode;
  flowId: 'gate-check';
  state: GateCheckState;
  events: FlowEvent<GateCheckState>[];
  gates: Record<string, GateCheckResult>;
  quality: Record<string, GateCheckResult>;
  allPass: boolean;
  exitCode: number;
  fatal?: string;
  /** diff 模式：两侧判定分叉面（null = 语义全等）。 */
  drift: { gates: string[]; allPass: boolean; exitCode: boolean } | null;
  /** script 模式的脚本 stdout（观测/排障）。 */
  stdout?: string;
  /** native+record 模式实际入账的门（去重后）。 */
  recorded?: string[];
  error?: string;
}

/**
 * 运行 gate-check 流程（状态机 + 引擎 + 投影）。
 * 执行错误（技能脚本目录缺失等）不推进状态机，error 字段响亮返回。
 *
 * ## `reset` 参数（cycle-91）
 *
 * 此前描述子里的两条 `{from: PASSED|FAILED, to: 'IDLE', trigger: 'reset'}`
 * 边**永远不发生**（无任何调用点传 `'reset'`）⇒ 死边 + `IDLE` 不可达。
 * 现由本函数的 `opts.reset` 提供**真实触发器**：先把投影重置回 `IDLE`，
 * 再正常跑一轮。详见 `flowReset.ts` 头注。
 */
export function runGateFlow(
  workspaceRoot: string,
  opts: { gate?: string; quality?: boolean; record?: boolean; mode?: GateFlowMode; timeoutMs?: number; reset?: boolean } = {},
): GateFlowRunResult {
  const mode: GateFlowMode = opts.mode ?? 'script';
  const gate = opts.gate ?? 'all';
  // cap 统一到技能调用上限（cycle-79 O-03）；显式传参优先语义不变，默认 120s 不变
  const timeoutMs = Math.min(opts.timeoutMs ?? 120000, MAX_SKILL_INVOKE_TIMEOUT_MS);
  const cyclesDir = join(workspaceRoot, '.cycles');

  // cycle-91：先重置（若请求），再跑本轮 —— 顺序不可颠倒
  // （先跑后重置会把刚跑出的结果丢掉）。
  const resetEvents: FlowEvent<GateCheckState>[] = [];
  if (opts.reset === true) {
    const loaded = loadForReset(GATE_CHECK_FLOW, cyclesDir);
    const ev = applyReset(GATE_CHECK_FLOW, cyclesDir, loaded);
    if (ev) resetEvents.push(ev);
  }

  const base = {
    mode, flowId: 'gate-check' as const, gates: {}, quality: {}, events: [] as FlowEvent<GateCheckState>[],
    drift: null as GateFlowRunResult['drift'],
  };

  let side: EngineSide | null = null;
  let stdout: string | undefined;
  let recorded: string[] | undefined;
  let drift: GateFlowRunResult['drift'] = null;

  if (mode === 'native' || mode === 'diff') {
    const native = runNativeSide(workspaceRoot, gate, opts.quality);
    side = native;
    if (mode === 'native' && opts.record && native.fatal === undefined) {
      recorded = recordNative(cyclesDir, native.gates);
    }
  }
  if (mode === 'script' || mode === 'diff') {
    // script 模式保持 --record 语义；diff 模式观测专用，永不写账本（防双写）
    const s = runScriptSide(workspaceRoot, gate, opts.quality ?? true, mode === 'script' ? (opts.record ?? false) : false, timeoutMs);
    if ('error' in s) {
      return { ...base, state: 'IDLE', allPass: false, exitCode: 1, error: s.error };
    }
    stdout = s.stdout;
    if (mode === 'diff' && side) {
      const driftGates: string[] = [];
      const keys = new Set([...Object.keys(side.gates), ...Object.keys(s.gates)]);
      for (const g of keys) {
        if ((side.gates[g]?.pass) !== (s.gates[g]?.pass)) driftGates.push(g);
      }
      const allPassDrift = side.allPass !== s.allPass;
      const exitDrift = side.exitCode !== s.exitCode;
      drift = driftGates.length === 0 && !allPassDrift && !exitDrift
        ? null
        : { gates: driftGates, allPass: allPassDrift, exitCode: exitDrift };
    }
    side = s; // diff 的判定面取脚本侧（正典）
  }

  // 三模式都应产出 side；null = 编程错误（响亮拒绝，不静默改判）
  if (!side) {
    return { ...base, state: 'IDLE', allPass: false, exitCode: 1, error: `mode "${mode}" produced no engine result` };
  }
  return finishRun(cyclesDir, mode, side, { drift, stdout, recorded }, resetEvents);
}

/** 状态机推进 + 投影持久化（run → 引擎裁决 → all-pass/any-fail）。 */
function finishRun(
  cyclesDir: string,
  mode: GateFlowMode,
  side: EngineSide,
  extra: { drift: GateFlowRunResult['drift']; stdout?: string; recorded?: string[] },
  resetEvents: FlowEvent<GateCheckState>[] = [],
): GateFlowRunResult {
  const loaded = loadFlowProjection<GateCheckState>(cyclesDir, GATE_CHECK_FLOW.id);
  let state = loaded ?? initRuntimeState(GATE_CHECK_FLOW);
  // cycle-91：reset 事件**前置**到本轮事件序列首位（reset → run → verdict）。
  // 语义：读者看事件序列时，能看到「这一轮是从重置开始的」。
  const events: FlowEvent<GateCheckState>[] = [...resetEvents];

  const runRes = applyTransition(GATE_CHECK_FLOW, GATE_CHECK_GUARDS, state.current, 'run');
  if (runRes.ok && runRes.event && runRes.next) {
    events.push(runRes.event);
    state = { ...state, current: runRes.next, history: [...state.history, runRes.event], updatedAt: runRes.event.at };
  }

  const verdictTrigger = side.allPass ? 'all-pass' : 'any-fail';
  const verdictRes = applyTransition(
    GATE_CHECK_FLOW, GATE_CHECK_GUARDS, state.current, verdictTrigger,
    { payload: { allPass: side.allPass } },
  );
  if (verdictRes.ok && verdictRes.event && verdictRes.next) {
    events.push(verdictRes.event);
    state = { ...state, current: verdictRes.next, history: [...state.history, verdictRes.event], updatedAt: verdictRes.event.at };
  }

  // 投影可丢弃：每次运行后重算并落盘（replay(history) === 在线推进，INV-13）
  saveFlowProjection(cyclesDir, state);

  return {
    mode,
    flowId: 'gate-check',
    state: state.current,
    events,
    gates: side.gates,
    quality: side.quality,
    allPass: side.allPass,
    exitCode: side.exitCode,
    fatal: side.fatal,
    drift: extra.drift,
    stdout: extra.stdout,
    recorded: extra.recorded,
    error: undefined,
  };
}

/** 崩溃恢复 / 测试共用：从事件序列重建运行态（INV-13 replay === online）。 */
export function rebuildGateFlowState(events: FlowEvent<GateCheckState>[]) {
  return replayEvents(GATE_CHECK_FLOW, events);
}
