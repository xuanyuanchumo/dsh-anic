/**
 * init-cycle ↔ workflow-state 联动契约（cycle-43 T-4302）。
 *
 * 根因背景：init-cycle.mjs 曾只建目录不写 .cycles/workflow-state.json，而
 * workflow-state.mjs 的 initState 仅在状态文件不存在时才重建——两脚本各管半边，
 * 导致本仓 currentCycle 漂移停在 cycle-26（cycle-27..41 直建目录的遗留债）。
 *
 * 承重断言（对技能真实脚本 execFileSync 黑盒驱动，非重实现）：
 *  - 新号前移：init 下一循环 → currentCycle 跟进（漂移根因不复发）
 *  - 同号幂等：重复 init 同号 → 状态文件不动（updatedAt 不变）
 *  - 旧号防回拉：--cycle 传旧号 → 状态机不动（数值序兜底）
 *  - 损坏 JSON → 重建（原子写守护在 fs-safe.mjs）
 *  - 全新工作区 → initState 形状（currentPhase=plan/nodeStatus={}）
 *  - 状态文件为 initState 标准键集（形状契约，防脚本演进漂移）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// 安装副本（.dsh/skills/...）是运行时真源；assets/skill 是发行源，二者由
// skillReplaceE2E / 技能完整性守卫保证同步。这里测安装副本=测用户实际跑的代码。
const SKILL_SCRIPT = resolve(import.meta.dirname, '../../.dsh/skills/ai-native-iteration-cycle/scripts/init-cycle.mjs');

let root: string;
const statePath = (): string => join(root, '.cycles', 'workflow-state.json');
const readState = (): Record<string, unknown> => JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>;
const runInit = (cycle?: number): void => {
  const args = cycle === undefined ? [SKILL_SCRIPT, root] : [SKILL_SCRIPT, root, '--cycle', String(cycle)];
  execFileSync('node', args, { stdio: 'pipe' });
};

function seedCycle(name: string): void {
  mkdirSync(join(root, '.cycles', 'cycles', name), { recursive: true });
}

function seedState(currentCycle: string): void {
  writeFileSync(statePath(), JSON.stringify({
    currentPhase: 'test', currentCycle, phaseHistory: [], nodeStatus: {},
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-initcycle-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('init-cycle → workflow-state 联动（T-4302 根因修复）', () => {
  it('新号前移：目录有 cycle-5、状态停在 cycle-3（漂移现场）→ init 下一号 → 前移到 cycle-6', () => {
    seedCycle('cycle-5');
    seedState('cycle-3');
    runInit();
    expect(readState().currentCycle).toBe('cycle-6');
  });

  it('同号幂等：重复 init 同号 → 状态文件字节不动（updatedAt 不变）', () => {
    seedCycle('cycle-6');
    seedState('cycle-6');
    const before = readFileSync(statePath(), 'utf8');
    runInit(6);
    expect(readFileSync(statePath(), 'utf8')).toBe(before);
  });

  it('旧号防回拉：--cycle 传旧号 → 状态机不动（数值序兜底）', () => {
    seedCycle('cycle-6');
    seedState('cycle-6');
    runInit(2);
    expect(readState().currentCycle).toBe('cycle-6');
  });

  it('损坏 JSON → 重建并指向新号（currentPhase 重置 plan）', () => {
    seedCycle('cycle-7');
    writeFileSync(statePath(), '{broken json');
    runInit(7);
    const s = readState();
    expect(s.currentCycle).toBe('cycle-7');
    expect(s.currentPhase).toBe('plan');
  });

  it('全新工作区（无状态文件）→ initState 形状：plan/cycle-N/空 history/空 nodeStatus 对象', () => {
    seedCycle('cycle-8');
    runInit(8);
    const s = readState();
    expect(s.currentCycle).toBe('cycle-8');
    expect(s.currentPhase).toBe('plan');
    expect(Array.isArray(s.phaseHistory)).toBe(true);
    expect(typeof s.nodeStatus).toBe('object');
    expect(s.nodeStatus).toEqual({});
  });

  it('状态文件为 initState 标准键集（形状契约——与 workflow-state.mjs initState 同形状）', () => {
    seedCycle('cycle-1');
    rmSync(statePath(), { force: true });
    runInit();
    expect(Object.keys(readState()).sort()).toEqual(
      ['createdAt', 'currentCycle', 'currentPhase', 'nodeStatus', 'phaseHistory', 'updatedAt'].sort(),
    );
  });

  it('联动写盘存在性：init 后 workflow-state.json 必在（此前根因正是缺失）', () => {
    seedCycle('cycle-1');
    runInit();
    expect(existsSync(statePath())).toBe(true);
  });
});
