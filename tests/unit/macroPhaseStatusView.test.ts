/**
 * 宏观相位只读视图直测（cycle-96 WS-A · `macroPhaseStatusView.ts`）。
 *
 * ## 为什么单独一个单元测试（而契约测试已覆盖脚本侧）
 *
 * 契约测试驱动的是**技能脚本**（status/check 不写盘）。宿主侧是另一条实现
 * （native 侧 `loadMacroState` + 工件推断），它的「不写盘」必须**独立**证明：
 * 两处若只有一处守纪律，观测仍然会改变被观察对象。
 *
 * ## 两条承重断言
 *
 * ① **不落盘**：视图前后 `.cycles/workflow-state.json` 逐字节相等
 *    —— 且**工件推断确实跑过**（inferredPhase 有值），否则「不写」可能只是「没算」。
 * ② **推断到顶**：deploy/maintain 没有工件指纹 ⇒ inferred 必然停在 test。
 *    视图必须给出 `inferenceCeiling`，否则消费方会把「推不出来」误读成「状态错了」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMacroPhaseStatus, inferMacroPhaseFromArtifacts, readCycleArtifacts, INFERENCE_CEILING,
} from '../../src/host/flows/macroPhaseStatusView.ts';
import { loadMacroState, advanceMacro } from '../../src/host/flows/macroPhaseEngine.ts';
import { statusMacroPhase } from '../../src/host/flows/macroPhaseFlow.ts';

let tmp = '';
const statePath = (): string => join(tmp, '.cycles', 'workflow-state.json');
const cycleDir = (): string => join(tmp, '.cycles', 'cycles', 'cycle-1');

beforeEach(() => {
  tmp = join(tmpdir(), `anic-macro-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, '.cycles'), { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedState(currentPhase: string): void {
  writeFileSync(statePath(), JSON.stringify({
    currentPhase, currentCycle: 'cycle-1', phaseHistory: [], nodeStatus: {},
    createdAt: 't', updatedAt: 't',
  }));
}

/** 全套工件 ⇒ inferPhase 判 test。 */
function seedArtifactsToTest(): void {
  mkdirSync(join(cycleDir(), 'test-reports'), { recursive: true });
  for (const f of ['项目评估报告.md', '当前循环总规划.md', '任务清单.md']) writeFileSync(join(cycleDir(), f), 'x');
  writeFileSync(join(cycleDir(), 'test-reports', 'r.md'), 'x');
}

describe('工件推断（与技能 inferPhase 逐字同款）', () => {
  it('四档判据：eval→plan / plan→design / tasks→build / testReports→test', () => {
    expect(inferMacroPhaseFromArtifacts({ eval: true })).toBe('plan');
    expect(inferMacroPhaseFromArtifacts({ eval: true, plan: true })).toBe('design');
    expect(inferMacroPhaseFromArtifacts({ plan: true, tasks: true })).toBe('build');
    expect(inferMacroPhaseFromArtifacts({ tasks: true, testReports: true })).toBe('test');
    // 空工件 → plan（技能兜底同款）
    expect(inferMacroPhaseFromArtifacts({})).toBe('plan');
  });

  it('反向自检：testReports=true 但 tasks 缺席 ⇒ 仍是 test（证明判据顺序真的按技能表）', () => {
    // 若有人把判据改成「前置工件必须全在」，这条会掉到 plan —— 那就是与技能分叉。
    expect(inferMacroPhaseFromArtifacts({ testReports: true })).toBe('test');
  });

  it('**空 test-reports 目录不算测试工件**（建了目录还没写报告 ≠ 已进测试相）', () => {
    mkdirSync(join(cycleDir(), 'test-reports'), { recursive: true });
    const a = readCycleArtifacts(tmp, 'cycle-1');
    expect(a['testReports']).toBe(false);
    expect(inferMacroPhaseFromArtifacts(a)).toBe('plan');
  });

  it('cycle 为 null / 目录不存在 → 空表（不猜、不抛）', () => {
    expect(readCycleArtifacts(tmp, null)).toEqual({});
    expect(readCycleArtifacts(tmp, 'cycle-99')).toEqual({});
  });
});

describe('① 不落盘（宿主侧独立证明）', () => {
  it('**漂移夹具 + statusMacroPhase → 状态文件逐字节不变，但 inferred 有值**', () => {
    seedState('plan');
    seedArtifactsToTest();
    const before = readFileSync(statePath(), 'utf-8');
    const view = statusMacroPhase(tmp);
    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
    // 关键：不写 ≠ 没算 —— inferred 必须真的推出来了
    expect(view.inferredPhase).toBe('test');
    expect(view.currentPhase).toBe('plan');
    expect(view.drift).toBe(true);
    expect(view.wroteState).toBe(false);
  });

  it('对照：advanceMacro 才会写盘（写者存在 ⇒ ① 的绿灯有意义）', () => {
    seedState('plan');
    seedArtifactsToTest();
    mkdirSync(join(tmp, '.cycles', 'gates'), { recursive: true });
    writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
      entries: [{ gate: 'G0', gateName: 'G0', result: 'PASS', detail: 'd', timestamp: 't', previousHash: '', hash: 'h' }],
      chainHead: 'h',
    }));
    const before = readFileSync(statePath(), 'utf-8');
    // 直接调引擎（写路径），断言它**确实改盘** —— 与上面「视图不改盘」形成对照。
    expect(advanceMacro(tmp).ok).toBe(true);
    expect(readFileSync(statePath(), 'utf-8')).not.toBe(before);
    expect((JSON.parse(readFileSync(statePath(), 'utf-8')) as { currentPhase: string }).currentPhase).toBe('design');
  });
});

describe('② 推断到顶（deploy/maintain 没有工件指纹）', () => {
  it('stored=deploy + 全套测试工件 ⇒ inferred=test 且 ceiling 如实', () => {
    seedState('deploy');
    seedArtifactsToTest();
    const view = statusMacroPhase(tmp);
    expect(view.currentPhase).toBe('deploy');
    expect(view.inferredPhase).toBe('test');
    expect(view.drift).toBe(true);
    // 上限必须随响应一起给：否则消费方无法区分「真分叉」与「推断到顶」
    expect(view.inferenceCeiling).toBe(INFERENCE_CEILING);
    expect(INFERENCE_CEILING).toBe('test');
  });

  it('stored=maintain 同款（末相）', () => {
    seedState('maintain');
    seedArtifactsToTest();
    const view = statusMacroPhase(tmp);
    expect(view.inferredPhase).toBe('test');
    expect(view.currentPhase).toBe('maintain');
  });
});

describe('③ 无状态文件：三字段全 null（不伪造 plan）', () => {
  it('projectionSeeded=false 且 drift=null（不是 false）', () => {
    const view = statusMacroPhase(tmp);
    expect(view.currentPhase).toBeNull();
    expect(view.inferredPhase).toBeNull();
    // null ≠ false：false 会被面板画成「一致」，而这里根本无从比较
    expect(view.drift).toBeNull();
    expect(view.projectionSeeded).toBe(false);
    expect(view.gates).toEqual([]);
  });

  it('**视图不得创建状态文件**（查询不产生新事实）', () => {
    expect(existsSync(statePath())).toBe(false);
    statusMacroPhase(tmp);
    expect(existsSync(statePath())).toBe(false);
    expect(loadMacroState(tmp)).toBeNull();
  });
});

describe('④ 字段向后兼容（旧消费方只读 currentPhase/gates 不受影响）', () => {
  it('既有字段与顺序语义保持：currentPhase / phaseName / gates', () => {
    seedState('build');
    mkdirSync(join(tmp, '.cycles', 'gates'), { recursive: true });
    writeFileSync(join(tmp, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
      entries: [
        { gate: 'G1', gateName: 'G1', result: 'FAIL', detail: 'd', timestamp: 't0', previousHash: '', hash: 'h0' },
        { gate: 'G1', gateName: 'G1', result: 'PASS', detail: 'd', timestamp: 't1', previousHash: 'h0', hash: 'h1' },
      ],
      chainHead: 'h1',
    }));
    const view = statusMacroPhase(tmp);
    expect(view.currentPhase).toBe('build');
    expect(view.phaseName).toBe('Build（构建）');
    // 技能 cmdStatus 展示序：曾 PASS 优先于曾 FAIL（既有语义不得因本轮扩展而变）
    expect(view.gates).toEqual([{ gate: 'G1', status: 'PASS' }]);
  });
});
