/**
 * FlowRegistry + 投影持久化单元（R3 阶段 2）。
 *
 * 注册表钉死：非法描述子拒绝 / 同 id 首个胜出（no-op disposer，与
 * ctx.skills.register 同款）/ disposer 只删自己。投影钉死：唯一写者、
 * 损坏即 null（可丢弃缓存语义）、ledgerHead staleness 检测。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetFlowRegistryForTests,
  getFlow,
  listFlows,
  registerFlow,
} from '../../src/host/flows/registry.ts';
import {
  flowProjectionPath,
  isProjectionStale,
  loadFlowProjection,
  saveFlowProjection,
} from '../../src/host/flows/persistence.ts';
import type { FlowDescriptor, FlowRuntimeState } from '../../src/host/flows/contracts.ts';

type S = 'A' | 'B';

const mk = (id: string): FlowDescriptor<S> => ({
  id,
  labelKey: `flows.${id}`,
  states: ['A', 'B'],
  initial: 'A',
  transitions: [{ from: 'A', to: 'B', trigger: 'go' }],
  persistence: { kind: 'projection', path: `flows/${id}.json` },
});

let tmp = '';

beforeEach(() => {
  __resetFlowRegistryForTests();
  tmp = mkdtempSync(join(tmpdir(), 'anic-flows-reg-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('FlowRegistry', () => {
  it('注册合法描述子 → listFlows 可见；disposer 移除', () => {
    const dispose = registerFlow(mk('f1'));
    expect(dispose).toBeTypeOf('function');
    expect(listFlows().map((f) => f.id)).toEqual(['f1']);
    dispose!();
    expect(listFlows()).toEqual([]);
    expect(getFlow('f1')).toBeUndefined();
  });
  it('非法描述子拒绝注册（返回 null，不进注册表）', () => {
    const bad = { ...mk('bad'), initial: 'X' as S };
    expect(registerFlow(bad)).toBeNull();
    expect(listFlows()).toEqual([]);
  });
  it('同 id 重复注册：首个胜出 + no-op disposer（HMR 语义与 ctx.skills.register 同款）', () => {
    const first = registerFlow(mk('dup'))!;
    const second = registerFlow(mk('dup'));
    expect(second).toBeTypeOf('function');
    expect(listFlows()).toHaveLength(1);
    // 第二个 disposer 是 no-op：调用后首个仍在
    second!();
    expect(listFlows()).toHaveLength(1);
    first();
    expect(listFlows()).toEqual([]);
  });
  it('disposer 只删自己注册的实例（防误删后注册的同 id 新描述子）', () => {
    const d1 = registerFlow(mk('x'))!;
    d1(); // 移除
    const d2 = registerFlow(mk('x'))!;
    d1(); // 旧 disposer 再跑一次：此时注册表里是"新实例"，不得误删
    expect(listFlows().map((f) => f.id)).toEqual(['x']);
    d2();
  });
});

describe('投影持久化（唯一写者）', () => {
  it('save/load 往返；缺失 → null', () => {
    const cyclesDir = join(tmp, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });
    expect(loadFlowProjection<S>(cyclesDir, 'f1')).toBeNull();
    const state: FlowRuntimeState<S> = {
      flowId: 'f1', current: 'B', updatedAt: 't1', ledgerHead: null,
      history: [{ trigger: 'go', from: 'A', to: 'B', at: 't1' }],
    };
    saveFlowProjection(cyclesDir, state);
    expect(loadFlowProjection<S>(cyclesDir, 'f1')).toEqual(state);
  });
  it('损坏 JSON → null（fail-safe，绝不部分采信）', () => {
    const cyclesDir = join(tmp, '.cycles');
    mkdirSync(join(cyclesDir, 'flows'), { recursive: true });
    writeFileSync(flowProjectionPath(cyclesDir, 'f1'), '{not json');
    expect(loadFlowProjection<S>(cyclesDir, 'f1')).toBeNull();
  });
  it('形状不对（flowId 不匹配 / 缺 history）→ null', () => {
    const cyclesDir = join(tmp, '.cycles');
    mkdirSync(join(cyclesDir, 'flows'), { recursive: true });
    writeFileSync(flowProjectionPath(cyclesDir, 'f1'), JSON.stringify({ flowId: 'other', current: 'A', history: [] }));
    expect(loadFlowProjection<S>(cyclesDir, 'f1')).toBeNull();
    writeFileSync(flowProjectionPath(cyclesDir, 'f1'), JSON.stringify({ flowId: 'f1', current: 'A' }));
    expect(loadFlowProjection<S>(cyclesDir, 'f1')).toBeNull();
  });
  it('isProjectionStale：投影 ledgerHead ≠ 当前链头 → stale', () => {
    const proj = { flowId: 'f1', current: 'B' as S, history: [], updatedAt: 't', ledgerHead: 'abc' };
    expect(isProjectionStale(proj, 'abc')).toBe(false);
    expect(isProjectionStale(proj, 'def')).toBe(true);
    expect(isProjectionStale(proj, null)).toBe(false); // 无账本流程不存在落后
    expect(isProjectionStale(null, 'abc')).toBe(false); // 无投影不存在落后
  });
});
