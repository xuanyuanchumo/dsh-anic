/**
 * autoFixDifferential —— 孪生夹具差分契约（R3 阶段 5）。
 *
 * 修复循环是写动作（审计行 / incident / 报告），同目录双跑会双写——差分以
 * 孪生夹具完成：两份相同夹具各跑一侧（script spawn 真技能脚本 vs native
 * autoFixEngine），比对 verdict / exitCode / attempts 计数 / 副作用。
 *
 * 已文档化的刻意分歧（诚实纪律，不影响判定语义）：
 *  - script 侧 attempts 无结构化逐轮（黑盒 stdout 计数）；差分比对 attemptsCount
 *    而非 attempts 深比较。
 *  - script 侧不推 ITERATING 逐轮事件（同步黑盒）；差分不比对 events。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutoFixFlow } from '../../src/host/flows/autoFixFlow.ts';
import { seedAutoFixWorkspace, PASSING_CMD, FAILING_CMD, transientCmd, canonicalTestReportContent } from '../helpers/autoFixWorkspace.ts';

let fixtureA: string; // script 侧
let fixtureB: string; // native 侧

/** 孪生播种：对两份夹具执行同一播种函数。 */
function seedTwins(seed: (dir: string) => void): void {
  for (const d of [fixtureA, fixtureB]) seed(d);
}

beforeEach(() => {
  fixtureA = mkdtempSync(join(tmpdir(), 'anic-autofixdiff-a-'));
  fixtureB = mkdtempSync(join(tmpdir(), 'anic-autofixdiff-b-'));
});
afterEach(() => {
  rmSync(fixtureA, { recursive: true, force: true });
  rmSync(fixtureB, { recursive: true, force: true });
});

describe('auto-fix 孪生夹具差分（native vs script）', () => {
  it('全绿夹具：双侧 pass / exit 0 / attempts 数一致 —— 报告状态行一致', () => {
    seedTwins((d) => { seedAutoFixWorkspace(d, { testCmd: PASSING_CMD }); });
    const s = runAutoFixFlow(fixtureA, { mode: 'script' });
    const n = runAutoFixFlow(fixtureB, { mode: 'native' });
    expect(s.verdict).toBe('pass');
    expect(n.verdict).toBe('pass');
    expect(s.exitCode).toBe(n.exitCode);
    expect(s.state).toBe('CONVERGED');
    expect(n.state).toBe('CONVERGED');
    expect(n.attemptsCount).toBe(s.attemptsCount);
    // 副作用：双侧报告均 SUCCESS
    const reportA = readFileSync(join(fixtureA, '.cycles', 'cycles', 'cycle-1', 'test-reports', 'auto-fix-report.md'), 'utf-8');
    const reportB = readFileSync(join(fixtureB, '.cycles', 'cycles', 'cycle-1', 'test-reports', 'auto-fix-report.md'), 'utf-8');
    expect(reportA).toContain('| 状态 | SUCCESS |');
    expect(reportB).toContain('| 状态 | SUCCESS |');
  }, 60000);

  it('恒败夹具（maxRetries=3）：双侧 circuit / exit 2 / pattern 一致 —— incident 双侧落盘', () => {
    seedTwins((d) => { seedAutoFixWorkspace(d, { testCmd: FAILING_CMD }); });
    const s = runAutoFixFlow(fixtureA, { mode: 'script', maxRetries: 3 });
    const n = runAutoFixFlow(fixtureB, { mode: 'native', maxRetries: 3 });
    expect(s.verdict).toBe('circuit');
    expect(n.verdict).toBe('circuit');
    expect(s.exitCode).toBe(2);
    expect(n.exitCode).toBe(2);
    expect(s.state).toBe('CIRCUIT');
    expect(n.state).toBe('CIRCUIT');
    expect(n.pattern).toBe(s.pattern);
    expect(n.attemptsCount).toBe(s.attemptsCount);
    // incident 双侧落盘（native 回传路径；script 侧以目录存在性验证）
    expect(existsSync(n.incidentPath ?? '')).toBe(true);
    const incidentsA = readdirSync(join(fixtureA, '.cycles', 'incidents'));
    expect(incidentsA.some((f) => f.startsWith('incident-auto-fix-fail-'))).toBe(true);
    const reportB = readFileSync(join(fixtureB, '.cycles', 'cycles', 'cycle-1', 'test-reports', 'auto-fix-report.md'), 'utf-8');
    expect(reportB).toContain('| 状态 | FAILED |');
  }, 120000);

  it('瞬态失败夹具（标记命令）：双侧 pass（retest 修复验证）—— 审计行双侧一致', () => {
    // 孪生标记文件各在各夹具内（命令含绝对路径——对两份夹具分别构造）
    seedAutoFixWorkspace(fixtureA, { testCmd: transientCmd(join(fixtureA, 'marker.txt')), config: false });
    seedAutoFixWorkspace(fixtureB, { testCmd: transientCmd(join(fixtureB, 'marker.txt')), config: false });
    const cmdA = transientCmd(join(fixtureA, 'marker.txt'));
    const cmdB = transientCmd(join(fixtureB, 'marker.txt'));
    const s = runAutoFixFlow(fixtureA, { mode: 'script', testCmd: cmdA, maxRetries: 2 });
    const n = runAutoFixFlow(fixtureB, { mode: 'native', testCmd: cmdB, maxRetries: 2 });
    expect(s.verdict).toBe('pass');
    expect(n.verdict).toBe('pass');
    expect(s.state).toBe('CONVERGED');
    expect(n.state).toBe('CONVERGED');
    // 审计行：双侧各一条「修复成功」
    const logA = readFileSync(join(fixtureA, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    const logB = readFileSync(join(fixtureB, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    expect(logA.match(/\| auto-fix-loop \| PASS \|/g)).toHaveLength(1);
    expect(logB.match(/\| auto-fix-loop \| PASS \|/g)).toHaveLength(1);
  }, 120000);

  it('D-1103 正典管道表报告夹具（命令过 + 报告 3 失败）：双侧 circuit / exit 2 / repeating —— 报告通道双侧复活', () => {
    // 修复前双侧把 §2 管道表读成 0 → fail-open 判 pass/exit 0（假绿）；
    // 修复后 test-report-failure 通道生效：命令过但报告红 → 桩修复无效 →
    // 重试耗尽 → circuit（pattern=repeating：每轮同型 1 条 test-report-failure）。
    seedTwins((d) => {
      seedAutoFixWorkspace(d, {
        testCmd: PASSING_CMD,
        reports: [{ file: 'test-report.md', content: canonicalTestReportContent(10, 3, 0) }],
      });
    });
    const s = runAutoFixFlow(fixtureA, { mode: 'script', maxRetries: 3 });
    const n = runAutoFixFlow(fixtureB, { mode: 'native', maxRetries: 3 });
    // D-1103 修复钉：不再是 fail-open 的 pass
    expect(s.verdict).toBe('circuit');
    expect(n.verdict).toBe('circuit');
    expect(s.exitCode).toBe(2);
    expect(n.exitCode).toBe(2);
    expect(s.state).toBe('CIRCUIT');
    expect(n.state).toBe('CIRCUIT');
    expect(n.pattern).toBe('repeating');
    expect(s.pattern).toBe('repeating');
    expect(n.attemptsCount).toBe(s.attemptsCount);
    // incident 双侧落盘
    expect(existsSync(n.incidentPath ?? '')).toBe(true);
    expect(readdirSync(join(fixtureA, '.cycles', 'incidents')).some((f) => f.startsWith('incident-auto-fix-fail-'))).toBe(true);
  }, 120000);
});
