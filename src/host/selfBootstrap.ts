/**
 * Self-bootstrap state machine —— 表驱动（cycle-38 重构）。
 *
 * 约束：**绝不自我改码**（R-31 / docs/anic/12 §2.1），只产 tech-debt 提案。
 *
 * 重构起因（doc18 P1-6「自举状态机中间态空转」，本轮落地）：
 *   旧实现只声明了 7 个状态，但 `advanceBootstrap` 只会产出 CONVERGED /
 *   EXHAUSTED / FIXING —— **EVALUATING / GATE_CHECKING / VERIFYING 从不被状态机
 *   赋值**，只有路由用 `state.status = 'EVALUATING'` 直接改写字段绕过状态机，
 *   `VERIFYING` 更是全仓零赋值（死状态）。后果：
 *     1. 声明的状态集是谎言：7 个状态里 4 个不可达。
 *     2. `GET /anic/self/status` 在编排器跑动期间**永远看不到中间态**——
 *        「正在评估」「正在查门禁」这两件事在磁盘上不存在，白盒因此是假的。
 *     3. 两条写路径（状态机 / 路由直写）没有共同权威，非法转移无人拒绝。
 *
 * 判据（承第三方纪律）：
 *   - `dsh-per` 0.1.0：`transition-table.ts` 是状态迁移的**唯一权威**，子模块
 *     不能绕过 FSM 改状态 —— 本文件把同一纪律落到自举链上。
 *   - `dsh-state-graph` 0.2.0：非法转移**拒绝**而非静默纠正（fail-closed）。
 *
 * 状态语义：
 *   IDLE          未开始（`reset` 可回到此态）
 *   EVALUATING    正在跑 eval-runner        （start 进入，落盘可观测）
 *   GATE_CHECKING 正在跑 gate-check         （eval-done 进入）
 *   FIXING        门禁未过、正在产修复/提案 （gate-fail 进入）
 *   VERIFYING     修复后**同轮复检**        （fix-done 进入；doc18 P1-6 的 re-gate 环）
 *   CONVERGED     收敛（终态）
 *   EXHAUSTED     轮次耗尽（终态）
 */
import { join } from 'node:path';
import { atomicWriteFileSync, safeReadFileSync } from '../shared/fs-safe.ts';

export type BootstrapStatus =
  | 'IDLE'
  | 'EVALUATING'
  | 'GATE_CHECKING'
  | 'FIXING'
  | 'VERIFYING'
  | 'CONVERGED'
  | 'EXHAUSTED';

/** 中间态（一次自举轮次内部的进行态）。 */
export const BOOTSTRAP_PHASES: readonly BootstrapStatus[] = ['EVALUATING', 'GATE_CHECKING', 'FIXING', 'VERIFYING'];

/** 终态 + 空闲态（settle / reset 的落点）。 */
export const BOOTSTRAP_SETTLED: readonly BootstrapStatus[] = ['IDLE', 'CONVERGED', 'EXHAUSTED'];

/** 迁移触发词（闭合词表；未登记触发词一律拒绝）。 */
export type BootstrapTrigger =
  | 'start' //        * → EVALUATING（新一轮开始）
  | 'eval-done' //    * → GATE_CHECKING（评估完成，去查门禁）
  | 'gate-fail' //    GATE_CHECKING → FIXING（门禁未过）
  | 'fix-done' //     FIXING → VERIFYING（修复完成，同轮复检）
  | 'verify-fail' //  VERIFYING → GATE_CHECKING（复检未过，同轮再查一次）
  | 'settle-pass' //  * → CONVERGED
  | 'settle-exhausted' // * → EXHAUSTED
  | 'settle-fail' //  * → FIXING（轮次未耗尽的未通过）
  | 'reset'; //       * → IDLE

export interface BootstrapTransition {
  from: BootstrapStatus | '*';
  to: BootstrapStatus;
  trigger: BootstrapTrigger;
}

/**
 * 迁移表 —— 状态迁移的唯一权威。
 *
 * `from: '*'` 的语义是「从任意已结算或进行态进入」：轮次开始、结算、复位这三类
 * 事件与上一相位无关。而 **相位推进边刻意不用通配**：
 *   - `gate-fail` 只允许从 GATE_CHECKING 出发 → 没查过门禁就报失败 = 顺序错误；
 *   - `fix-done` 只允许从 FIXING 出发 → 没修复就进复检 = 伪造进展；
 *   - `verify-fail` 只允许从 VERIFYING 出发 → 没复检就重查 = 空转。
 */
export const BOOTSTRAP_TRANSITIONS: readonly BootstrapTransition[] = [
  { from: '*', to: 'EVALUATING', trigger: 'start' },
  { from: '*', to: 'GATE_CHECKING', trigger: 'eval-done' },
  { from: 'GATE_CHECKING', to: 'FIXING', trigger: 'gate-fail' },
  { from: 'FIXING', to: 'VERIFYING', trigger: 'fix-done' },
  { from: 'VERIFYING', to: 'GATE_CHECKING', trigger: 'verify-fail' },
  { from: '*', to: 'CONVERGED', trigger: 'settle-pass' },
  { from: '*', to: 'EXHAUSTED', trigger: 'settle-exhausted' },
  { from: '*', to: 'FIXING', trigger: 'settle-fail' },
  { from: '*', to: 'IDLE', trigger: 'reset' },
];

export interface BootstrapHistoryEntry {
  round: number;
  evalScore: number;
  gateVerdict: string;
  fixApplied: string | null;
  timestamp: string;
}

export interface BootstrapState {
  status: BootstrapStatus;
  round: number;
  maxRounds: number;
  lastEvalScore: number | null;
  lastGateVerdict: string | null;
  history: BootstrapHistoryEntry[];
}

const STATE_FILE = 'self-bootstrap.json';

export function initialBootstrapState(maxRounds = 3): BootstrapState {
  return {
    status: 'IDLE',
    round: 0,
    maxRounds,
    lastEvalScore: null,
    lastGateVerdict: null,
    history: [],
  };
}

export function loadBootstrapState(cyclesDir: string): BootstrapState {
  const file = join(cyclesDir, STATE_FILE);
  const raw = safeReadFileSync(file);
  if (!raw) return initialBootstrapState();
  try {
    const parsed = JSON.parse(raw) as Partial<BootstrapState>;
    if (typeof parsed.status === 'string' && typeof parsed.round === 'number') {
      // 声明内字段逐个归一化（类型不对就回落默认值，不采信坏数据）；
      // **但保留扩展字段**：`crossProjectHistory` 由 crossProjectHistory.ts 拥有，
      // 状态文件是共享载体——闭合读会静默丢弃别的模块写的键（cycle-38 实测：
      // 收紧成闭合读后 techDebtCrossProject 两条用例立即变红）。
      return {
        ...parsed,
        status: parsed.status as BootstrapStatus,
        round: parsed.round,
        maxRounds: typeof parsed.maxRounds === 'number' ? parsed.maxRounds : 3,
        lastEvalScore: typeof parsed.lastEvalScore === 'number' ? parsed.lastEvalScore : null,
        lastGateVerdict: typeof parsed.lastGateVerdict === 'string' ? parsed.lastGateVerdict : null,
        history: Array.isArray(parsed.history) ? parsed.history : [],
      } as BootstrapState;
    }
  } catch { /* corrupt → reset */ }
  return initialBootstrapState();
}

export function saveBootstrapState(cyclesDir: string, state: BootstrapState): void {
  const file = join(cyclesDir, STATE_FILE);
  atomicWriteFileSync(file, JSON.stringify(state, null, 2));
}

/** 按名查表（具体边优先于 `from:'*'` 通配，与 flows/machine.ts 同纪律）。 */
export function findBootstrapTransition(
  from: BootstrapStatus,
  trigger: BootstrapTrigger,
): BootstrapTransition | null {
  let wildcard: BootstrapTransition | null = null;
  for (const t of BOOTSTRAP_TRANSITIONS) {
    if (t.trigger !== trigger) continue;
    if (t.from === from) return t;
    if (t.from === '*' && wildcard === null) wildcard = t;
  }
  return wildcard;
}

export function canTransitionBootstrap(from: BootstrapStatus, trigger: BootstrapTrigger): boolean {
  return findBootstrapTransition(from, trigger) !== null;
}

export type BootstrapTransitionResult =
  | { ok: true; state: BootstrapState }
  | { ok: false; reason: string; state: BootstrapState };

/**
 * 唯一写 `status` 的函数（除 `initialBootstrapState` 的初值）。
 *
 * 非法触发词 / 非法起点 → `ok:false` 且**状态原样返回**（不猜、不静默纠正）。
 * 调用方（路由/编排器）必须把 `reason` 响亮呈现，而不是继续往下跑。
 */
export function transitionBootstrap(
  state: BootstrapState,
  trigger: BootstrapTrigger,
  patch?: Partial<Pick<BootstrapState, 'lastEvalScore' | 'lastGateVerdict' | 'maxRounds'>>,
): BootstrapTransitionResult {
  const t = findBootstrapTransition(state.status, trigger);
  if (t === null) {
    return {
      ok: false,
      reason: `illegal bootstrap transition: '${trigger}' from '${state.status}'`,
      state,
    };
  }
  return { ok: true, state: { ...state, ...patch, status: t.to } };
}

/**
 * 轮次结算（向后兼容入口，语义与旧实现逐字一致）。
 *
 * 内部走同一张表：PASS/approve → `settle-pass`；轮次耗尽 → `settle-exhausted`；
 * 其余（含 `doubt`/`unknown`）→ `settle-fail`（fail-closed：没通过就是没通过）。
 * `round` 只在这里自增 —— 中间相位推进不改轮次计数。
 */
export function advanceBootstrap(
  state: BootstrapState,
  evalScore: number,
  gateVerdict: string,
  fixApplied: string | null,
): BootstrapState {
  const newRound = state.round + 1;
  const passed = gateVerdict === 'PASS' || gateVerdict === 'approve';
  const trigger: BootstrapTrigger = passed
    ? 'settle-pass'
    : newRound >= state.maxRounds
      ? 'settle-exhausted'
      : 'settle-fail';
  const entry: BootstrapHistoryEntry = {
    round: newRound,
    evalScore,
    gateVerdict,
    fixApplied,
    timestamp: new Date().toISOString(),
  };
  const moved = transitionBootstrap(state, trigger);
  // 表里 settle-* 全是通配边，任何起点都合法；若未来收紧到拒绝，则原样返回旧态
  // 而不是伪造一个终态 —— 宁可停在原地，不可宣称收敛。
  const next = moved.ok ? moved.state : state;
  return {
    status: next.status,
    round: newRound,
    maxRounds: state.maxRounds,
    lastEvalScore: evalScore,
    lastGateVerdict: gateVerdict,
    history: [...state.history, entry],
  };
}
