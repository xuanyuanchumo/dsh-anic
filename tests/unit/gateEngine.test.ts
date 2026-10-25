/**
 * gateEngine 单元（R3 阶段 2）—— G0-G3 原生判定 + 质量门三态 + 致命路径。
 *
 * fixture 形态对齐真实 cycle 工件（.cycles/cycles/cycle-1/…）。
 * 判定语义与 gate-check.mjs 同构（差分契约见 flowDifferential.test.ts）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkG0,
  checkG1,
  checkG2,
  checkG3,
  checkQualityGate,
  loadGateConfig,
  runNativeGateCheck,
} from '../../src/host/flows/gateEngine.ts';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anic-gate-engine-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(buildCmd: string, legacy = false): void {
  const dir = join(tmp, '.cycles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, legacy ? 'cycle-config.yml' : 'config.yml'), `autonomy_level: L2\nbuild_cmd: ${buildCmd}\n`);
}
function writeCycle(files: Record<string, string>, cycle = 'cycle-1'): string {
  const dir = join(tmp, '.cycles', 'cycles', cycle);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const EVAL_PASS = '| E1 | 意图 | PASS | x |\n| Q1 | 架构 | PASS | x |\n| Q5 | 复杂度 | PASS | x |';
const TASKS_DONE = '| T-01 | P0 | 任务 | 验证 | lead | 完成 |';
const TEST_SUMMARY = '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 10 |\n| 失败 | 0 |\n| 错误 | 0 |';

describe('loadGateConfig', () => {
  it('canonical 优先', () => {
    writeConfig('exit 0');
    const r = loadGateConfig(tmp);
    expect(r.fatal).toBeNull();
    expect(r.content).toContain('build_cmd');
  });
  it('legacy 文件名兼容（脚本侧打 DEPRECATED 告警，语义一致）', () => {
    writeConfig('exit 0', true);
    const r = loadGateConfig(tmp);
    expect(r.fatal).toBeNull();
    expect(r.content).toContain('build_cmd');
  });
  it('缺失 → fatal（脚本侧在任何门禁前 exit(1)）', () => {
    const r = loadGateConfig(tmp);
    expect(r.content).toBeNull();
    expect(r.fatal).toContain('No .cycles/config.yml found');
  });
});

describe('checkG0（评估报告裁决行）', () => {
  it('无 .cycles/cycles → FAIL: No .cycles directory', () => {
    expect(checkG0(tmp).detail).toBe('No .cycles directory');
  });
  it('无 cycle 目录 → FAIL: No cycle workspace', () => {
    mkdirSync(join(tmp, '.cycles', 'cycles'), { recursive: true });
    expect(checkG0(tmp).detail).toBe('No cycle workspace');
  });
  it('报告缺失 / 裁决行为零 → FAIL（存在性不是完整性）', () => {
    writeCycle({ '任务清单.md': TASKS_DONE });
    expect(checkG0(tmp).detail).toBe('No evaluation report');
    writeCycle({ '项目评估报告.md': '# 只有标题，没有裁决行\n| 维度 | 名称 | 结果 | 详情 |\n' });
    expect(checkG0(tmp).pass).toBe(false);
    expect(checkG0(tmp).detail).toContain('no dimension verdict rows');
  });
  it('有裁决行 → PASS 且 detail 含行数', () => {
    writeCycle({ '项目评估报告.md': EVAL_PASS });
    const r = checkG0(tmp);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('Evaluation report found in cycle-1 (3 dimension rows)');
  });
});

describe('checkG1（任务表）', () => {
  it('缺任务清单 / 无任务行 → FAIL', () => {
    writeCycle({ '项目评估报告.md': EVAL_PASS });
    // cycle-79 O-01：G1 detail 追加循环身份 §cycle-1（账本去重键必须自带循环）
    expect(checkG1(tmp).detail).toBe('No task list §cycle-1');
    writeCycle({ '项目评估报告.md': EVAL_PASS, '任务清单.md': '# 空清单\n| 任务 | 优先级 | 内容 | 方式 | 责任 | 状态 |\n' });
    expect(checkG1(tmp).pass).toBe(false);
    expect(checkG1(tmp).detail).toContain('No task entries found');
  });
  it('有未完成任务 → FAIL: N of M tasks not completed', () => {
    writeCycle({ '任务清单.md': '| T-01 | P0 | a | b | c | 完成 |\n| T-02 | P1 | a | b | c | 待办 |' });
    const r = checkG1(tmp);
    expect(r.pass).toBe(false);
    expect(r.detail).toBe('1 of 2 tasks not completed §cycle-1');
  });
  it('全完成 → PASS', () => {
    writeCycle({ '任务清单.md': TASKS_DONE });
    expect(checkG1(tmp)).toEqual({ pass: true, detail: 'All 1 tasks completed §cycle-1' });
  });
});

describe('checkG2（测试报告 §2 汇总表契约）', () => {
  it('无 test-reports 目录 / 无报告 → FAIL', () => {
    writeCycle({ '项目评估报告.md': EVAL_PASS });
    expect(checkG2(tmp).detail).toBe('No test reports directory §cycle-1');
    writeCycle({ '项目评估报告.md': EVAL_PASS, 'test-reports/.keep': '' });
    expect(checkG2(tmp).detail).toBe('No test reports §cycle-1');
  });
  it('汇总表不可识别 → FAIL（格式即契约，无证据 ≠ 通过）', () => {
    writeCycle({ 'test-reports/test-report.md': '自由文本，无汇总表' });
    const r = checkG2(tmp);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('summary not recognized');
  });
  it('失败/错误计数 >0 → FAIL: N failures, M errors', () => {
    writeCycle({ 'test-reports/test-report.md': '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 8 |\n| 失败 | 2 |\n| 错误 | 1 |' });
    // cycle-72：detail 必须回显致证报告名（正典选择可审计）
    // cycle-79 O-01：末尾追加 §cycle-1（循环身份进账本）
    expect(checkG2(tmp).detail).toBe('2 failures, 1 errors (test-report.md) §cycle-1');
  });
  it('零失败零错误 → PASS', () => {
    writeCycle({ 'test-reports/test-report.md': TEST_SUMMARY });
    expect(checkG2(tmp)).toEqual({ pass: true, detail: 'Zero failures, zero errors (test-report.md) §cycle-1' });
  });
});

describe('checkG3（build_cmd）', () => {
  it('未配置 → FAIL: No build command configured（无 cycle → 不追加循环身份）', () => {
    writeConfig('exit 0');
    expect(checkG3(tmp, null).detail).toBe('No build command configured');
  });
  it('exit 0 → PASS；exit 2 → FAIL（detail 逐字对齐脚本，含 §cycle-1）', () => {
    writeConfig('exit 0');
    writeCycle({ '任务清单.md': TASKS_DONE }); // 有 cycle-1 才有循环身份可追加
    expect(checkG3(tmp, loadGateConfig(tmp).content)).toEqual({ pass: true, detail: 'Build passed: exit 0 §cycle-1' });
    writeConfig('exit 2');
    expect(checkG3(tmp, loadGateConfig(tmp).content)).toEqual({ pass: false, detail: 'Build failed: exit 2 §cycle-1' });
  });
});

describe('checkQualityGate（三态：缺行/SKIP 都不能关门）', () => {
  it('无评估报告 → FAIL: No eval results', () => {
    expect(checkQualityGate(tmp, 'G0').detail).toContain('No cycle directory');
  });
  it('SKIP 行 / 行缺失 → unevaluated → FAIL（fail-open 禁止）', () => {
    writeCycle({ '项目评估报告.md': '| Q1 | 架构 | SKIP | 未评 |\n| Q5 | x | PASS | x |' });
    const r = checkQualityGate(tmp, 'G0');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Q1(SKIP)');
    // 行缺失形态
    writeCycle({ '项目评估报告.md': '| Q1 | 架构 | PASS | x |' });
    const r2 = checkQualityGate(tmp, 'G0');
    expect(r2.pass).toBe(false);
    expect(r2.detail).toContain('Q5(row absent)');
  });
  it('FAIL 行 → failed；全 PASS → passed（detail 逐字）', () => {
    writeCycle({ '项目评估报告.md': '| Q1 | 架构 | FAIL | x |\n| Q5 | x | PASS | x |' });
    expect(checkQualityGate(tmp, 'G0').detail).toBe('Quality dimensions failed: Q1');
    writeCycle({ '项目评估报告.md': EVAL_PASS });
    expect(checkQualityGate(tmp, 'G0')).toEqual({ pass: true, detail: 'Quality dimensions passed: Q1, Q5' });
  });
});

describe('runNativeGateCheck（编排）', () => {
  it('config 缺失 → fatal + 空判定 + exitCode 1（脚本 exit(1) 等价）', () => {
    const r = runNativeGateCheck(tmp);
    expect(r.gates).toEqual({});
    expect(r.allPass).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.fatal).toContain('No .cycles/config.yml found');
  });
  it('全绿工作区 → allPass + exitCode 0 + 质量门', () => {
    writeConfig('exit 0');
    writeCycle({
      '项目评估报告.md': '| E1 | 意图 | PASS | x |\n| Q1 | 架构 | PASS | x |\n| Q5 | x | PASS | x |\n| Q7 | x | PASS | x |\n| Q2 | x | PASS | x |\n| Q3 | x | PASS | x |\n| Q4 | x | PASS | x |',
      '任务清单.md': TASKS_DONE,
      'test-reports/test-report.md': TEST_SUMMARY,
    });
    const r = runNativeGateCheck(tmp, { gate: 'all', quality: true });
    expect(Object.keys(r.gates).sort()).toEqual(['G0', 'G1', 'G2', 'G3']);
    expect(r.allPass).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(r.quality).sort()).toEqual(['G0', 'G1', 'G2', 'G3']);
  });
  it('单门模式只跑该门；quality 只在门本身 PASS 时追加', () => {
    writeConfig('exit 0');
    writeCycle({ '任务清单.md': TASKS_DONE }); // G1 可过；G0 无报告（quality 不跑）
    const r = runNativeGateCheck(tmp, { gate: 'G0', quality: true });
    expect(Object.keys(r.gates)).toEqual(['G0']);
    expect(r.gates.G0?.pass).toBe(false);
    expect(r.quality).toEqual({}); // 门本身 FAIL → 不追加质量门
  });
  it('未知门号 → 跳过（HTTP 面比脚本 TypeError 更稳）', () => {
    writeConfig('exit 0');
    const r = runNativeGateCheck(tmp, { gate: 'G9' });
    expect(r.gates).toEqual({});
    expect(r.allPass).toBe(true); // 没有跑任何门 = 没有红（与脚本不同点：显式契约）
  });
  it('cycle-79 O-01：跨循环同结论 → G1/G2/G3 detail 不同（循环身份使旧去重键失效）', () => {
    writeConfig('exit 0');
    const green = { '项目评估报告.md': EVAL_PASS, '任务清单.md': TASKS_DONE, 'test-reports/test-report.md': TEST_SUMMARY };
    writeCycle(green, 'cycle-1');
    const c1 = runNativeGateCheck(tmp, { gate: 'all' }).gates;
    writeCycle(green, 'cycle-2'); // 数值序最新 = cycle-2
    const c2 = runNativeGateCheck(tmp, { gate: 'all' }).gates;
    for (const g of ['G1', 'G2', 'G3']) {
      expect(c1[g]?.detail).toContain('§cycle-1');
      expect(c2[g]?.detail).toContain('§cycle-2');
      expect(c1[g]?.detail).not.toBe(c2[g]?.detail); // 去重键 (result, detail) 因此必然不同
    }
    // G0 例外：循环身份已在 detail 文本内（无 § 段），且随循环变化
    expect(c1.G0?.detail).toContain('cycle-1');
    expect(c2.G0?.detail).toContain('cycle-2');
    expect(c1.G0?.detail).not.toContain('§');
  });
});
