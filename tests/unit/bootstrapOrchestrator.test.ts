/**
 * M10-b 自举链编排器测试。
 *
 * 验证 runSelfBootstrapCycle 连通 eval → gate → fix 自动驱动链：
 * - 完整循环执行（eval + gate + fix 各步 FlowTracker 记录）
 * - 收敛判定（gate PASS → CONVERGED）
 * - 耗尽判定（maxRounds → EXHAUSTED）
 * - 状态持久化（self-bootstrap.json）
 * - 解析函数正确性
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoInstallSkill } from '../../src/host/skillInvoker.ts';
import {
  runSelfBootstrapCycle,
} from '../../src/host/runtime/bootstrapOrchestrator.ts';
import {
  parseEvalScore,
  parseGateVerdict,
  parseFixApplied,
} from '../../src/host/runtime/scriptParsers.ts';
import { checkBootstrapPreconditions, hasCycleDir } from '../../src/host/runtime/bootstrapPreflight.ts';
import { loadBootstrapState } from '../../src/host/selfBootstrap.ts';
import { loadFlowTracker, flowStats } from '../../src/host/runtime/flowTracker.ts';

let tempDir: string;
let workspace: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'boot-orch-'));
  workspace = join(tempDir, 'project');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 补齐自举前置（cycle-72）：config.yml + 一个 cycle-N/ 目录。
 *
 * 本文件的「端到端」用例要测**编排语义**（轮次推进 / 记账 / re-gate 环），
 * 因此必须先把环境准备好。旧版用例故意留空前置，靠「脚本入口即死 → 解析成
 * unknown」来观察 fail-closed——那恰好是本轮修复的缺陷形态（把缺前置折叠成
 * 裁决）。前置缺失本身另有专测（见下方 preflight 组）。
 */
function withPrereqs(): void {
  mkdirSync(join(workspace, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(workspace, '.cycles', 'config.yml'),
    'build_cmd: "echo build"\ntest_cmd: "echo ok"\nlint_cmd: "echo lint"\n', 'utf8');
}

// ── 解析器：按真实脚本输出契约（cycle-96 重写）──
// 以下 fixture 逐行转录自 assets/skill/scripts/ 的真实 console 语句，
// 不是"代码期望什么就写什么"——旧测试正是这样断言了虚构格式才放行恒错解析器。

describe('parseEvalScore — eval-runner.mjs 真实输出', () => {
  it('全部通过（exit 0 路径，:498+:515）→ 1', () => {
    const stdout = [
      'Evaluation report written to D:\\ws\\.cycles\\cycles\\cycle-95\\项目评估报告.md',
      '',
      'All 8 evaluated dimension(s) passed.',
    ].join('\n');
    expect(parseEvalScore({ stdout, stderr: '' })).toBe(1);
  });

  it('全部通过但带 SKIP 行（:515+:517）→ 1（已评估维度全过）', () => {
    const stdout = [
      'All 5 evaluated dimension(s) passed.',
      '3 dimension(s) SKIPPED (not evaluated, NOT pass): E5, E6, E7',
    ].join('\n');
    expect(parseEvalScore({ stdout, stderr: '' })).toBe(1);
  });

  it('全 SKIP 的空洞运行（"All 0 evaluated … passed."）→ 1，与脚本退出码语义一致', () => {
    // 脚本对全 SKIP 判 exit 0（失败只由 FAIL 决定，eval-runner.mjs:504-506）；
    // 解析器忠实转录脚本裁决，SKIP 的响亮清单已在 stdout，不由分数承担。
    expect(parseEvalScore({ stdout: 'All 0 evaluated dimension(s) passed.', stderr: '' })).toBe(1);
  });

  it('有失败维度（失败清单在 stderr，:509）→ 0', () => {
    const stdout = 'Evaluation report written to D:\\ws\\.cycles\\cycles\\cycle-95\\项目评估报告.md';
    const stderr = '\n3 dimension(s) failed: E3, E8, Q8';
    expect(parseEvalScore({ stdout, stderr })).toBe(0);
  });

  it('失败清单只看 stderr：stdout 同文本不误判（契约就是 stderr 行）', () => {
    // 防倒退：如果把解析改回只喂 stdout，此用例红——失败证据在 stderr，
    // 这正是旧调用 parseEvalScore(result.stdout) 丢裁决的机制。
    expect(parseEvalScore({ stdout: '3 dimension(s) failed: E3', stderr: '' })).toBe(0);
    expect(parseEvalScore({ stdout: '', stderr: '2 dimension(s) failed: E3, Q8' })).toBe(0);
  });

  it('旧虚构格式 "Overall score: 0.875" 不再匹配 → 0', () => {
    // 防倒退：真实脚本从不输出该行；旧解析器正是按它写的
    expect(parseEvalScore({ stdout: 'Overall score: 0.875', stderr: '' })).toBe(0);
  });

  it('输出不可识别 → 0', () => {
    expect(parseEvalScore({ stdout: 'no recognizable output', stderr: '' })).toBe(0);
  });
});

describe('parseGateVerdict — gate-check.mjs 真实输出', () => {
  it('全部通过（逐门禁行 + :228 总裁决行）→ PASS', () => {
    const stdout = [
      '[PASS] G0: Evaluation report found in cycle-95 (16 dimension rows)',
      '  [LEDGER] G0 PASS recorded (hash c9d448ba8ed100ea...)',
      '[PASS] G1: All 12 tasks completed',
      '  [PASS] G0-Quality: x',
      '',
      'All gates PASSED.',
    ].join('\n');
    expect(parseGateVerdict({ stdout, stderr: '' })).toBe('PASS');
  });

  it('有门禁失败（[FAIL] 行 + :225 stderr 总裁决行）→ FAIL', () => {
    const stdout = [
      '[PASS] G0: Evaluation report found in cycle-95 (16 dimension rows)',
      '[FAIL] G1: 2 of 5 tasks not completed',
      '  [LEDGER] G1 FAIL recorded (hash 1a2b3c4d5e6f7890...)',
    ].join('\n');
    const stderr = '\nGate check FAILED. Fix issues before proceeding.';
    expect(parseGateVerdict({ stdout, stderr })).toBe('FAIL');
  });

  it('质量门禁失败也判 FAIL（:219 缩进行 + :220 拉低总裁决）', () => {
    const stdout = [
      '[PASS] G0: Evaluation report found in cycle-95 (16 dimension rows)',
      '  [FAIL] G0-Quality: SKIP dimensions present',
    ].join('\n');
    expect(parseGateVerdict({ stdout, stderr: '' })).toBe('FAIL');
  });

  it('部分门禁运行（--gate G1，无总裁决行）→ 逐门禁行兜底', () => {
    expect(parseGateVerdict({ stdout: '[PASS] G1: All 5 tasks completed', stderr: '' })).toBe('PASS');
    expect(parseGateVerdict({ stdout: '[FAIL] G1: No task list', stderr: '' })).toBe('FAIL');
  });

  it('LEDGER 行不参与裁决（前缀是 [LEDGER] 非 [PASS]/[FAIL]）', () => {
    const stdout = '  [LEDGER] G0 unchanged, not re-recorded';
    expect(parseGateVerdict({ stdout, stderr: '' })).toBe('unknown');
  });

  it('旧虚构格式 "GATE: PASS" 不再匹配 → unknown', () => {
    expect(parseGateVerdict({ stdout: 'GATE: PASS', stderr: '' })).toBe('unknown');
    expect(parseGateVerdict({ stdout: 'Overall: FAIL', stderr: '' })).toBe('unknown');
  });

  it('输出不可识别 → unknown', () => {
    expect(parseGateVerdict({ stdout: '', stderr: '' })).toBe('unknown');
  });
});

describe('parseFixApplied — auto-fix-loop.mjs 真实输出', () => {
  it('无需修复（:244）→ null', () => {
    const stdout = [
      '=== Auto-Fix Loop ===',
      'Project: D:\\ws',
      'Cycle: cycle-95',
      'Test command: pnpm run test',
      'Max retries: 3',
      '',
      '--- Attempt 1/3 ---',
      'Running test command: pnpm run test',
      'All tests passed. No fixes needed.',
    ].join('\n');
    expect(parseFixApplied({ stdout, stderr: '' })).toBeNull();
  });

  it('修复成功（:251-253 清单 + :274 验证行）→ 带失败清单的描述', () => {
    const stdout = [
      '--- Attempt 1/3 ---',
      'Running test command: pnpm run test',
      'Identified 2 failure(s):',
      '  - typecheck: 6 failures, 0 errors',
      '  - lint: 2 failures, 0 errors',
      'AI should diagnose root cause and apply fix...',
      '  (In L4 autonomous mode, AI will analyze failures and modify code/tests)',
      '  Re-running verification after fix...',
      'Fix successful. All tests now pass.',
    ].join('\n');
    expect(parseFixApplied({ stdout, stderr: '' })).toBe(
      '修复并通过: typecheck: 6 failures, 0 errors; lint: 2 failures, 0 errors',
    );
  });

  it('多次尝试取最后一次 Identified 清单（前面尝试的失败可能已被修复）', () => {
    const stdout = [
      '--- Attempt 1/3 ---',
      'Identified 1 failure(s):',
      '  - typecheck: 6 failures, 0 errors',
      'Fix attempt 1 failed. 1 failure(s) remain.',
      '--- Attempt 2/3 ---',
      'Identified 1 failure(s):',
      '  - lint: 2 failures, 0 errors',
      '  Re-running verification after fix...',
      'Fix successful. All tests now pass.',
    ].join('\n');
    expect(parseFixApplied({ stdout, stderr: '' })).toBe('修复并通过: lint: 2 failures, 0 errors');
  });

  it('修复成功但无清单（防御路径）→ 字面裁决行', () => {
    expect(parseFixApplied({ stdout: 'Fix successful. All tests now pass.', stderr: '' }))
      .toBe('Fix successful. All tests now pass.');
  });

  it('修复未通过（:280）→ null', () => {
    const stdout = [
      '--- Attempt 3/3 ---',
      'Identified 1 failure(s):',
      '  - typecheck: 6 failures, 0 errors',
      'Fix attempt 3 failed. 1 failure(s) remain.',
      '=== Phase: Failure Pattern Analysis & Root Cause Assessment ===',
    ].join('\n');
    expect(parseFixApplied({ stdout, stderr: '' })).toBeNull();
  });

  it('旧虚构格式 "Applied: fix-typecheck" 不再匹配 → null', () => {
    expect(parseFixApplied({ stdout: 'Applied: fix-typecheck', stderr: '' })).toBeNull();
  });
});

describe('runSelfBootstrapCycle — 端到端', () => {
  it('完整循环执行且状态持久化', () => {
    autoInstallSkill(workspace);
    withPrereqs();
    const result = runSelfBootstrapCycle(workspace, 2, 30000);

    // 状态持久化
    const cyclesDir = join(workspace, '.cycles');
    const persisted = loadBootstrapState(cyclesDir);
    expect(persisted.status).toBe(result.state.status);
    expect(persisted.round).toBe(result.state.round);

    // self-bootstrap.json 落盘
    expect(existsSync(join(cyclesDir, 'self-bootstrap.json'))).toBe(true);

    // 至少执行了一轮
    expect(result.rounds.length).toBeGreaterThanOrEqual(1);
    expect(result.precondition).toBeUndefined(); // 前置已补齐 → 真实跑了
    // cycle-72：前置齐全后脚本真正走到裁决（旧用例靠"缺前置 → 入口即死 →
    // unknown"观察 fail-closed，那正是本轮修复的折叠缺陷）。此处断言的是
    // **真实裁决**：临时工作区无源码/工件 → 存在失败维度，解析器如实报 0，
    // 门禁如实报 FAIL。两个值都来自脚本输出，不再来自"脚本没跑成"。
    expect(result.rounds[0].evalScore).toBe(0);
    expect(['FAIL', 'unknown']).toContain(result.rounds[0].gateVerdict);
  });

  it('FlowTracker 记录每步调用', () => {
    autoInstallSkill(workspace);
    withPrereqs();
    const result = runSelfBootstrapCycle(workspace, 1, 30000);

    const cyclesDir = join(workspace, '.cycles');
    const trackerState = loadFlowTracker(cyclesDir);
    const stats = flowStats(trackerState);

    // 至少有 eval-runner 和 gate-check 的记录
    expect(stats['eval-runner']).toBeDefined();
    expect(stats['eval-runner'].total).toBeGreaterThanOrEqual(1);
    expect(stats['gate-check']).toBeDefined();
    expect(stats['gate-check'].total).toBeGreaterThanOrEqual(1);

    // 每轮有 flowId（cycle-72：四个流 ID 全部不得丢失）
    const r = result.rounds[0];
    expect(r.evalFlowId).toBeDefined();
    expect(r.gateFlowId).toBeDefined();
    // 门禁未过 → 走 fix + 复检环 → fix/复检两个 flowId 也必须暴露
    expect(r.fixFlowId).toBeDefined();
    expect(r.verifyFlowId).toBeDefined();
    // 且四个 ID 互不相同（同一 ID 复用会掩盖"某一步没跑"）
    expect(new Set([r.evalFlowId, r.gateFlowId, r.fixFlowId, r.verifyFlowId]).size).toBe(4);
  });

  it('maxRounds 限制生效', () => {
    autoInstallSkill(workspace);
    withPrereqs();
    const result = runSelfBootstrapCycle(workspace, 1, 30000);
    expect(result.state.round).toBeLessThanOrEqual(1);
    // 一轮后要么 CONVERGED 要么 EXHAUSTED
    expect(['CONVERGED', 'EXHAUSTED']).toContain(result.state.status);
  });

  it('cycle-38 re-gate 环：门禁未过 → fix → VERIFYING 真实重跑 gate-check（复检非伪造）', () => {
    autoInstallSkill(workspace);
    // cycle-72：前置齐全 → 门禁真正裁决（FAIL）→ 走 fix 分支 → fix-done 进
    // VERIFYING → 复检再跑一次 gate-check。旧用例靠"缺前置入口即死"触发同一
    // 分支，但那同时把入口拒绝伪装成了裁决；现在分支由**真实 FAIL**触发。
    withPrereqs();
    const result = runSelfBootstrapCycle(workspace, 1, 30000);

    const cyclesDir = join(workspace, '.cycles');
    const stats = flowStats(loadFlowTracker(cyclesDir));
    // 复检的机器证据：gate-check 调用数 ≥ 2（首次裁决 + 复检各一次）
    expect(stats['gate-check']).toBeDefined();
    expect(stats['gate-check'].total).toBeGreaterThanOrEqual(2);
    // 复检仍未过（同一失败形态）→ 不伪造 CONVERGED（fail-closed 结算）
    expect(result.state.status).not.toBe('CONVERGED');
    // 结算用的裁决如实来自解析器（FAIL/unknown → 未通过）——不因"跑过复检"而放行
    expect(['unknown', 'FAIL'].includes(result.rounds[0]?.gateVerdict ?? '')).toBe(true);
  });
});

/**
 * 前置守卫契约（cycle-72 P0）。
 *
 * 这是本轮修复的核心断言面：**缺前置不得被折叠成裁决**。因此必须在
 * 「动作之前」拦下——返回空 rounds、不动状态、不产提案，并给出修复指引。
 */
describe('checkBootstrapPreconditions — 前置守卫', () => {
  it('技能目录未解析 → SKILL_NOT_INSTALLED（指引 anic_install）', () => {
    const r = checkBootstrapPreconditions(null, join(workspace, '.cycles'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SKILL_NOT_INSTALLED');
      expect(r.remedy).toContain('anic_install');
    }
  });

  it('缺 config.yml → CONFIG_MISSING（指引 init-workflow）', () => {
    mkdirSync(join(workspace, '.cycles'), { recursive: true });
    const r = checkBootstrapPreconditions('/fake/scripts', join(workspace, '.cycles'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CONFIG_MISSING');
      expect(r.remedy).toContain('init-workflow');
    }
  });

  it('兼容旧名 cycle-config.yml（与 scripts/lib/config.mjs 同一口径，不假报缺）', () => {
    mkdirSync(join(workspace, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
    writeFileSync(join(workspace, '.cycles', 'cycle-config.yml'), 'test_cmd: "echo ok"\n', 'utf8');
    const r = checkBootstrapPreconditions('/fake/scripts', join(workspace, '.cycles'));
    expect(r.ok).toBe(true);
  });

  it('有 config 无 cycle 目录 → CYCLE_DIR_MISSING（指引 init-cycle）', () => {
    mkdirSync(join(workspace, '.cycles'), { recursive: true });
    writeFileSync(join(workspace, '.cycles', 'config.yml'), 'test_cmd: "echo ok"\n', 'utf8');
    const r = checkBootstrapPreconditions('/fake/scripts', join(workspace, '.cycles'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CYCLE_DIR_MISSING');
      expect(r.remedy).toContain('init-cycle');
    }
  });

  it('hasCycleDir 只认 cycle-<数字>（cycle-abc 不算证据）', () => {
    const cyclesDir = join(workspace, '.cycles');
    mkdirSync(join(cyclesDir, 'cycles', 'cycle-abc'), { recursive: true });
    expect(hasCycleDir(cyclesDir)).toBe(false);
    mkdirSync(join(cyclesDir, 'cycles', 'cycle-3'), { recursive: true });
    expect(hasCycleDir(cyclesDir)).toBe(true);
  });

  it('前置未就绪时编排器零动作：rounds 为空、无提案、状态文件未写', () => {
    autoInstallSkill(workspace);
    // 不调 withPrereqs()：故意留空前置
    const result = runSelfBootstrapCycle(workspace, 2, 30000);

    expect(result.rounds).toEqual([]);
    expect(result.converged).toBe(false);
    expect(result.precondition?.code).toBe('CONFIG_MISSING');
    // 关键：旧行为会写 round-N.json 的 0 分提案，这里必须什么都不产
    expect(existsSync(join(workspace, '.cycles', 'tech-debt'))).toBe(false);
    expect(existsSync(join(workspace, '.cycles', 'self-bootstrap.json'))).toBe(false);
  });
});
