/**
 * FlowMachine —— 纯函数状态机（L1，零 IO，零全局态）。
 *
 * 与 runtime/stateMachine.ts（图节点机）的分工：那是「一种」状态机（workflow-graph
 * 节点推进）；本模块是「流程状态流转机」的通用内核 —— 转移表驱动的描述子 +
 * can/apply/replay 三原语。R3 裁决：不重写 15 脚本，而是给每个流程一个
 * 专属流转机实例（描述子），共用这一套内核。
 *
 * 纪律（承重）：
 *  - apply 是唯一产生「下一状态 + 事件」的入口；调用方持久化，本模块不写盘。
 *  - replay 只接受合法事件序列（from 必须等于折叠到的当前状态）；非法事件
 *    计入 rejected 但不推进 —— 损坏的投影不能把状态机带进未定义状态。
 *  - 守卫按名查找；未知守卫名 = 拒绝（fail-closed，不是放行）。
 */
import type {
  FlowDescriptor,
  FlowEvent,
  FlowRuntimeState,
  FlowState,
  FlowTransition,
  GuardContext,
  GuardFn,
  GuardResult,
  FlowApplyResult,
} from './contracts.ts';

/** 描述子静态校验：initial ∈ states；每条转移的 from/to ∈ states∪{'*'}；to ≠ '*'。 */
export function validateDescriptor<S extends FlowState>(d: FlowDescriptor<S>): string[] {
  const problems: string[] = [];
  const stateSet = new Set<string>(d.states);
  if (!stateSet.has(d.initial)) problems.push(`initial "${d.initial}" not in states`);
  for (const t of d.transitions) {
    if (t.from !== '*' && !stateSet.has(t.from)) problems.push(`transition "${t.trigger}" from "${t.from}" unknown`);
    if (!stateSet.has(t.to)) problems.push(`transition "${t.trigger}" to "${t.to}" unknown`);
    if (t.to === '*') problems.push(`transition "${t.trigger}" targets "*" (wildcard only allowed on from)`);
  }
  return problems;
}

/** 找到 (state, trigger) 的转移边；from='*' 兜底（具体边优先于通配边）。 */
export function findTransition<S extends FlowState>(
  d: FlowDescriptor<S>,
  state: S,
  trigger: string,
): FlowTransition<S> | undefined {
  const exact = d.transitions.find((t) => t.trigger === trigger && t.from === state);
  if (exact) return exact;
  return d.transitions.find((t) => t.trigger === trigger && t.from === '*');
}

/** 纯查询：能否转移（不写任何东西）。守卫失败也返回（带 reason），供 UI 预判。 */
export function canTransition<S extends FlowState>(
  d: FlowDescriptor<S>,
  guards: Record<string, GuardFn>,
  state: S,
  trigger: string,
  gctx: GuardContext = {},
): GuardResult {
  const t = findTransition(d, state, trigger);
  if (!t) return { ok: false, reason: `no transition "${trigger}" from "${state}"` };
  if (!t.guard) return { ok: true };
  const fn = guards[t.guard];
  if (!fn) return { ok: false, reason: `unknown guard "${t.guard}" (fail-closed)` };
  const r = fn(gctx);
  return { ok: r.ok, reason: r.reason, refusal: r.refusal };
}

/** 唯一写点：执行转移，返回下一状态 + 事件（不持久化）。 */
export function applyTransition<S extends FlowState>(
  d: FlowDescriptor<S>,
  guards: Record<string, GuardFn>,
  state: S,
  trigger: string,
  gctx: GuardContext = {},
  now: string = new Date().toISOString(),
): FlowApplyResult<S> {
  const t = findTransition(d, state, trigger);
  const gate = canTransition(d, guards, state, trigger, gctx);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason ?? 'guard rejected', refusal: gate.refusal };
  }
  if (!t) return { ok: false, reason: `transition "${trigger}" vanished between can/apply` };
  const event: FlowEvent<S> = { trigger, from: state, to: t.to, at: now };
  if (gate.reason) event.reason = gate.reason;
  return { ok: true, next: t.to, event };
}

/** 初始运行态（幂等：总从描述子 initial 出发）。 */
export function initRuntimeState<S extends FlowState>(
  d: FlowDescriptor<S>,
  now: string = new Date().toISOString(),
): FlowRuntimeState<S> {
  return { flowId: d.id, current: d.initial, history: [], updatedAt: now, ledgerHead: null };
}

/** replay 的折叠结果：终态 + 被拒绝的事件（合法序列下 rejected 为空）。 */
export interface ReplayResult<S extends FlowState = FlowState> {
  state: FlowRuntimeState<S>;
  /** 非法事件（from ≠ 折叠当前态）：不推进，但必须可见（INV-22 可审计路径）。 */
  rejected: Array<{ event: FlowEvent<S>; reason: string }>;
}

/**
 * 崩溃恢复 / 投影重算：从事件序列重建运行态。
 * INV-13（可重算投影）：replay(events) 必须与在线状态全等 —— 任何把「额外事实」
 * 偷偷写进投影而不产生事件的实现都会在这里暴露（rebuild ≠ online）。
 */
export function replayEvents<S extends FlowState>(
  d: FlowDescriptor<S>,
  events: FlowEvent<S>[],
  now: string = new Date().toISOString(),
): ReplayResult<S> {
  let state = initRuntimeState(d, now);
  const rejected: Array<{ event: FlowEvent<S>; reason: string }> = [];
  for (const ev of events) {
    if (ev.from !== state.current) {
      rejected.push({ event: ev, reason: `event from "${ev.from}" but current is "${state.current}"` });
      continue;
    }
    // replay 不跑守卫（守卫可能在历史时刻依赖已消失的负载）——但转移边必须存在
    const t = findTransition(d, state.current, ev.trigger);
    if (!t || t.to !== ev.to) {
      rejected.push({ event: ev, reason: `no matching transition "${ev.trigger}" -> "${ev.to}"` });
      continue;
    }
    state = { ...state, current: ev.to, history: [...state.history, ev], updatedAt: ev.at };
  }
  return { state, rejected };
}
