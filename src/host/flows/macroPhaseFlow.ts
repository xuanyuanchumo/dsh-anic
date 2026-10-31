/**
 * macroPhaseFlow —— 宏观六相流程状态机（R3 阶段 3 第二个 FlowRegistry 实例）。
 *
 * 状态图（单向线性，无回退边 —— 「禁回退」由图的形状承载，不是运行时检查）：
 *   plan → design → build → test → deploy → maintain
 *   显式跳相（--node/场景 target）= `jump:from:to` 边（非邻接对）；邻接对用 'advance'。
 *   D-1101 决议：**不加**终态重入边 —— maintain 是末相，技能侧 workflow-state.mjs:202
 *   对末相 advance 报 "Already at final phase. No more phases to advance."，无 reset
 *   语义；重入边会偏离正典（task 型流程 gate-check/archive/hitl/auto-fix 才有重入）。
 *
 * 守卫 phase-gates-passed：当前相的门禁**曾**在账本 PASS（技能 cmdAdvance:209-216
 * 同一语义）。payload 由运行器装配 {currentPhase, gatesPassed}。
 *
 * 双执行模式：
 *  - script：正典（技能 workflow-state.mjs advance 写 `.cycles/workflow-state.json`）
 *  - native：macroPhaseEngine + FlowMachine（同一 PHASES 表，同一消息文案）
 * 无 diff 模式：advance 是**写动作**，双跑会双推进 —— 差分在契约测试里以
 * 「孪生夹具 + 逐字段比对两侧落盘状态」完成（macroPhaseDifferential.test.ts）。
 */
import { join } from 'node:path';
import type { FlowDescriptor, FlowEvent, FlowTransition, GuardFn } from './contracts.ts';
import { applyTransition, initRuntimeState, replayEvents } from './machine.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';
import {
  PHASES, PHASE_IDS, loadMacroState, readGateResults, advanceMacro,
} from './macroPhaseEngine.ts';
import { resolveSkillScriptsDir, invokeSkillScript } from '../skillInvoker.ts';
// 超时 cap 单一事实源（cycle-79 O-03）：原先独立写死 120000，与技能入口 240000 不一致。
// 默认值（120s）保持本流程原语义不变，只把 cap 统一到同一常量。
import { MAX_SKILL_INVOKE_TIMEOUT_MS } from '../runtime/bootstrapBudget.ts';

export type MacroPhaseState = 'plan' | 'design' | 'build' | 'test' | 'deploy' | 'maintain';

/** 15 条前向边：邻接对 trigger='advance'，非邻接对 `jump:from:to`。 */
function buildTransitions(): FlowTransition<MacroPhaseState>[] {
  const out: FlowTransition<MacroPhaseState>[] = [];
  for (let i = 0; i < PHASES.length; i++) {
    for (let j = i + 1; j < PHASES.length; j++) {
      const from = PHASES[i]!.id as MacroPhaseState;
      const to = PHASES[j]!.id as MacroPhaseState;
      out.push(j === i + 1
        ? { from, to, trigger: 'advance', guard: 'phase-gates-passed' }
        : { from, to, trigger: `jump:${from}:${to}`, guard: 'phase-gates-passed' });
    }
  }
  return out;
}

export const MACRO_PHASE_FLOW: FlowDescriptor<MacroPhaseState> = {
  id: 'macro-phase',
  labelKey: 'flows.macroPhase',
  states: PHASE_IDS as MacroPhaseState[],
  initial: 'plan',
  transitions: buildTransitions(),
  persistence: { kind: 'projection', path: 'flows/macro-phase.json' },
  engine: 'macroPhaseEngine',
  scriptFallback: 'workflow-state',
};

/** 守卫（引用键）：当前相门禁曾全绿。负载 {currentPhase, gatesPassed}。 */
export const MACRO_PHASE_GUARDS: Record<string, GuardFn> = {
  'phase-gates-passed': (ctx) => {
    const p = ctx.payload as { currentPhase?: string; gatesPassed?: string[] } | undefined;
    const phase = PHASES.find((x) => x.id === p?.currentPhase);
    if (!phase) return { ok: false, reason: `unknown current phase "${String(p?.currentPhase)}"` };
    const passed = new Set(p?.gatesPassed ?? []);
    const missing = phase.gates.filter((g) => !passed.has(g));
    if (missing.length > 0) {
      return { ok: false, reason: `Cannot advance: gate ${missing[0]} for phase ${phase.name} has not passed.` };
    }
    return { ok: true };
  },
};

/**
 * ## cycle-95 删除 `registerMacroPhaseFlow()`（为什么删）
 *
 * 它是「注册 macro-phase 流程」的**第二份入口**，而注册的唯一权威聚合点是
 * `flows/builtin.ts` 的 `registerBuiltinFlows()` —— 那里与 `GATE_CHECK_FLOW` /
 * `ARCHIVE_FLOW` / `HITL_FLOW` / `AUTO_FIX_FLOW` **一起**注册，并统一返回
 * 聚合 disposer（反向顺序释放）。全仓去注释后 `registerMacroPhaseFlow` 零消费。
 *
 * ⇒ 单独注册一个流程会**绕过聚合 disposer**：拿不到其余四个的释放函数，
 * 卸载期留下悬挂注册器（`registry.ts` 的 disposer 语义是一次性、按序）。
 * 一个流程的注册入口只能有一个，否则「注册了哪些」就没有单一事实源。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 */

export type MacroFlowMode = 'script' | 'native';

export interface MacroFlowRunResult {
  mode: MacroFlowMode;
  flowId: 'macro-phase';
  ok: boolean;
  /** 推进后相位（final 语义下保持末相）。 */
  state: MacroPhaseState | null;
  from?: string;
  to?: string;
  message: string;
  nextGates?: string[];
  final?: boolean;
  dryRun?: boolean;
  events: FlowEvent<MacroPhaseState>[];
  gatesPassed: string[];
  stdout?: string;
  /** script 推进成功但机器守卫拒绝（两侧语义分叉 —— 双真相源守卫的运行时形态）。 */
  drift?: boolean;
  error?: string;
}

/** 计算本次转移的 trigger（邻接 → 'advance'；跳相 → 'jump:from:to'）。 */
function triggerOf(from: string, to: string): string {
  const i = PHASE_IDS.indexOf(from);
  const j = PHASE_IDS.indexOf(to);
  return j === i + 1 ? 'advance' : `jump:${from}:${to}`;
}

/** script 侧结果（显式联合类型：TS 对对象字面量联合会自动补 `error?: undefined`，破坏 `in` 收窄）。 */
type MacroScriptSide = { error: string } | { result: ReturnType<typeof invokeSkillScript> };

/** script 正典路径：spawn 技能脚本（advance 是唯一写者）。 */
function runScriptSide(ws: string, target: string | undefined, timeoutMs: number): MacroScriptSide {
  const scriptsDir = resolveSkillScriptsDir(ws);
  if (!scriptsDir) return { error: 'skill scripts not found' };
  const args = ['advance', ...(target ? ['--node', target] : [])];
  return { result: invokeSkillScript(scriptsDir, 'workflow-state', args, ws, timeoutMs) };
}

/**
 * 运行宏观相位推进（状态机 + 引擎 + 投影）。
 * dryRun：只算不写（native 走机器 canQuery + 引擎 dryRun；script 不支持 dryRun）。
 */
export function runMacroPhaseFlow(
  workspaceRoot: string,
  opts: { target?: string; mode?: MacroFlowMode; dryRun?: boolean; timeoutMs?: number } = {},
): MacroFlowRunResult {
  const mode: MacroFlowMode = opts.mode ?? 'script';
  // cap 统一到技能调用上限（cycle-79 O-03）；显式传参优先语义不变，默认 120s 不变
  const timeoutMs = Math.min(opts.timeoutMs ?? 120000, MAX_SKILL_INVOKE_TIMEOUT_MS);
  const cyclesDir = join(workspaceRoot, '.cycles');
  const before = loadMacroState(workspaceRoot)?.currentPhase ?? 'plan';
  const gatesPassed = readGateResults(workspaceRoot).passed;

  const base = {
    mode, flowId: 'macro-phase' as const, events: [] as FlowEvent<MacroPhaseState>[], gatesPassed,
  };

  if (mode === 'native') {
    const outcome = advanceMacro(workspaceRoot, opts.target, { dryRun: opts.dryRun === true });
    if (!outcome.ok) {
      return { ...base, ok: false, state: before as MacroPhaseState, message: outcome.message, error: outcome.message };
    }
    if (outcome.final || outcome.dryRun) {
      return {
        ...base, ok: true, state: before as MacroPhaseState, message: outcome.message,
        from: outcome.from, to: outcome.to, nextGates: outcome.nextGates,
        ...(outcome.final ? { final: true } : { dryRun: true }),
      };
    }
    const res = applyTransition(
      MACRO_PHASE_FLOW, MACRO_PHASE_GUARDS, before as MacroPhaseState, triggerOf(before, outcome.to ?? before),
      { payload: { currentPhase: before, gatesPassed } },
    );
    const events: FlowEvent<MacroPhaseState>[] = [];
    let state = before as MacroPhaseState;
    if (res.ok && res.event && res.next) {
      events.push(res.event);
      state = res.next;
      const loaded = loadFlowProjection<MacroPhaseState>(cyclesDir, MACRO_PHASE_FLOW.id);
      const prior = loaded ?? initRuntimeState(MACRO_PHASE_FLOW);
      saveFlowProjection(cyclesDir, {
        ...prior, current: state, history: [...prior.history, res.event], updatedAt: res.event.at,
      });
    }
    return {
      ...base, ok: true, state, from: outcome.from, to: outcome.to,
      message: outcome.message, nextGates: outcome.nextGates, events,
    };
  }

  // script 模式：脚本是 `.cycles/workflow-state.json` 的正典写入者
  const side = runScriptSide(workspaceRoot, opts.target, timeoutMs);
  if ('error' in side) {
    return { ...base, ok: false, state: before as MacroPhaseState, message: side.error, error: side.error };
  }
  const r = side.result;
  const after = loadMacroState(workspaceRoot)?.currentPhase ?? before;
  const ok = r.exitCode === 0;
  const message = r.exitCode === 0 ? r.stdout.trim() : r.stderr.split('\n')[0] ?? r.stderr;

  const out: MacroFlowRunResult = {
    ...base, ok, state: after as MacroPhaseState, message, stdout: r.stdout,
  };
  if (!ok || after === before) return out;

  // 脚本已推进 → 机器记录同一转移（守卫在此刻复核；分叉 = drift 可见）
  const res = applyTransition(
    MACRO_PHASE_FLOW, MACRO_PHASE_GUARDS, before as MacroPhaseState, triggerOf(before, after),
    { payload: { currentPhase: before, gatesPassed } },
  );
  if (res.ok && res.event && res.next) {
    out.events = [res.event];
    const loaded = loadFlowProjection<MacroPhaseState>(cyclesDir, MACRO_PHASE_FLOW.id);
    const prior = loaded ?? initRuntimeState(MACRO_PHASE_FLOW);
    saveFlowProjection(cyclesDir, {
      ...prior, current: res.next, history: [...prior.history, res.event], updatedAt: res.event.at,
    });
  } else {
    out.drift = true; // 脚本放行、机器守卫拒绝 —— 语义分叉必须可见
  }
  return out;
}

/** 只读状态视图（cmdStatus 的投影面；不落盘、不执行 inferPhase 回写）。 */
export function statusMacroPhase(workspaceRoot: string) {
  const state = loadMacroState(workspaceRoot);
  const gateResults = readGateResults(workspaceRoot);
  const phase = PHASES.find((p) => p.id === state?.currentPhase) ?? null;
  return {
    flowId: 'macro-phase',
    currentPhase: state?.currentPhase ?? null,
    phaseName: phase?.name ?? null,
    currentCycle: state?.currentCycle ?? null,
    phaseHistoryLength: state?.phaseHistory.length ?? 0,
    gates: phase
      ? phase.gates.map((g) => ({
        gate: g,
        // 技能 cmdStatus 展示序：曾 PASS > 曾 FAIL > PENDING
        status: gateResults.passed.includes(g) ? 'PASS' : gateResults.failed.includes(g) ? 'FAIL' : 'PENDING',
      }))
      : [],
    projectionSeeded: state !== null,
  };
}

/** 崩溃恢复 / 测试共用（INV-13 replay === online）。 */
export function rebuildMacroFlowState(events: FlowEvent<MacroPhaseState>[]) {
  return replayEvents(MACRO_PHASE_FLOW, events);
}
