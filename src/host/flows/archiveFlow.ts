/**
 * archiveFlow —— archive 流程状态机（R3 阶段 3 后半，第 3 个专属流程）。
 *
 * 状态图：IDLE →(run)→ RUNNING →(success, 守卫:引擎 ok)→ DONE
 *                              →(blocked, 守卫:引擎拒绝)→ BLOCKED
 *         RUNNING →(run)→ RUNNING   崩溃恢复自环
 *         BLOCKED →(run)→ RUNNING   重试恢复（修复任务后再归档，无需手动 reset）
 *         DONE →(run)→ RUNNING      终态重入（D-1101：cycle-N 归档完成后 cycle-N+1
 *                                   是新的一跑；技能侧 archive-cycle.mjs:68 对已归档
 *                                   同名 cycle 报 already archived，对不同 cycle 是
 *                                   全新合法运行）
 *         DONE/BLOCKED →(reset)→ IDLE
 *
 * 两执行模式（无 diff —— archive 是写动作，同目录双跑会双写；
 * 差分以孪生夹具契约 tests/contract/archiveDifferential.test.ts 完成）：
 *  - script：spawn 技能 archive-cycle.mjs（正典路径）
 *  - native：archiveEngine（isCycleComplete 与 G1 共用 parseTaskRows）
 *
 * 守卫纪律（INV-28）：引擎 ok=false（有未完成任务/不存在/已归档）永远进不了
 * DONE —— BLOCKED 是它的唯一归宿，失败原因逐字透传。
 */
import { join } from 'node:path';
import type { FlowDescriptor, FlowEvent, GuardFn } from './contracts.ts';
import { applyTransition, initRuntimeState, replayEvents } from './machine.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';
import { runArchiveAction, type ArchiveAction, type ArchiveOutcome } from './archiveEngine.ts';
import { resolveSkillScriptsDir, invokeSkillScript } from '../skillInvoker.ts';

export type ArchiveFlowState = 'IDLE' | 'RUNNING' | 'DONE' | 'BLOCKED';

export const ARCHIVE_FLOW: FlowDescriptor<ArchiveFlowState> = {
  id: 'archive',
  labelKey: 'flows.archive',
  states: ['IDLE', 'RUNNING', 'DONE', 'BLOCKED'],
  initial: 'IDLE',
  transitions: [
    { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'RUNNING', trigger: 'run' },
    { from: 'BLOCKED', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'DONE', trigger: 'success', guard: 'engine-ok' },
    { from: 'RUNNING', to: 'BLOCKED', trigger: 'blocked', guard: 'engine-blocked' },
    { from: 'DONE', to: 'RUNNING', trigger: 'run' },
    { from: 'DONE', to: 'IDLE', trigger: 'reset' },
    { from: 'BLOCKED', to: 'IDLE', trigger: 'reset' },
  ],
  persistence: { kind: 'projection', path: 'flows/archive.json' },
  engine: 'archiveEngine',
  scriptFallback: 'archive-cycle',
};

export const ARCHIVE_GUARDS: Record<string, GuardFn> = {
  'engine-ok': (ctx) => {
    const payload = ctx.payload as { ok?: boolean } | undefined;
    if (payload?.ok === true) return { ok: true };
    return { ok: false, reason: 'engine refused (incomplete / missing / already archived)' };
  },
  'engine-blocked': (ctx) => {
    const payload = ctx.payload as { ok?: boolean } | undefined;
    if (payload?.ok === false) return { ok: true };
    return { ok: false, reason: 'engine succeeded (nothing to block on)' };
  },
};

export type ArchiveFlowMode = 'script' | 'native';

export interface ArchiveFlowRunResult {
  mode: ArchiveFlowMode;
  flowId: 'archive';
  state: ArchiveFlowState;
  events: FlowEvent<ArchiveFlowState>[];
  ok: boolean;
  action: ArchiveAction['kind'];
  message: string;
  affected: string[];
  inventory?: ArchiveOutcome['inventory'];
  stdout?: string;
  error?: string;
}

/** 从脚本 stdout 提取受影响循环名（Archived cycle-N to … / Removed old archive: cycle-N）。 */
function affectedFromStdout(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    let m = line.match(/^Archived (cycle-\d+) to /);
    if (m?.[1]) { names.push(m[1]); continue; }
    m = line.match(/^Removed old archive: (cycle-\d+)/);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** script 正典路径：spawn archive-cycle.mjs。技能目录缺失 → error 响亮返回。 */
function runArchiveScript(
  ws: string,
  action: ArchiveAction,
  timeoutMs: number,
): { ok: boolean; message: string; affected: string[]; stdout: string } | { error: string } {
  const scriptsDir = resolveSkillScriptsDir(ws);
  if (!scriptsDir) return { error: 'skill scripts not found' };
  const args =
    action.kind === 'archive' ? ['--cycle', String(action.cycle)]
    : action.kind === 'clean' ? ['--clean', ...(action.keep !== undefined ? ['--keep', String(action.keep)] : [])]
    : ['--list'];
  const r = invokeSkillScript(scriptsDir, 'archive-cycle', args, ws, timeoutMs);
  // 技能把错误打在 stderr（console.error）——失败时消息从 stderr 取首行
  const out = r.stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const err = r.stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return {
    ok: r.exitCode === 0,
    message: out !== '' ? out : err,
    affected: affectedFromStdout(r.stdout),
    stdout: r.stdout,
  };
}

/**
 * 运行 archive 流程。执行错误（技能目录缺失等）不推进状态机，error 响亮返回。
 * list 是只读动作：直接返回清单，不触碰状态机（与 macroPhase status 同款纪律）。
 */
export function runArchiveFlow(
  workspaceRoot: string,
  opts: { cycle?: number; clean?: boolean; keep?: number; list?: boolean; mode?: ArchiveFlowMode; timeoutMs?: number } = {},
): ArchiveFlowRunResult {
  const mode: ArchiveFlowMode = opts.mode ?? 'native';
  const timeoutMs = Math.min(opts.timeoutMs ?? 60000, 120000);
  const cyclesDir = join(workspaceRoot, '.cycles');

  const action: ArchiveAction = opts.list === true
    ? { kind: 'list' }
    : opts.clean === true
      ? { kind: 'clean', keep: opts.keep }
      : typeof opts.cycle === 'number'
        ? { kind: 'archive', cycle: opts.cycle }
        : { kind: 'list' }; // 无参数缺省 list（与脚本「Must specify …」的用法错误不同：HTTP 面给安全只读缺省）

  if (action.kind === 'list') {
    const native = runArchiveAction(workspaceRoot, action);
    return {
      mode, flowId: 'archive', state: 'IDLE', events: [],
      ok: true, action: 'list', message: native.message, affected: [],
      inventory: native.inventory, error: undefined,
    };
  }

  const base = { mode, flowId: 'archive' as const, action: action.kind, events: [] as FlowEvent<ArchiveFlowState>[] };

  let ok: boolean;
  let message: string;
  let affected: string[];
  let stdout: string | undefined;
  if (mode === 'script') {
    const s = runArchiveScript(workspaceRoot, action, timeoutMs);
    if ('error' in s) {
      return { ...base, state: 'IDLE', ok: false, message: s.error, affected: [], error: s.error };
    }
    ok = s.ok; message = s.message; affected = s.affected; stdout = s.stdout;
  } else {
    const native = runArchiveAction(workspaceRoot, action);
    ok = native.ok; message = native.message; affected = native.affected;
  }

  // 状态机推进：run → success/blocked（守卫消费引擎 ok）
  const loaded = loadFlowProjection<ArchiveFlowState>(cyclesDir, ARCHIVE_FLOW.id);
  let state = loaded ?? initRuntimeState(ARCHIVE_FLOW);
  const events: FlowEvent<ArchiveFlowState>[] = [];

  const runRes = applyTransition(ARCHIVE_FLOW, ARCHIVE_GUARDS, state.current, 'run');
  if (runRes.ok && runRes.event && runRes.next) {
    events.push(runRes.event);
    state = { ...state, current: runRes.next, history: [...state.history, runRes.event], updatedAt: runRes.event.at };
  }
  const verdictTrigger = ok ? 'success' : 'blocked';
  const verdictRes = applyTransition(
    ARCHIVE_FLOW, ARCHIVE_GUARDS, state.current, verdictTrigger,
    { payload: { ok } },
  );
  if (verdictRes.ok && verdictRes.event && verdictRes.next) {
    events.push(verdictRes.event);
    state = { ...state, current: verdictRes.next, history: [...state.history, verdictRes.event], updatedAt: verdictRes.event.at };
  }
  saveFlowProjection(cyclesDir, state);

  return {
    mode, flowId: 'archive', state: state.current, events,
    ok, action: action.kind, message, affected, stdout, error: ok ? undefined : message,
  };
}

/** 崩溃恢复 / 测试共用：从事件序列重建运行态（INV-13）。 */
export function rebuildArchiveFlowState(events: FlowEvent<ArchiveFlowState>[]) {
  return replayEvents(ARCHIVE_FLOW, events);
}
