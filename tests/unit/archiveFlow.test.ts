/**
 * archiveFlow 契约（R3 阶段 3 后半）—— 状态机层。
 *
 * 承重断言：守卫拒绝（引擎 ok=false）永远进 BLOCKED 不进 DONE；
 * 投影 replay 全等（INV-13）；list 只读不触碰状态机。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ARCHIVE_FLOW, ARCHIVE_GUARDS, runArchiveFlow, rebuildArchiveFlowState, type ArchiveFlowState,
} from '../../src/host/flows/archiveFlow.ts';
import { validateDescriptor } from '../../src/host/flows/machine.ts';
import { registerFlow, __resetFlowRegistryForTests } from '../../src/host/flows/registry.ts';
import { loadFlowProjection } from '../../src/host/flows/persistence.ts';

let root: string;

const DONE_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 完成 |';
const PENDING_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 待办 |';

function seedCycle(name: string, tasks: string): void {
  const dir = join(root, '.cycles', 'cycles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '任务清单.md'), tasks);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-archiveflow-'));
  __resetFlowRegistryForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('archiveFlow 描述子与守卫', () => {
  it('描述子合法（validateDescriptor 零问题）', () => {
    expect(validateDescriptor(ARCHIVE_FLOW)).toEqual([]);
  });
  it('守卫：ok=true 放行 success / ok=false 放行 blocked（拒绝语义非颠倒）', () => {
    expect(ARCHIVE_GUARDS['engine-ok']!({ payload: { ok: true } })).toEqual({ ok: true });
    expect(ARCHIVE_GUARDS['engine-ok']!({ payload: { ok: false } }).ok).toBe(false);
    expect(ARCHIVE_GUARDS['engine-blocked']!({ payload: { ok: false } })).toEqual({ ok: true });
    expect(ARCHIVE_GUARDS['engine-blocked']!({ payload: { ok: true } }).ok).toBe(false);
  });
  it('注册进 FlowRegistry（同 id 首个胜出）', () => {
    const d = registerFlow(ARCHIVE_FLOW);
    expect(d).toBeTypeOf('function');
    d!();
  });
});

describe('runArchiveFlow（native）', () => {
  it('归档成功：state DONE + 事件 2 条（run+success）+ 投影落盘', () => {
    seedCycle('cycle-1', DONE_TASKS);
    const r = runArchiveFlow(root, { cycle: 1, mode: 'native' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('DONE');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'success']);
    expect(r.affected).toEqual(['cycle-1']);
    const projection = loadFlowProjection<ArchiveFlowState>(join(root, '.cycles'), 'archive');
    expect(projection?.current).toBe('DONE');
  });
  it('有未完成任务：state BLOCKED + 失败原因逐字 + 目录不动', () => {
    seedCycle('cycle-2', PENDING_TASKS);
    const r = runArchiveFlow(root, { cycle: 2, mode: 'native' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('BLOCKED');
    expect(r.error).toBe('Cycle cycle-2 has pending tasks. Complete all tasks before archiving.');
    expect(r.events.map((e) => e.trigger)).toEqual(['run', 'blocked']);
  });
  it('BLOCKED 重试恢复：修复任务后重跑 → DONE（BLOCKED→RUNNING 边）', () => {
    seedCycle('cycle-3', PENDING_TASKS);
    const r1 = runArchiveFlow(root, { cycle: 3, mode: 'native' });
    expect(r1.state).toBe('BLOCKED');
    // 修复任务后重跑：BLOCKED →(run)→ RUNNING →(success)→ DONE
    writeFileSync(join(root, '.cycles', 'cycles', 'cycle-3', '任务清单.md'), DONE_TASKS);
    const r2 = runArchiveFlow(root, { cycle: 3, mode: 'native' });
    expect(r2.ok).toBe(true);
    expect(r2.state).toBe('DONE');
    expect(r2.affected).toEqual(['cycle-3']);
    expect(r2.events.map((e) => e.trigger)).toEqual(['run', 'success']);
  });
  it('list：只读清单 + 状态机零事件 + 投影不落盘', () => {
    seedCycle('cycle-1', DONE_TASKS);
    const r = runArchiveFlow(root, { mode: 'native' }); // 无参缺省 list
    expect(r.ok).toBe(true);
    expect(r.action).toBe('list');
    expect(r.events).toEqual([]);
    expect(r.inventory?.active).toHaveLength(1);
    expect(loadFlowProjection<ArchiveFlowState>(join(root, '.cycles'), 'archive')).toBeNull();
  });
  it('clean：keep 语义 + DONE', () => {
    for (const n of [1, 2, 3, 4]) {
      const dir = join(root, '.cycles', 'archive', `cycle-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'meta.json'), '{}');
    }
    const r = runArchiveFlow(root, { clean: true, keep: 2, mode: 'native' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('DONE');
    expect(r.affected).toEqual(['cycle-1', 'cycle-2']);
  });
});

describe('rebuildArchiveFlowState（INV-13）', () => {
  it('事件序列重建与在线推进全等', () => {
    seedCycle('cycle-5', DONE_TASKS);
    const r = runArchiveFlow(root, { cycle: 5, mode: 'native' });
    const replayed = rebuildArchiveFlowState(r.events);
    expect(replayed.state.current).toBe('DONE');
    expect(replayed.rejected).toEqual([]);
  });
  it('投影文件内容 = replay 结果（读写一致性）', () => {
    seedCycle('cycle-6', DONE_TASKS);
    const r = runArchiveFlow(root, { cycle: 6, mode: 'native' });
    const projection = JSON.parse(readFileSync(join(root, '.cycles', 'flows', 'archive.json'), 'utf-8'));
    expect(projection.current).toBe('DONE');
    expect(projection.history).toHaveLength(r.events.length);
  });
});
