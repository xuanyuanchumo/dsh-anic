/**
 * gateEngine —— G0-G3 收敛门禁原生引擎（阶段 2 首个 ModuleEngine 实例）。
 *
 * 定位（R3 阶段 2）：gate-check.mjs 的**原生等价物**，不是替代——script 模式仍走
 * 技能脚本（正典写入者），native 模式走本引擎，diff 模式双跑对账。判定逻辑
 * 逐字对齐 gate-check.mjs:39-174（差分测试钉死）；唯一有意差异：
 *  - 脚本在 config 缺失时于任何门禁前 exit(1)（loadConfig :27-34）——本引擎
 *    以 fatal 字段复现同一行为（gates 空 + exitCode 1），不静默改判。
 *
 * 引擎不持有流程状态（状态归 FlowMachine）；不写账本（record 归流程层）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { latestCycleDir } from '../llm/gateEvidence.ts';
import {
  countEvalVerdictRows,
  parseTaskRows,
  parseTestSummary,
  parseQualityRow,
  readYamlString,
  QUALITY_CHECKS,
} from './gateArtifacts.ts';
import type { GateCheckResult, NativeGateResult } from './gateTypes.ts';

/** 配置读取（lib/config.mjs loadProjectConfig :21-31 同语义：canonical → legacy 告警 → 致命）。 */
export function loadGateConfig(workspaceRoot: string): { content: string | null; fatal: string | null } {
  const canonical = join(workspaceRoot, '.cycles', 'config.yml');
  if (existsSync(canonical)) return { content: readFileSync(canonical, 'utf-8'), fatal: null };
  const legacy = join(workspaceRoot, '.cycles', 'cycle-config.yml');
  if (existsSync(legacy)) {
    return { content: readFileSync(legacy, 'utf-8'), fatal: null }; // 语义兼容（脚本侧此处打 DEPRECATED 告警）
  }
  return {
    content: null,
    fatal: 'No .cycles/config.yml found. Run "node scripts/init-workflow.mjs <project-dir>" first.',
  };
}

/**
 * 最新 cycle 目录解析（两形态一起给）。
 *
 * 注意：gateEvidence.latestCycleDir 的入参是 **`.cycles` 根**（内部自拼 `cycles`），
 * 返回值是**完整路径**（`join(parent, best)`）。此前把它当 `.cycles/cycles` 传入、
 * 又把返回值当目录名拼接，是同源双误——测试的 "No cycle workspace" 连锁由此而来。
 */
function latestCycle(workspaceRoot: string): { name: string; dir: string } | null {
  const found = latestCycleDir(join(workspaceRoot, '.cycles'));
  if (found === null) return null;
  return { name: basename(found), dir: found };
}

/** G0（gate-check.mjs:39-59 同构）。 */
export function checkG0(workspaceRoot: string): GateCheckResult {
  const cyclesDir = join(workspaceRoot, '.cycles', 'cycles');
  if (!existsSync(cyclesDir)) return { pass: false, detail: 'No .cycles directory' };
  const latest = latestCycle(workspaceRoot);
  if (!latest) return { pass: false, detail: 'No cycle workspace' };
  const evalReport = join(latest.dir, '项目评估报告.md');
  if (!existsSync(evalReport)) return { pass: false, detail: 'No evaluation report' };
  const rows = countEvalVerdictRows(readFileSync(evalReport, 'utf-8'));
  if (rows === 0) {
    return { pass: false, detail: `Evaluation report has no dimension verdict rows (${latest.name}/项目评估报告.md)` };
  }
  return { pass: true, detail: `Evaluation report found in ${latest.name} (${rows} dimension rows)` };
}

/** G1（gate-check.mjs:61-80 同构；解析器与技能 lib/tasks.mjs 共同实现语义）。 */
export function checkG1(workspaceRoot: string): GateCheckResult {
  const latest = latestCycle(workspaceRoot);
  if (!latest) return { pass: false, detail: 'No cycle workspace' };
  const taskList = join(latest.dir, '任务清单.md');
  if (!existsSync(taskList)) return { pass: false, detail: 'No task list' };
  const rows = parseTaskRows(readFileSync(taskList, 'utf-8'));
  if (rows.length === 0) return { pass: false, detail: 'No task entries found (fill the task tables in 任务清单.md)' };
  const pending = rows.filter((cells) => (cells[cells.length - 1] ?? '') !== '完成');
  if (pending.length > 0) return { pass: false, detail: `${pending.length} of ${rows.length} tasks not completed` };
  return { pass: true, detail: `All ${rows.length} tasks completed` };
}

/** G2（gate-check.mjs:82-117 同构：mtime 最新报告 + §2 汇总表格式契约）。 */
export function checkG2(workspaceRoot: string): GateCheckResult {
  const latest = latestCycle(workspaceRoot);
  if (!latest) return { pass: false, detail: 'No cycle workspace' };
  const testReportsDir = join(latest.dir, 'test-reports');
  if (!existsSync(testReportsDir)) return { pass: false, detail: 'No test reports directory' };
  const reports = readdirSync(testReportsDir).filter((e) => e.endsWith('.md'));
  if (reports.length === 0) return { pass: false, detail: 'No test reports' };
  const latestReport = reports
    .map((f) => ({ f, m: statSync(join(testReportsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]?.f ?? '';
  const content = readFileSync(join(testReportsDir, latestReport), 'utf-8');
  const summary = parseTestSummary(content);
  if (!summary.recognized) {
    return { pass: false, detail: `Test report summary not recognized: ${latestReport} has no 通过/失败 rows (expected the §2 汇总 table)` };
  }
  if (summary.failures > 0 || summary.errors > 0) {
    return { pass: false, detail: `${summary.failures} failures, ${summary.errors} errors` };
  }
  return { pass: true, detail: `Zero failures, zero errors (${latestReport})` };
}

/** G3（gate-check.mjs:119-131 同构：build_cmd 走 shell，timeout 120s）。 */
export function checkG3(workspaceRoot: string, configContent: string | null): GateCheckResult {
  const buildCmd = readYamlString(configContent, 'build_cmd');
  if (!buildCmd) return { pass: false, detail: 'No build command configured' };
  const r = spawnSync(buildCmd, { cwd: workspaceRoot, timeout: 120000, shell: true, encoding: 'utf-8' });
  return r.status === 0
    ? { pass: true, detail: `Build passed: ${buildCmd}` }
    : { pass: false, detail: `Build failed: ${buildCmd}` };
}

/** 质量门（gate-check.mjs:133-174 同构：三态——缺行/SKIP 都不能关门）。 */
export function checkQualityGate(workspaceRoot: string, gateId: string): GateCheckResult {
  const latest = latestCycle(workspaceRoot);
  if (!latest) return { pass: false, detail: 'No cycle directory' };
  const evalResultsPath = join(latest.dir, '项目评估报告.md');
  if (!existsSync(evalResultsPath)) return { pass: false, detail: 'No eval results (run eval-runner first)' };
  const evalContent = readFileSync(evalResultsPath, 'utf-8');
  const checks = QUALITY_CHECKS[gateId] ?? [];
  const failedChecks: string[] = [];
  const unevaluatedChecks: string[] = [];
  for (const q of checks) {
    const row = parseQualityRow(evalContent, q);
    if (row === null) unevaluatedChecks.push(`${q}(row absent)`);
    else if (row === 'SKIP') unevaluatedChecks.push(`${q}(SKIP)`);
    else if (row === 'FAIL') failedChecks.push(q);
  }
  if (failedChecks.length > 0) return { pass: false, detail: `Quality dimensions failed: ${failedChecks.join(', ')}` };
  if (unevaluatedChecks.length > 0) {
    return { pass: false, detail: `Quality dimensions not evaluated — gate cannot close without evidence: ${unevaluatedChecks.join(', ')}` };
  }
  return { pass: true, detail: `Quality dimensions passed: ${checks.join(', ')}` };
}

const GATE_FN: Record<string, (ws: string, cfg: string | null) => GateCheckResult> = {
  G0: (ws) => checkG0(ws),
  G1: (ws) => checkG1(ws),
  G2: (ws) => checkG2(ws),
  G3: (ws, cfg) => checkG3(ws, cfg),
};

/** 原生门禁编排（gate-check.mjs:185-228 主流程同构，不含 --record）。 */
export function runNativeGateCheck(
  workspaceRoot: string,
  opts: { gate?: string; quality?: boolean } = {},
): NativeGateResult {
  const { content, fatal } = loadGateConfig(workspaceRoot);
  if (fatal !== null) return { gates: {}, quality: {}, allPass: false, exitCode: 1, fatal };

  const gatesToCheck = opts.gate === undefined || opts.gate === 'all' ? ['G0', 'G1', 'G2', 'G3'] : [opts.gate];
  const gates: Record<string, GateCheckResult> = {};
  const quality: Record<string, GateCheckResult> = {};
  let allPass = true;
  for (const g of gatesToCheck) {
    const fn = GATE_FN[g];
    if (!fn) continue; // 未知门号：脚本侧 gates[g]() 会 TypeError —— 这里跳过（HTTP 面更稳）
    const result = fn(workspaceRoot, content);
    gates[g] = result;
    if (!result.pass) allPass = false;
    if (opts.quality && result.pass) {
      const qResult = checkQualityGate(workspaceRoot, g);
      quality[g] = qResult;
      if (!qResult.pass) allPass = false;
    }
  }
  return { gates, quality, allPass, exitCode: allPass ? 0 : 1 };
}
