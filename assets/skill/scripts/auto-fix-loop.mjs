#!/usr/bin/env node
// auto-fix-loop.mjs — 自动修复循环：验证失败→失败模式分析→根因诊断→修复→重新验证
// 核心原则：不可直接降级/熔断，先进行问题评估研究找出根本原因修复完善优化
// 用法: node scripts/auto-fix-loop.mjs <project-dir> [--max-retries N] [--test-cmd "..."]

// v1.8.4-fork（dsh-anic 本地修复，未同步上游）：import 列表补 readdirSync——
// readTestReports（:62）在 test-reports 目录存在时调用它，原 import 缺失致
// ReferenceError 崩溃（exit 1，真机 cycle-11 复现）。
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parseCliArgs } from './lib/args.mjs';
import { loadProjectConfig, getYamlString } from './lib/config.mjs';
import { getLatestCycleDir } from './lib/cycle.mjs';
import { atomicWriteFileSync } from './lib/fs-safe.mjs';
import {
  timeoutFor,
  resolveTimeout,
  timeoutFromConfig,
  isTimeoutError,
  isBufferOverflowError,
} from './lib/budget.mjs';
// 智能策略库（P0 cycle-97）：recommendFixStrategy 是超时/重复/级联失败的
// 策略决策单一来源。analyzeFailurePattern 以 stat 前缀别名导入——本文件
// :189 已有同名本地函数（历史口径，保留以避免破坏既有测试对它的直接断言），
// 两套实现并存但职责不同：本地版产出循环内部判据（repeating/cascading），
// 策略库版产出统计摘要（avgBudgetUtilization 等），供报告层引用。
import { recommendFixStrategy, analyzeFailurePattern as analyzeFailureStats, recommendOptimalBudget, FIX_STRATEGIES } from './lib/auto-fix-strategy.mjs';

function loadConfig(projectDir) {
  // v1.8.3：唯一配置入口。auto-fix-loop 是修复驱动器，允许无配置运行（--test-cmd 兜底），
  // 但缺配置必须大声说出来——静默降级正是 S-1 的成因。
  try {
    const content = loadProjectConfig(projectDir);
    return {
      content,
      test_cmd: getYamlString(content, 'test_cmd'),
      lint_cmd: getYamlString(content, 'lint_cmd'),
      build_cmd: getYamlString(content, 'build_cmd'),
    };
  } catch (e) {
    console.error(`[config] ${e.message} (auto-fix-loop continues; pass --test-cmd to override)`);
    return {};
  }
}

const getLatestCycle = getLatestCycleDir;

/**
 * 跑一次命令，把「超时」与「失败」分成**本体不同的结果**（cycle-96 WS-C C3）。
 * 原实现 catch 一律返回 {success:false}，而超时（code='ETIMEDOUT'、status=null）
 * 与真实失败（status=数字退出码）在下游不可区分 ⇒ ①超时被记成 test-command-failure；
 * ②重试超时只会再超时（白烧预算）；③模式分析给出「增加重试」这种方向相反的建议。
 * @returns {{success, output, error?, exitCode?, timedOut, timeoutMs, durationMs}}
 */
function runCommand(cmd, projectDir, timeoutMs) {
  const started = Date.now();
  try {
    const output = execSync(cmd, {
      cwd: projectDir, timeout: timeoutMs, stdio: 'pipe', encoding: 'utf-8',
      windowsHide: true, // cycle-99b：auto-fix 循环每次修复命令不弹 cmd 窗口
    });
    return { success: true, output, timedOut: false, timeoutMs, durationMs: Date.now() - started };
  } catch (e) {
    const durationMs = Date.now() - started;
    const timedOut = isTimeoutError(e);
    // 超时的 stdout 是**半截输出**：不能当失败详情（把半截日志当结论是
    // cycle-39 归因错误的另一半根因）。超时只报「预算 + 实耗」这组事实。
    if (timedOut) {
      return {
        success: false,
        timedOut: true,
        timeoutMs,
        durationMs,
        output: '',
        error: `command exceeded ${humanMs(timeoutMs)} budget `
          + `(killed after ${humanMs(durationMs)}) — no verdict, not a test failure`,
      };
    }
    return {
      success: false,
      timedOut: false,
      timeoutMs,
      durationMs,
      output: e.stdout ? e.stdout.toString() : '',
      error: isBufferOverflowError(e)
        ? `command output exceeded the execSync buffer (ENOBUFS) — cannot judge`
        : (e.stderr ? e.stderr.toString().trim() : e.message),
      exitCode: e.status,
    };
  }
}

// v1.8.5-fork（D-1103）：报告计数双格式解析。原正则只认键值「失败：N」，
// 而正典模板（assets/templates/test-report.md §2 汇总）与 G2 门禁（gate-check.mjs）
// 规定的都是管道表「| 失败 | N |」——两套正典解析器互不相交，正典报告全被读成 0，
// test-report-failure 通道形同虚设（fail-open）。修复：管道表优先（正典机器可读区），
// 键值回退（兼容自由文本/旧报告）；管道表命中时不再看键值——§4 失败详情散文里的
// 「失败：3 次」样文字不会覆盖 §2 汇总的权威计数。
function readTestReports(projectDir, cycleDir) {
  const testReportsDir = join(projectDir, '.cycles', 'cycles', cycleDir, 'test-reports');
  if (!existsSync(testReportsDir)) return [];

  const reports = [];
  const files = readdirSync(testReportsDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const content = readFileSync(join(testReportsDir, file), 'utf-8');
    // 正典 §2 汇总管道表：| 失败 | N |（与 G2 gate-check.mjs 同一形态）
    const pipeFail = content.match(/\|\s*失败\s*\|\s*(\d+)\s*\|/);
    const pipeError = content.match(/\|\s*错误\s*\|\s*(\d+)\s*\|/);
    const pipePass = content.match(/\|\s*通过\s*\|\s*(\d+)\s*\|/);
    // 旧键值格式回退：失败：N / 失败:N（全半角冒号）
    const kvFail = content.match(/失败[：:]\s*(\d+)/);
    const kvError = content.match(/错误[：:]\s*(\d+)/);
    const kvPass = content.match(/通过[：:]\s*(\d+)/);
    reports.push({
      file,
      failures: pipeFail ? parseInt(pipeFail[1]) : (kvFail ? parseInt(kvFail[1]) : 0),
      errors: pipeError ? parseInt(pipeError[1]) : (kvError ? parseInt(kvError[1]) : 0),
      passes: pipePass ? parseInt(pipePass[1]) : (kvPass ? parseInt(kvPass[1]) : 0),
      content,
    });
  }
  return reports;
}

/**
 * 识别失败项。**超时是独立类型**（cycle-96 WS-C C3）：两者修复策略相反——
 * 测试失败改代码再重跑（重试有意义）；超时是预算<真实工作量（重试同一超只会再超时）。
 * 混在一起只能给出含糊建议，而「调大重试」对超时是最坏选项。
 * 超时轮次**不采信测试报告**：报告可能是上一轮残留，本轮根本没跑完。
 */
function identifyFailures(testResult, reports) {
  const failures = [];

  if (!testResult.success) {
    if (testResult.timedOut) {
      failures.push({
        type: 'test-command-timeout',
        detail: testResult.error,
        timeoutMs: testResult.timeoutMs,
        durationMs: testResult.durationMs,
        // 可操作建议在识别层就给出（与 :331 的 Strategy 提示同源，避免两处口径）
        advice: recommendForTimeout(testResult.timeoutMs, testResult.durationMs),
      });
      return failures;
    }
    failures.push({
      type: 'test-command-failure',
      detail: testResult.error || testResult.output,
      exitCode: testResult.exitCode,
    });
  }

  for (const report of reports) {
    if (report.failures > 0 || report.errors > 0) {
      const failLines = report.content.split('\n').filter(l =>
        l.includes('FAIL') || l.includes('失败') || l.includes('错误') || l.includes('Error')
      );
      failures.push({
        type: 'test-report-failure',
        file: report.file,
        failures: report.failures,
        errors: report.errors,
        details: failLines.slice(0, 10),
      });
    }
  }

  return failures;
}

/**
 * 人读的时间量（毫秒 → 文本）。预算可能小于 1s（旗标显式传入、
 * 或极小项目的探测），一律圆整到秒会打出「0s 预算」这种自相矛盾的读数，
 * 让真正的预算问题看起来像脚本 bug。小于 1s 保留毫秒。
 */
function humanMs(ms) {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return n >= 1000 ? `${Math.round(n / 1000)}s` : `${Math.round(n)}ms`;
}

/**
 * 超时的可操作建议（单一口径：识别层与 Strategy 分支都调它）。
 * 判据用「实耗 vs 预算」的比例，而不是猜：实耗打满预算即预算不足。
 */
function recommendForTimeout(timeoutMs, durationMs) {
  const ratio = timeoutMs > 0 ? (durationMs || 0) / timeoutMs : 0;
  return `命令打满 ${humanMs(timeoutMs)} 预算（实耗 ${humanMs(durationMs)}，占 ${Math.round(ratio * 100)}%）。`
    + `这是**预算不足**，不是测试失败——重试同一命令只会再超时。`
    + `处置：①调大预算（.cycles/config.yml 的 test_timeout_ms，或 --timeout-ms 显式传入）；`
    + `②或缩小测试集（按文件/按层跑），把单次工作量压回预算内。`
    + `不要用 --max-retries 兜底（那是为「测试失败」设计的，对超时零效）。`;
}

function analyzeFailurePattern(attempts) {
  const allFailures = attempts.flatMap(a => a.failures);
  const failureTypes = {};
  for (const f of allFailures) {
    const key = f.type;
    if (!failureTypes[key]) failureTypes[key] = [];
    failureTypes[key].push(f);
  }

  const isRepeatingFailure = Object.values(failureTypes).some(fails => fails.length >= 3);
  const hasMultipleFailureTypes = Object.keys(failureTypes).length > 1;
  const hasCascadingPattern = hasMultipleFailureTypes && Object.values(failureTypes).some(fails => fails.length >= 2);

  // cycle-96 WS-C C3：超时**独立统计**。判据是「超时占了多数失败」而不是
  // 「出现任意一次超时」——偶发一次超时后成功修复，不该把整轮判成预算问题。
  const timeouts = failureTypes['test-command-timeout'] || [];
  const timeoutDominant = allFailures.length > 0 && timeouts.length >= Math.ceil(allFailures.length / 2);

  let pattern = 'unknown';
  let rootCauseHypothesis = '';
  let recommendedAction = '';

  if (isRepeatingFailure && !hasMultipleFailureTypes) {
    pattern = 'repeating';
    rootCauseHypothesis = '同一失败反复出现——根因可能在于架构层面而非瞬态问题';
    recommendedAction = '尝试更深层次修复：检查接口契约、依赖关系、架构设计';
  } else if (hasCascadingPattern) {
    pattern = 'cascading';
    rootCauseHypothesis = '多种不同失败类型且至少一种反复出现——可能是级联失败，存在共同根因';
    recommendedAction = '先修复主失败（最常见类型），可能连带解决次失败';
  } else {
    pattern = 'transient';
    rootCauseHypothesis = '偶发性失败——可能是环境或时序问题';
    recommendedAction = '增加重试次数或调整超时配置';
  }

  // 超时主导时覆盖假设与建议。**pattern 仍保持三选一**：宿主解析契约
  // （src/host/flows/autoFixFlow.ts 只认 repeating|cascading|transient，
  // 新增第四个值会让宿主侧 pattern 变 null ⇒ 投影信息丢失）。但「根因假设/
  // 建议」必须改成超时口径——否则下游拿到「检查接口契约 / 增加重试」这种
  // 对超时完全无效、且方向相反的指导。
  if (timeoutDominant) {
    const t = timeouts[timeouts.length - 1];
    rootCauseHypothesis = `超时主导（${timeouts.length}/${allFailures.length} 次失败是超时）——`
      + '预算小于真实工作量，不是代码缺陷';
    recommendedAction = (t && t.advice)
      ? t.advice
      : '调大 test_timeout_ms 或缩小测试集；不要靠重试兜底';
  }

  return {
    pattern, rootCauseHypothesis, recommendedAction, failureTypes,
    timeoutDominant, timeoutCount: timeouts.length,
  };
}

function recordFixAttempt(projectDir, cycleDir, attempt, failures, fixResult) {
  const auditLogPath = join(projectDir, '.cycles', 'cycles', cycleDir, '审计日志.md');
  const timestamp = new Date().toISOString();
  const status = fixResult.success ? 'PASS' : 'FAIL';
  const failSummary = failures.map(f => `${f.type}: ${f.detail || `${f.failures} failures, ${f.errors} errors`}`).join('; ');
  const entry = `\n| ${timestamp} | auto-fix-loop | ${status} | Attempt ${attempt}: ${failSummary} | ${fixResult.success ? '修复成功' : '修复失败'} |\n`;

  if (existsSync(auditLogPath)) {
    const content = readFileSync(auditLogPath, 'utf-8');
    if (content.includes('| 时间 | 检查点 | 结果 | 详情 | 状态 |')) {
      atomicWriteFileSync(auditLogPath, content + entry);
    } else {
      const header = `\n## 自动修复循环记录\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n`;
      atomicWriteFileSync(auditLogPath, content + header + entry);
    }
  }
}

function recordCircuitBreaker(projectDir, reason) {
  const incidentsDir = join(projectDir, '.cycles', 'incidents');
  if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incidentPath = join(incidentsDir, `incident-auto-fix-fail-${timestamp}.md`);
  const content = `# 事故记录：自动修复循环熔断\n\n## 基本信息\n| 字段 | 值 |\n|---|---|\n| 时间 | ${timestamp} |\n| 事件 | 自动修复循环达到重试上限 |\n| 原因 | ${reason} |\n\n## 影响范围\n- 熔断条件 CB1 触发：同一异常连续3次自动修复失败\n- 自主级别应回退：L4 → L3\n- 需要人类介入诊断\n\n## 恢复条件\n- 根因已定位且修复已验证\n- 人类确认问题已修复\n`;
  atomicWriteFileSync(incidentPath, content);
  return incidentPath;
}

function generateFixReport(projectDir, cycleDir, attempts, allFailures, finalSuccess) {
  const reportDir = join(projectDir, '.cycles', 'cycles', cycleDir, 'test-reports');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const reportPath = join(reportDir, 'auto-fix-report.md');
  const timestamp = new Date().toISOString();
  const status = finalSuccess ? 'SUCCESS' : 'FAILED';

  let content = `# 自动修复循环报告\n\n## 基本信息\n| 字段 | 值 |\n|---|---|\n| 时间 | ${timestamp} |\n| 循环 | ${cycleDir} |\n| 状态 | ${status} |\n| 尝试次数 | ${attempts.length} |\n\n## 尝试记录\n`;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    content += `\n### 尝试 ${i + 1}\n`;
    content += `- 状态: ${attempt.success ? '成功' : '失败'}\n`;
    content += `- 识别的失败项: ${attempt.failures.length}\n`;
    for (const f of attempt.failures) {
      content += `  - ${f.type}: ${f.detail || `${f.failures} failures, ${f.errors} errors`}\n`;
    }
    if (attempt.fixAction) {
      content += `- 修复动作: ${attempt.fixAction}\n`;
    }
  }

  if (!finalSuccess) {
    content += `\n## 熔断\n自动修复循环达到重试上限，触发熔断条件 CB1。\n需运行 \`org-status.mjs --auto-fallback\` 回退自主级别。\n`;
  }

  atomicWriteFileSync(reportPath, content);
  return reportPath;
}

const args = parseCliArgs(process.argv, {
  script: 'auto-fix-loop',
  usage: 'Usage: node auto-fix-loop.mjs <project-dir> [--max-retries N] [--test-cmd "..."] [--timeout-ms N]',
  // cycle-96 WS-C：新增 --timeout-ms 是**加旗标**，不是改变 CLI 形状——
  // 位置参数契约（第一个位置参数 = project-dir）一字未动（skillReplaceE2E 钉死）。
  flags: {
    'max-retries': { type: 'int', default: 3 },
    'test-cmd': { type: 'string' },
    'timeout-ms': { type: 'int' },
  },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});

const projectDir = resolve(args._[0]);
const config = loadConfig(projectDir);
const testCmd = args.testCmd || config.test_cmd;
const maxRetries = args.maxRetries;

// 预算解析顺序（单一事实源在 lib/budget.mjs）：显式 --timeout-ms >
// .cycles/config.yml 的 test_timeout_ms > lib/budget.mjs 的 DEFAULT。
// 三者都不写死数字，数字只在 budget.mjs 一处（那里带基线依据注释）。
const testTimeoutMs = resolveTimeout('test', {
  override: args.timeoutMs,
  configMs: timeoutFromConfig(config.content, 'test'),
});

if (!testCmd) {
  console.error('No test command found. Specify --test-cmd or configure test_cmd in .cycles/config.yml');
  process.exit(1);
}

const cycleDir = getLatestCycle(projectDir);
if (!cycleDir) {
  console.error('No cycle directory found. Run init-cycle first.');
  process.exit(1);
}

console.log(`=== Auto-Fix Loop ===`);
console.log(`Project: ${projectDir}`);
console.log(`Cycle: ${cycleDir}`);
console.log(`Test command: ${testCmd}`);
console.log(`Max retries: ${maxRetries}`);
// 预算与依据一并打印：超时是可诊断事件，不能让用户猜「为什么在 120s 被杀」。
console.log(`Test timeout: ${testTimeoutMs}ms per run (${args.timeoutMs ? '--timeout-ms' : timeoutFromConfig(config.content, 'test') ? 'config test_timeout_ms' : 'default from lib/budget.mjs (baseline 33.1s x ~3)'})`);
console.log(``);

const attempts = [];

let finalSuccess = false;
/** 因预算耗尽而提前停止（与「修复失败耗尽重试」是**不同**的终态）。 */
let budgetExhausted = false;

for (let attempt = 1; attempt <= maxRetries; attempt++) {
  console.log(`--- Attempt ${attempt}/${maxRetries} ---`);

  console.log(`Running test command: ${testCmd}`);
  const testResult = runCommand(testCmd, projectDir, testTimeoutMs);
  const reports = readTestReports(projectDir, cycleDir);
  const failures = identifyFailures(testResult, reports);

  if (failures.length === 0) {
    console.log(`All tests passed. No fixes needed.`);
    attempts.push({ success: true, failures: [], fixAction: null });
    finalSuccess = true;
    recordFixAttempt(projectDir, cycleDir, attempt, [], { success: true });
    break;
  }

  console.log(`Identified ${failures.length} failure(s):`);
  for (const f of failures) {
    console.log(`  - ${f.type}: ${f.detail || `${f.failures} failures, ${f.errors} errors`}`);
  }

  // cycle-96 WS-C C3 核心：**超时轮次直接停止**，不进入「修复→复验」流程。
  // 理由不是偷懒，而是证据：超时的根因是预算 < 真实工作量，脚本这一侧
  // 没有任何"修复"能改变工作量；继续跑只会再超时一次（每轮烧一个预算，
  // 且把同一条超时记成 N 次"修复失败"，污染失败模式统计与熔断计数）。
  // 这里记为 attempt 结束并跳出循环，把控制权交给超时专属的分析分支。
  if (testResult.timedOut) {
    attempts.push({
      success: false,
      failures,
      fixAction: 'stopped: command exceeded its time budget (retrying cannot help)',
    });
    recordFixAttempt(projectDir, cycleDir, attempt, failures, { success: false });
    budgetExhausted = true;
    console.log(`Test command exceeded its ${humanMs(testTimeoutMs)} budget — stopping the loop.`);
    console.log(`  Retrying a timed-out command only re-runs the same workload; it cannot turn green.`);
    break;
  }

  console.log(`AI should diagnose root cause and apply fix...`);
  console.log(`  (In L4 autonomous mode, AI will analyze failures and modify code/tests)`);
  console.log(`  Re-running verification after fix...`);

  const retestResult = runCommand(testCmd, projectDir, testTimeoutMs);
  const retestReports = readTestReports(projectDir, cycleDir);
  const remainingFailures = identifyFailures(retestResult, retestReports);

  // 复验超时同理：不能判"修复无效"（根本没有结论），只能判"预算不足"。
  if (retestResult.timedOut) {
    attempts.push({
      success: false,
      failures,
      fixAction: 'inconclusive: re-verification exceeded its time budget (no verdict)',
    });
    recordFixAttempt(projectDir, cycleDir, attempt, failures, { success: false });
    budgetExhausted = true;
    console.log(`Re-verification exceeded its ${humanMs(testTimeoutMs)} budget — no verdict, stopping the loop.`);
    break;
  }

  const fixSuccess = remainingFailures.length === 0;
  attempts.push({
    success: fixSuccess,
    failures,
    fixAction: fixSuccess ? 'Fix applied and verified' : 'Fix applied but failures remain',
  });

  recordFixAttempt(projectDir, cycleDir, attempt, failures, { success: fixSuccess });

  if (fixSuccess) {
    console.log(`Fix successful. All tests now pass.`);
    finalSuccess = true;
    break;
  }


  console.log(`Fix attempt ${attempt} failed. ${remainingFailures.length} failure(s) remain.`);
}

console.log(``);

if (!finalSuccess) {
  console.log(`=== Phase: Failure Pattern Analysis & Root Cause Assessment ===`);
  console.log(budgetExhausted
    ? `Auto-fix loop stopped early: the test command could not finish inside its time budget.`
    : `Auto-fix loop exhausted ${maxRetries} retries. Performing failure pattern analysis...`);
  console.log(`(Core principle: do NOT directly circuit-break — first assess and research root cause)`);

  const analysis = analyzeFailurePattern(attempts);

  console.log(``);
  console.log(`Failure pattern: ${analysis.pattern}`);
  console.log(`Root cause hypothesis: ${analysis.rootCauseHypothesis}`);
  console.log(`Recommended action: ${analysis.recommendedAction}`);
  console.log(``);

  console.log(`Failure type breakdown:`);
  for (const [type, fails] of Object.entries(analysis.failureTypes)) {
    console.log(`  ${type}: ${fails.length} occurrence(s)`);
    if (fails[0].details) {
      console.log(`    Sample: ${fails[0].details.slice(0, 3).join('; ')}`);
    }
  }

  console.log(``);
  console.log(`=== Phase: Extended Fix Attempt Based on Pattern Analysis ===`);

  // 超时分支排在**最前**：它不是三种「失败模式」的一种，而是预算类问题。
  // 放在 pattern 判断里会被 transient 分支吸收，进而建议「增加重试次数」——
  // 对超时那恰好是最坏的建议（多烧预算、仍然红）。这就是 C3 要根治的方向错误。
  if (analysis.timeoutDominant) {
    console.log(`Timeout dominant — this is a budget problem, not a fixable failure pattern.`);
    console.log(`  ${analysis.recommendedAction}`);
    // 超时也记 incident（熔断语义不变：需要人类调预算或改测试集），
    // 但 reason 明确写「预算不足」，免得事后被读成代码缺陷。
    const incidentPath = recordCircuitBreaker(projectDir,
      `Test command timed out (${analysis.timeoutCount}/${attempts.flatMap(a => a.failures).length} failures) — `
      + `time budget ${testTimeoutMs}ms is smaller than real workload: ${analysis.rootCauseHypothesis}`);
    console.error(`Incident recorded: ${incidentPath}`);
    console.error(`Fix the budget, not the retry count:`);
    console.error(`  node auto-fix-loop.mjs <project-dir> --timeout-ms <larger>   (or set test_timeout_ms in .cycles/config.yml)`);
  } else if (analysis.pattern === 'repeating') {
    console.log(`Repeating failure detected — attempting deeper structural fix...`);
    console.log(`  (In L4 autonomous mode, AI should analyze architecture-level root cause)`);
    console.log(`  Strategy: Check interface contracts, dependency relationships, and design patterns`);
    const incidentPath = recordCircuitBreaker(projectDir, `Repeating failure (${analysis.pattern}) — structural root cause requires deeper analysis: ${analysis.rootCauseHypothesis}`);
    console.error(`Incident recorded: ${incidentPath}`);
    console.error(`Run: node org-status.mjs <project-dir> auto-fallback`);

    // ── P0 策略引擎接入（cycle-97）：统计摘要 + 贝叶斯预算推荐 ──
    // analyzeFailureStats（策略库版）产出循环本地分析没有的量化读数：
    // 平均预算利用率、失败分布、总尝试数。预算推荐基于 P95 时长——
    // 比「拍脑袋 ×1.5」更可辩护（P95 覆盖 95% 历史实耗，再留 30% 边际）。
    const stats = analyzeFailureStats(attempts);
    console.log(`  [stats] avg budget utilization: ${Math.round(stats.avgBudgetUtilization * 100)}%`
      + ` | failure types: ${Object.keys(stats.failureDistribution).length}`
      + ` | attempts: ${stats.totalAttempts}`);
    if (analysis.timeoutDominant && stats.avgBudgetUtilization > 0.9) {
      const budgetRec = recommendOptimalBudget(testTimeoutMs, attempts.map(a => ({
        success: a.success, durationMs: a.durationMs ?? 0,
      })));
      console.log(`  [budget] recommended: ${humanMs(budgetRec.recommendedMs)} — ${budgetRec.justification}`);
      if (budgetRec.confidenceInterval) {
        console.log(`  [budget] confidence interval: ${humanMs(budgetRec.confidenceInterval[0])} ~ ${humanMs(budgetRec.confidenceInterval[1])}`);
      }
    }
  } else if (analysis.pattern === 'cascading') {
    console.log(`Cascading failure detected — attempting isolated fix of primary failure...`);
    console.log(`  (In L4 autonomous mode, AI should fix the root cause that cascades to secondary failures)`);
    console.log(`  Strategy: Address the primary failure first, which may resolve secondary failures`);
    const incidentPath = recordCircuitBreaker(projectDir, `Cascading failure (${analysis.pattern}) — primary root cause needs identification: ${analysis.rootCauseHypothesis}`);
    console.error(`Incident recorded: ${incidentPath}`);
    console.error(`Run: node org-status.mjs <project-dir> auto-fallback`);
  } else {
    console.log(`Transient failure detected — may resolve with adjusted parameters...`);
    console.log(`  Strategy: Increase --max-retries or adjust timeout configuration`);
    const incidentPath = recordCircuitBreaker(projectDir, `Transient failure (${analysis.pattern}) — retry limit reached but failure not repeating: ${analysis.rootCauseHypothesis}`);
    console.error(`Incident recorded: ${incidentPath}`);
    console.error(`Consider: node auto-fix-loop.mjs <project-dir> --max-retries 5`);
  }
}

const reportPath = generateFixReport(projectDir, cycleDir, attempts, [], finalSuccess);
console.log(`Fix report: ${reportPath}`);

if (finalSuccess) {
  console.log(`\nAuto-fix loop completed successfully.`);
  process.exit(0);
} else {
  console.error(`\nAuto-fix loop FAILED. Circuit breaker triggered.`);
  process.exit(2);
}