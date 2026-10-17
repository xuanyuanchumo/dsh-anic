/**
 * FlowMachine 内核单元（R3 阶段 2）。
 *
 * 钉死契约：validateDescriptor 静态校验 / findTransition 精确边优先 /
 * canTransition 纯查询 / applyTransition 唯一写点 / replayEvents INV-13
 * （replay 折叠态 === 在线推进态；非法事件 rejected 不推进）。
 */
import { describe, expect, it } from 'vitest';
import type { FlowDescriptor, FlowEvent, GuardFn } from '../../src/host/flows/contracts.ts';
import {
  applyTransition,
  canTransition,
  findTransition,
  initRuntimeState,
  replayEvents,
  validateDescriptor,
} from '../../src/host/flows/machine.ts';

type S = 'IDLE' | 'RUNNING' | 'DONE';

const d: FlowDescriptor<S> = {
  id: 'test',
  labelKey: 'flows.test',
  states: ['IDLE', 'RUNNING', 'DONE'],
  initial: 'IDLE',
  transitions: [
    { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
    { from: 'RUNNING', to: 'DONE', trigger: 'finish', guard: 'ok-guard' },
    { from: '*', to: 'IDLE', trigger: 'reset' },
  ],
  persistence: { kind: 'none' },
};

const guards: Record<string, GuardFn> = {
  'ok-guard': (ctx) => (ctx.payload === true ? { ok: true } : { ok: false, reason: 'payload not true' }),
  'refuse-guard': () => ({ ok: false, reason: 'always refuses', refusal: 'SELF_REFUSAL' }),
};

describe('validateDescriptor', () => {
  it('合法描述子零问题', () => {
    expect(validateDescriptor(d)).toEqual([]);
  });
  it('initial 不在 states → 拒绝', () => {
    expect(validateDescriptor({ ...d, initial: 'GHOST' as S })).toContainEqual(expect.stringContaining('initial'));
  });
  it('from 引用未知状态 → 拒绝', () => {
    const bad = { ...d, transitions: [{ from: 'GHOST' as S, to: 'IDLE', trigger: 'x' }] };
    expect(validateDescriptor(bad).join('; ')).toContain('from "GHOST"');
  });
  it('to 引用未知状态 → 拒绝；to="*" → 拒绝（通配只许出现在 from）', () => {
    const badTo = { ...d, transitions: [{ from: 'IDLE', to: 'GHOST' as S, trigger: 'x' }] };
    expect(validateDescriptor(badTo).join('; ')).toContain('to "GHOST"');
    const badStar = { ...d, transitions: [{ from: 'IDLE', to: '*' as S, trigger: 'x' }] };
    expect(validateDescriptor(badStar).join('; ')).toContain('targets "*"');
  });
});

describe('findTransition', () => {
  it('精确边优先于通配边', () => {
    const both: FlowDescriptor<S> = {
      ...d,
      transitions: [
        { from: '*', to: 'IDLE', trigger: 'run' },
        { from: 'IDLE', to: 'RUNNING', trigger: 'run' },
      ],
    };
    expect(findTransition(both, 'IDLE', 'run')?.to).toBe('RUNNING');
  });
  it('无精确边时落到通配边', () => {
    expect(findTransition(d, 'DONE', 'reset')?.to).toBe('IDLE');
  });
  it('不存在的 trigger → undefined', () => {
    expect(findTransition(d, 'IDLE', 'nope')).toBeUndefined();
  });
});

describe('canTransition（纯查询）', () => {
  it('无守卫的边恒可走', () => {
    expect(canTransition(d, guards, 'IDLE', 'run')).toEqual({ ok: true });
  });
  it('守卫通过 / 拒绝（带 reason）', () => {
    expect(canTransition(d, guards, 'RUNNING', 'finish', { payload: true }).ok).toBe(true);
    const r = canTransition(d, guards, 'RUNNING', 'finish', { payload: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('payload not true');
  });
  it('未知守卫名 = fail-closed 拒绝（不是放行）', () => {
    const r = canTransition(d, guards, 'RUNNING', 'finish', { payload: true });
    // 'ok-guard' 已注册 → 正常。换未知守卫的边验证：
    const d2: FlowDescriptor<S> = { ...d, transitions: [{ from: 'IDLE', to: 'RUNNING', trigger: 'run', guard: 'ghost' }] };
    const r2 = canTransition(d2, guards, 'IDLE', 'run');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('unknown guard "ghost"');
    expect(r.ok).toBe(true);
  });
  it('守卫的 SELF_REFUSAL 语义透传', () => {
    const d3: FlowDescriptor<S> = { ...d, transitions: [{ from: 'IDLE', to: 'RUNNING', trigger: 'run', guard: 'refuse-guard' }] };
    const r = canTransition(d3, guards, 'IDLE', 'run');
    expect(r).toEqual({ ok: false, reason: 'always refuses', refusal: 'SELF_REFUSAL' });
  });
});

describe('applyTransition（唯一写点）', () => {
  it('成功转移产出事件 {trigger, from, to, at}', () => {
    const r = applyTransition(d, guards, 'IDLE', 'run', {}, '2026-01-01T00:00:00.000Z');
    expect(r.ok).toBe(true);
    expect(r.next).toBe('RUNNING');
    expect(r.event).toEqual({ trigger: 'run', from: 'IDLE', to: 'RUNNING', at: '2026-01-01T00:00:00.000Z' });
  });
  it('守卫拒绝时不产事件（ok=false + reason）', () => {
    const r = applyTransition(d, guards, 'RUNNING', 'finish', { payload: false });
    expect(r.ok).toBe(false);
    expect(r.event).toBeUndefined();
    expect(r.reason).toBe('payload not true');
  });
  it('无转移边 → 拒绝（不可凭空转移）', () => {
    const r = applyTransition(d, guards, 'IDLE', 'finish');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no transition "finish" from "IDLE"');
  });
});

describe('replayEvents（INV-13）', () => {
  it('合法序列折叠态 === 在线推进态', () => {
    // 在线：IDLE --run--> RUNNING --finish(payload true)--> DONE
    const e1 = applyTransition(d, guards, 'IDLE', 'run', {}, 't1');
    const e2 = applyTransition(d, guards, 'RUNNING', 'finish', { payload: true }, 't2');
    const online = [e1.event, e2.event] as FlowEvent<S>[];
    const { state, rejected } = replayEvents(d, online);
    expect(rejected).toEqual([]);
    expect(state.current).toBe('DONE');
    expect(state.history).toEqual(online);
  });
  it('事件 from ≠ 当前态 → rejected 不推进（损坏投影带不进未定义状态）', () => {
    const ev: FlowEvent<S>[] = [
      { trigger: 'run', from: 'IDLE', to: 'RUNNING', at: 't1' },
      { trigger: 'finish', from: 'IDLE', to: 'DONE', at: 't2' }, // from 错：当前是 RUNNING
    ];
    const { state, rejected } = replayEvents(d, ev);
    expect(state.current).toBe('RUNNING'); // 第二条不推进
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('from "IDLE" but current is "RUNNING"');
  });
  it('转移边不存在或 to 不匹配 → rejected', () => {
    const ev: FlowEvent<S>[] = [{ trigger: 'run', from: 'IDLE', to: 'DONE', at: 't1' }];
    const { state, rejected } = replayEvents(d, ev);
    expect(state.current).toBe('IDLE');
    expect(rejected[0]?.reason).toContain('no matching transition "run" -> "DONE"');
  });
  it('initRuntimeState 从 initial 出发（幂等）', () => {
    const s = initRuntimeState(d, 't0');
    expect(s).toEqual({ flowId: 'test', current: 'IDLE', history: [], updatedAt: 't0', ledgerHead: null });
  });
});
