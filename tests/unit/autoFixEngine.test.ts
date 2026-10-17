/**
 * autoFixEngine 单测 —— IO 层 + native 主循环（技能 auto-fix-loop.mjs 全语义）。
 * 真实 spawnSync（shell 内建 exit / node -e），夹具见 tests/helpers/autoFixWorkspace.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runTestCommand, readTestReports, runAutoFixNative, type AutoFixProgress,
} from '../../src/host/evolution/autoFixEngine.ts';
import {
  recordFixAttempt, recordAutoFixIncident, generateFixReport,
} from '../../src/host/evolution/autoFixReport.ts';
import { seedAutoFixWorkspace, PASSING_CMD, FAILING_CMD, transientCmd, testReportContent } from '../helpers/autoFixWorkspace.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-autofix-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('runTestCommand（技能 runCommand mjs:41-55）', () => {
  it('成功捕获输出；失败捕获 stderr 与 exitCode，不抛', () => {
    expect(runTestCommand(PASSING_CMD, dir).success).toBe(true);
    const f = runTestCommand(FAILING_CMD, dir);
    expect(f.success).toBe(false);
    expect(f.exitCode).toBe(1);
  });
});

describe('readTestReports（技能 mjs:57-77）', () => {
  it('解析 test-reports/*.md 三计数；目录缺失返回空', () => {
    const cycleDir = seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD, reports: [{ file: 'tr.md', content: testReportContent(5, 2, 1) }] });
    const reports = readTestReports(cycleDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ file: 'tr.md', failures: 2, errors: 1, passes: 5 });
    expect(readTestReports(join(dir, 'nope'))).toEqual([]);
  });
});

describe('recordFixAttempt（技能 mjs:142-158：只追加已存在文件）', () => {
  it('带表头直接追加 auto-fix-loop 行；无表头补「自动修复循环记录」头', () => {
    const cycleDir = seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD });
    recordFixAttempt(cycleDir, 1, [{ type: 'test-command-failure', detail: 'boom', exitCode: 1 }], false);
    let content = readFileSync(join(cycleDir, '审计日志.md'), 'utf-8');
    expect(content).toContain('| auto-fix-loop | FAIL | Attempt 1: test-command-failure: boom | 修复失败 |');

    rmSync(join(cycleDir, '审计日志.md'));
    // 文件不存在 → 不创建（技能同款静默跳过）
    recordFixAttempt(cycleDir, 2, [], true);
    expect(existsSync(join(cycleDir, '审计日志.md'))).toBe(false);
  });
});

describe('recordAutoFixIncident / generateFixReport（技能 mjs:160-200 逐字）', () => {
  it('incident 落盘含 CB1 与回退建议；报告含尝试记录与熔断节', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const p = recordAutoFixIncident(dir, 'Repeating failure (repeating) — structural root cause');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('熔断条件 CB1 触发：同一异常连续3次自动修复失败');
    expect(readFileSync(p, 'utf-8')).toContain('自主级别应回退：L4 → L3');

    const cycleDir = join(dir, '.cycles', 'cycles', 'cycle-1');
    const rp = generateFixReport(cycleDir, [{ success: false, failures: [{ type: 'test-command-failure', detail: 'boom', exitCode: 1 }], fixAction: 'Fix applied but failures remain' }], false);
    const report = readFileSync(rp, 'utf-8');
    expect(report).toContain('| 状态 | FAILED |');
    expect(report).toContain('- 识别的失败项: 1');
    expect(report).toContain('## 熔断');
  });
});

describe('runAutoFixNative 主循环（技能 mjs:231-341 逐字）', () => {
  it('无 test 命令（无 config 无参数）→ exit 1 响亮，不落任何文件', () => {
    mkdirOnlyCycles();
    const r = runAutoFixNative(dir, {});
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('No test command found');
    expect(existsSync(join(dir, '.cycles', 'incidents'))).toBe(false);
  });

  it('无 cycle 目录 → exit 1（init-cycle 提示）', () => {
    const r = runAutoFixNative(dir, { testCmd: PASSING_CMD });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('No cycle directory');
  });

  it('首轮全绿 → pass / exit 0 / 单条 success attempt + 审计 PASS 行 + SUCCESS 报告', () => {
    seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD });
    const r = runAutoFixNative(dir, {});
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toEqual([{ success: true, failures: [], fixAction: null }]);
    const log = readFileSync(join(dir, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    expect(log).toContain('| auto-fix-loop | PASS | Attempt 1:  | 修复成功 |');
    expect(readFileSync(r.reportPath ?? '', 'utf-8')).toContain('| 状态 | SUCCESS |');
  });

  it('恒败 maxRetries=3 → circuit / exit 2 / repeating 分析 + incident + FAILED 报告', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const r = runAutoFixNative(dir, { maxRetries: 3 });
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts.every((a) => !a.success)).toBe(true);
    expect(r.analysis?.pattern).toBe('repeating');
    expect(existsSync(r.incidentPath ?? '')).toBe(true);
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
    expect(readFileSync(r.reportPath ?? '', 'utf-8')).toContain('| 状态 | FAILED |');
  });

  it('恒败 maxRetries=1 → transient 分析（低频不判 repeating）', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const r = runAutoFixNative(dir, { maxRetries: 1 });
    expect(r.analysis?.pattern).toBe('transient');
  });

  it('瞬态失败（标记文件命令）→ retest 过 → fixSuccess 收敛 + 审计行如实记录', () => {
    const marker = join(dir, 'transient-marker.txt');
    seedAutoFixWorkspace(dir, { testCmd: transientCmd(marker), config: false });
    const r = runAutoFixNative(dir, { testCmd: transientCmd(marker), maxRetries: 2 });
    expect(r.verdict).toBe('pass');
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.fixAction).toBe('Fix applied and verified');
    const log = readFileSync(join(dir, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    expect(log).toContain('Attempt 1: test-command-failure:');
    expect(log).toContain('| 修复成功 |');
  });

  it('报告失败也被识别（命令过但 test-reports 有失败计数）→ circuit', () => {
    seedAutoFixWorkspace(dir, {
      testCmd: PASSING_CMD,
      reports: [{ file: 'test-report.md', content: testReportContent(5, 2, 0) }],
    });
    const r = runAutoFixNative(dir, { maxRetries: 1 });
    expect(r.verdict).toBe('circuit');
    expect(r.attempts[0]?.failures[0]?.type).toBe('test-report-failure');
  });

  it('onProgress 回调逐轮推送（首过无 failures / 恒败 fixSuccess=false）', () => {
    seedAutoFixWorkspace(dir, { testCmd: FAILING_CMD });
    const progress: AutoFixProgress[] = [];
    const r = runAutoFixNative(dir, { maxRetries: 2, onProgress: (p) => progress.push(p) });
    expect(r.verdict).toBe('circuit');
    expect(progress).toEqual([
      { attempt: 1, failures: 1, fixSuccess: false },
      { attempt: 2, failures: 1, fixSuccess: false },
    ]);
  });

  it('缺 config 但传 testCmd → 大声告警（warnings）且正常运行', () => {
    mkdirOnlyCycles();
    const r = runAutoFixNative(dir, { testCmd: PASSING_CMD });
    expect(r.verdict).toBe('pass');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('审计日志不存在时主循环仍完整运行（行记录静默跳过，报告照落）', () => {
    seedAutoFixWorkspace(dir, { testCmd: PASSING_CMD, auditLog: false });
    const r = runAutoFixNative(dir, {});
    expect(r.verdict).toBe('pass');
    expect(existsSync(r.reportPath ?? '')).toBe(true);
    expect(existsSync(join(dir, '.cycles', 'cycles', 'cycle-1', '审计日志.md'))).toBe(false);
  });
});

function mkdirOnlyCycles(): void {
  // 只建 .cycles（无 config.yml）+ cycle-1 —— 走 testCmd 参数兜底路径
  mkdirSync(join(dir, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
}
