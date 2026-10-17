/**
 * archiveDifferential —— 孪生夹具差分契约（R3 阶段 3 后半）。
 *
 * archive 是写动作，同目录双跑会双写（第二次「already archived」）——
 * 差分以孪生夹具完成：两份相同夹具各跑一侧（script spawn 真技能脚本
 * vs native 引擎），比对落盘结果（归档目录内容 + 拒绝消息 + exit 语义）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runArchiveFlow } from '../../src/host/flows/archiveFlow.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('../../assets/skill/scripts/', import.meta.url));

const DONE_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 完成 |';
const PENDING_TASKS = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| T-01 | P0 | 任务A | 测试 | lead | 待办 |';

let fixtureA: string; // script 侧
let fixtureB: string; // native 侧

/** 构造孪生夹具：两边目录结构逐字节相同。 */
function seedTwins(tasks: string): void {
  for (const dir of [fixtureA, fixtureB]) {
    const cycle = join(dir, '.cycles', 'cycles', 'cycle-7');
    mkdirSync(cycle, { recursive: true });
    writeFileSync(join(cycle, '任务清单.md'), tasks);
  }
}

beforeEach(() => {
  fixtureA = mkdtempSync(join(tmpdir(), 'anic-archdiff-a-'));
  fixtureB = mkdtempSync(join(tmpdir(), 'anic-archdiff-b-'));
});
afterEach(() => {
  rmSync(fixtureA, { recursive: true, force: true });
  rmSync(fixtureB, { recursive: true, force: true });
});

describe('archive 孪生夹具差分（native vs script）', () => {
  it('全绿夹具：归档成功 —— 落盘归档目录一致', () => {
    seedTwins(DONE_TASKS);
    const s = runArchiveFlow(fixtureA, { cycle: 7, mode: 'script' });
    const n = runArchiveFlow(fixtureB, { cycle: 7, mode: 'native' });
    expect(s.ok).toBe(true);
    expect(n.ok).toBe(true);
    expect(s.state).toBe(n.state);
    expect(s.affected).toEqual(n.affected);
    expect(readdirSync(join(fixtureA, '.cycles', 'archive'))).toEqual(['cycle-7']);
    expect(readdirSync(join(fixtureB, '.cycles', 'archive'))).toEqual(['cycle-7']);
    expect(existsSync(join(fixtureA, '.cycles', 'cycles', 'cycle-7'))).toBe(false);
    expect(existsSync(join(fixtureB, '.cycles', 'cycles', 'cycle-7'))).toBe(false);
  });

  it('红夹具：有未完成任务 —— 拒绝消息逐字相等 + 双侧零变化', () => {
    seedTwins(PENDING_TASKS);
    const s = runArchiveFlow(fixtureA, { cycle: 7, mode: 'script' });
    const n = runArchiveFlow(fixtureB, { cycle: 7, mode: 'native' });
    expect(s.ok).toBe(false);
    expect(n.ok).toBe(false);
    expect(s.state).toBe('BLOCKED');
    expect(n.state).toBe('BLOCKED');
    expect(n.error).toBe('Cycle cycle-7 has pending tasks. Complete all tasks before archiving.');
    expect(s.message).toContain('has pending tasks');
    expect(existsSync(join(fixtureA, '.cycles', 'cycles', 'cycle-7'))).toBe(true);
    expect(existsSync(join(fixtureB, '.cycles', 'cycles', 'cycle-7'))).toBe(true);
    expect(existsSync(join(fixtureA, '.cycles', 'archive'))).toBe(false);
    expect(existsSync(join(fixtureB, '.cycles', 'archive'))).toBe(false);
  });

  it('不存在循环：双侧拒绝 + 消息逐字（Cycle cycle-99 not found.）', () => {
    const s = runArchiveFlow(fixtureA, { cycle: 99, mode: 'script' });
    const n = runArchiveFlow(fixtureB, { cycle: 99, mode: 'native' });
    expect(s.ok).toBe(false);
    expect(n.ok).toBe(false);
    expect(n.message).toBe('Cycle cycle-99 not found.');
    expect(s.message).toBe('Cycle cycle-99 not found.');
  });

  it('clean：双侧清理相同集合（数值序留新）', () => {
    for (const dir of [fixtureA, fixtureB]) {
      for (const num of [1, 2, 9, 10]) {
        const d = join(dir, '.cycles', 'archive', `cycle-${num}`);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'meta.json'), '{}');
      }
    }
    const s = runArchiveFlow(fixtureA, { clean: true, keep: 2, mode: 'script' });
    const n = runArchiveFlow(fixtureB, { clean: true, keep: 2, mode: 'native' });
    expect(s.ok).toBe(true);
    expect(n.ok).toBe(true);
    expect(n.affected).toEqual(['cycle-1', 'cycle-2']);
    expect(s.affected).toEqual(['cycle-1', 'cycle-2']);
    expect(readdirSync(join(fixtureA, '.cycles', 'archive')).sort()).toEqual(['cycle-10', 'cycle-9']);
    expect(readdirSync(join(fixtureB, '.cycles', 'archive')).sort()).toEqual(['cycle-10', 'cycle-9']);
  });
});
