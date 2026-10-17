/**
 * autoFixEngine —— 自动修复循环 IO 层 + native 编排（技能 auto-fix-loop.mjs 逐字对齐）。
 *
 * 技能语义基准（assets/skill/scripts/auto-fix-loop.mjs）：
 *  - runCommand（mjs:41-55）：shell 执行，120s 超时，失败不抛（捕获 stdout/stderr/exitCode）
 *  - readTestReports（mjs:57-77）：.cycles/cycles/<cycle>/test-reports/*.md 计数解析
 *  - 落盘三件（recordFixAttempt / recordCircuitBreaker / generateFixReport）拆至
 *    autoFixReport.ts（T3 行数纪律；技能 mjs:142-200 逐字）
 *  - 主循环（mjs:231-341）：每轮 test → 识别失败 → retest（脚本侧 L4 桩——同步脚本
 *    无 AI 介入窗口，真修复在对话层完成后再调本流程）→ 判定；耗尽后失败模式分析
 *    （核心原则：不可直接降级/熔断，先评估研究找根因）→ incident → 建议回退。
 *
 * 插件侧纪律：
 *  - 配置走 loadWorkspaceConfig 唯一入口（INV-25）；缺配置大声说但不致命
 *    （--test-cmd 兜底，技能 mjs:23-35 同语义）
 *  - spawnSync + sanitizeEnv（R19 子进程环境清洗）+ shell 解析（execSync 同款）
 *  - latestCycleDir 返回完整路径（gateEngine.ts:44 陷阱注记同款）——直接 join 子路径
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEnv } from '../../adapters/index.ts';
import { loadWorkspaceConfig } from '../config.ts';
import { latestCycleDir } from '../llm/gateEvidence.ts';
import { recordFixAttempt, recordAutoFixIncident, generateFixReport } from './autoFixReport.ts';
import {
  analyzeFailurePattern, identifyFailures,
  type FailureAnalysis, type FixAttempt, type TestCommandResult, type TestReportSummary,
} from './autoFixAnalyze.ts';

export const DEFAULT_MAX_RETRIES = 3;
export const AUTO_FIX_TEST_TIMEOUT_MS = 120000;

export interface AutoFixLoopResult {
  /** pass=exit 0（收敛）；circuit=exit 2（重试耗尽熔断）。exit 1 是前置错误，走 error 字段。 */
  verdict: 'pass' | 'circuit';
  exitCode: 0 | 1 | 2;
  testCmd: string;
  maxRetries: number;
  attempts: FixAttempt[];
  analysis: FailureAnalysis | null;
  incidentPath: string | null;
  reportPath: string | null;
  suggestedNextStep: 'autonomy-fallback' | null;
  /** 前置错误（无 test 命令 / 无 cycle 目录）——技能 exit 1 语义，不推进状态机。 */
  error?: string;
  /** 配置告警（缺 config.yml 大声说——技能 mjs:32 同语义）。 */
  warnings: string[];
}

/** shell 执行测试命令（技能 runCommand mjs:41-55 逐字：捕获输出、失败不抛）。 */
export function runTestCommand(cmd: string, cwd: string, timeoutMs = AUTO_FIX_TEST_TIMEOUT_MS): TestCommandResult {
  try {
    const r = spawnSync(cmd, {
      cwd, timeout: timeoutMs, encoding: 'utf-8', shell: true, env: sanitizeEnv(),
      windowsHide: true,
    });
    if (r.status === 0) return { success: true, output: (r.stdout ?? '') + (r.stderr ?? '') };
    return {
      success: false,
      output: r.stdout ? r.stdout.toString() : '',
      error: r.stderr ? r.stderr.toString().trim() : `exit ${r.status ?? 'unknown'}`,
      exitCode: r.status ?? undefined,
    };
  } catch (e) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e), exitCode: undefined };
  }
}

/** 读测试报告目录（技能 readTestReports mjs:57-77：*.md 中文三计数解析）。 */
export function readTestReports(cycleDir: string): TestReportSummary[] {
  const testReportsDir = join(cycleDir, 'test-reports');
  if (!existsSync(testReportsDir)) return [];
  const reports: TestReportSummary[] = [];
  const files = readdirSync(testReportsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const content = readFileSync(join(testReportsDir, file), 'utf-8');
    const { failures, errors, passes } = parseReportCounts(content);
    reports.push({ file, failures, errors, passes, content });
  }
  return reports;
}

function parseReportCounts(content: string): { failures: number; errors: number; passes: number } {
  const failMatch = content.match(/失败[：:]\s*(\d+)/);
  const errorMatch = content.match(/错误[：:]\s*(\d+)/);
  const passMatch = content.match(/通过[：:]\s*(\d+)/);
  return {
    failures: failMatch ? parseInt(failMatch[1]!, 10) : 0,
    errors: errorMatch ? parseInt(errorMatch[1]!, 10) : 0,
    passes: passMatch ? parseInt(passMatch[1]!, 10) : 0,
  };
}


/** 熔断 reason（技能 mjs:309-329 三分支逐字）。 */
function circuitReason(analysis: FailureAnalysis): string {
  if (analysis.pattern === 'repeating') {
    return `Repeating failure (${analysis.pattern}) — structural root cause requires deeper analysis: ${analysis.rootCauseHypothesis}`;
  }
  if (analysis.pattern === 'cascading') {
    return `Cascading failure (${analysis.pattern}) — primary root cause needs identification: ${analysis.rootCauseHypothesis}`;
  }
  return `Transient failure (${analysis.pattern}) — retry limit reached but failure not repeating: ${analysis.rootCauseHypothesis}`;
}

/** 每轮进度（流程层消费：逐 attempt 推进状态机——ITERATING 轨迹进投影历史）。 */
export interface AutoFixProgress {
  attempt: number;
  /** 本轮识别的失败项数（0=首轮全过直接收敛）。 */
  failures: number;
  /** retest 后是否修复成功。 */
  fixSuccess: boolean;
}

/**
 * native 编排（技能主循环 mjs:231-341 逐字移植）。
 * 前置错误（无 test 命令/无 cycle）→ exitCode 1 + error 响亮返回，不落任何文件。
 * @param opts.onProgress 每轮进度回调（流程层逐 attempt 推进状态机；script 模式无此粒度）
 */
export function runAutoFixNative(
  workspaceRoot: string,
  opts: { maxRetries?: number; testCmd?: string; onProgress?: (p: AutoFixProgress) => void } = {},
): AutoFixLoopResult {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const config = loadWorkspaceConfig(cyclesDir);
  const testCmd = opts.testCmd ?? config.values.testCmd;
  const warnings = [...config.warnings];

  if (!testCmd) {
    return {
      verdict: 'pass', exitCode: 1, testCmd: '', maxRetries, attempts: [], analysis: null,
      incidentPath: null, reportPath: null, suggestedNextStep: null,
      error: 'No test command found. Specify --test-cmd or configure test_cmd in .cycles/config.yml',
      warnings,
    };
  }

  const cycleDir = latestCycleDir(cyclesDir);
  if (!cycleDir) {
    return {
      verdict: 'pass', exitCode: 1, testCmd, maxRetries, attempts: [], analysis: null,
      incidentPath: null, reportPath: null, suggestedNextStep: null,
      error: 'No cycle directory found. Run init-cycle first.', warnings,
    };
  }

  const attempts: FixAttempt[] = [];
  let finalSuccess = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const testResult = runTestCommand(testCmd, workspaceRoot);
    const reports = readTestReports(cycleDir);
    const failures = identifyFailures(testResult, reports);

    if (failures.length === 0) {
      attempts.push({ success: true, failures: [], fixAction: null });
      finalSuccess = true;
      opts.onProgress?.({ attempt, failures: 0, fixSuccess: true });
      recordFixAttempt(cycleDir, attempt, [], true);
      break;
    }

    // 脚本侧 L4 桩语义：同步执行无 AI 介入窗口，retest 是同一命令重跑——
    // 真正的修复由模型在对话层完成后再重调本流程（差异即瞬态失败的判定信号）。
    const retestResult = runTestCommand(testCmd, workspaceRoot);
    const retestReports = readTestReports(cycleDir);
    const remaining = identifyFailures(retestResult, retestReports);
    const fixSuccess = remaining.length === 0;
    attempts.push({
      success: fixSuccess,
      failures,
      fixAction: fixSuccess ? 'Fix applied and verified' : 'Fix applied but failures remain',
    });
    opts.onProgress?.({ attempt, failures: failures.length, fixSuccess });
    recordFixAttempt(cycleDir, attempt, failures, fixSuccess);
    if (fixSuccess) {
      finalSuccess = true;
      break;
    }
  }

  let analysis: FailureAnalysis | null = null;
  let incidentPath: string | null = null;
  let suggestedNextStep: 'autonomy-fallback' | null = null;
  if (!finalSuccess) {
    // 核心原则（技能头注）：不可直接降级/熔断，先评估研究找根因——
    // 失败模式分析先行，incident 只陈述事实与建议，降级是 autonomy-fallback 的职责。
    analysis = analyzeFailurePattern(attempts);
    incidentPath = recordAutoFixIncident(workspaceRoot, circuitReason(analysis));
    suggestedNextStep = 'autonomy-fallback';
  }

  const reportPath = generateFixReport(cycleDir, attempts, finalSuccess);
  return {
    verdict: finalSuccess ? 'pass' : 'circuit',
    exitCode: finalSuccess ? 0 : 2,
    testCmd, maxRetries, attempts, analysis, incidentPath, reportPath, suggestedNextStep,
    warnings,
  };
}
