/**
 * gateEngine —— G0-G3 收敛门禁原生引擎（R3 阶段 2）。
 * 定位：gate-check.mjs 的**原生等价物**（script 模式仍走脚本=正典写入者；native 走本引擎；
 * diff 双跑对账）。判定逻辑逐字对齐 gate-check.mjs（差分测试钉死）；唯一有意差异：脚本在
 * config 缺失时于任何门禁前 exit(1)，本引擎以 fatal 复现（gates 空 + exitCode 1），不静默改判。
 * 引擎不持有流程状态（归 FlowMachine）；不写账本（record 归流程层）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { latestCycleDir } from '../llm/gateEvidence.ts';
import {
  countEvalVerdictRows,
  parseTaskRows,
  parseTestSummary,
  parseQualityRow,
  readYamlString,
  readYamlNestedBoolean,
  checkJourneyCoverage,
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

/** 最新 cycle 解析（两形态）。注意 latestCycleDir 入参是 **`.cycles` 根**、返回**完整路径**——
 *  此前当 `.cycles/cycles` 传入又当目录名拼接，是同源双误（"No cycle workspace" 连锁）。 */
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
  if (rows === 0) return { pass: false, detail: `Evaluation report has no dimension verdict rows (${latest.name}/项目评估报告.md)` };
  return { pass: true, detail: `Evaluation report found in ${latest.name} (${rows} dimension rows)` };
}

/** G1（gate-check.mjs:61-80 同构）。cycle-79 O-01：导出面 detail 追加 §cycle-N（与脚本逐字全等）。 */
export function checkG1(workspaceRoot: string): GateCheckResult {
  const latest = latestCycle(workspaceRoot);
  return withCycleTag(gateG1(latest), latest);
}
/** G1 判定核心（不含循环身份——身份由 withCycleTag 单点追加）。 */
function gateG1(latest: { name: string; dir: string } | null): GateCheckResult {
  if (!latest) return { pass: false, detail: 'No cycle workspace' };
  const taskList = join(latest.dir, '任务清单.md');
  if (!existsSync(taskList)) return { pass: false, detail: 'No task list' };
  const rows = parseTaskRows(readFileSync(taskList, 'utf-8'));
  if (rows.length === 0) return { pass: false, detail: 'No task entries found (fill the task tables in 任务清单.md)' };
  const pending = rows.filter((cells) => (cells[cells.length - 1] ?? '') !== '完成');
  if (pending.length > 0) return { pass: false, detail: `${pending.length} of ${rows.length} tasks not completed` };
  return { pass: true, detail: `All ${rows.length} tasks completed` };
}
/** G2（gate-check.mjs 同构：正典报告优先 + §2 汇总表契约）。cycle-79 O-01：detail 追加 §cycle-N。 */
export function checkG2(workspaceRoot: string, configContent: string | null = null): GateCheckResult {
  const latest = latestCycle(workspaceRoot);
  return withCycleTag(gateG2(workspaceRoot, latest, configContent), latest);
}
/** G2 判定核心（不含循环身份）。 */
function gateG2(ws: string, latest: { name: string; dir: string } | null, cfg: string | null): GateCheckResult {
  if (!latest) return { pass: false, detail: 'No cycle workspace' };
  const testReportsDir = join(latest.dir, 'test-reports');
  if (!existsSync(testReportsDir)) return { pass: false, detail: 'No test reports directory' };
  const reports = readdirSync(testReportsDir).filter((e) => e.endsWith('.md'));
  if (reports.length === 0) return { pass: false, detail: 'No test reports' };
  // cycle-72 与技能脚本逐字对齐（R3 双真相源禁令）：正典名优先，派生报告永不致证，
  // 仅当正典名不存在时才回退 mtime 最新；选中结果与被忽略的更晚非正典报告都必须回显。
  const CANONICAL_REPORTS = ['测试报告.md', 'test-report.md'];
  const DERIVED_REPORTS = ['auto-fix-report.md'];
  const mtimeOf = (f: string): number => statSync(join(testReportsDir, f)).mtimeMs;
  const canonical = CANONICAL_REPORTS.find((f) => reports.includes(f)) ?? null;
  const eligible = reports.filter((f) => !DERIVED_REPORTS.includes(f));
  const byMtime = eligible.map((f) => ({ f, m: mtimeOf(f) })).sort((a, b) => b.m - a.m);
  const latestReport = canonical ?? (byMtime[0]?.f ?? reports[0] ?? '');
  const newerNonCanonical = canonical ? eligible.filter((f) => f !== canonical && mtimeOf(f) > mtimeOf(canonical)) : [];
  const ignoredNote = newerNonCanonical.length > 0 ? ` [ignored newer non-canonical: ${newerNonCanonical.join(', ')}]` : '';
  const content = readFileSync(join(testReportsDir, latestReport), 'utf-8');
  const summary = parseTestSummary(content);
  if (!summary.recognized) {
    return { pass: false, detail: `Test report summary not recognized: ${latestReport} has no 通过/失败 rows (expected the §2 汇总 table)${ignoredNote}` };
  }
  if (summary.failures > 0 || summary.errors > 0) {
    return { pass: false, detail: `${summary.failures} failures, ${summary.errors} errors (${latestReport})${ignoredNote}` };
  }
  // cycle-39 T-3903：journey_coverage（双侧同构，差分契约钉死）
  const journeyCoverage = readYamlNestedBoolean(cfg, 'gates', 'G2', 'journey_coverage');
  if (journeyCoverage) {
    const j = checkJourneyCoverage(ws, cfg);
    if (!j.pass) return { pass: false, detail: `${j.detail} (plus zero failures in ${latestReport})${ignoredNote}` };
  }
  return { pass: true, detail: `Zero failures, zero errors (${latestReport}${journeyCoverage ? ' + journey coverage verified' : ''})${ignoredNote}` };
}
/** G3（gate-check.mjs 同构：build_cmd 走 shell）。cycle-79 O-01 §cycle-N + cycle-80 WS-3 dist revision。 */
export function checkG3(workspaceRoot: string, configContent: string | null): GateCheckResult {
  const result = withCycleTag(gateG3(workspaceRoot, configContent), latestCycle(workspaceRoot));
  // cycle-80 WS-3 G-04：构建产物新鲜度证据。缺陷＝「源码改了忘 build」：G3 只跑 build_cmd、不记录
  // 产出哪份字节 ⇒ 旧 dist 也"看起来全绿"。detail 只增不改（pass 仍只由 build_cmd 决定）。
  return { ...result, detail: `${result.detail} [dist=${distRevision8(workspaceRoot)}]` };
}
/** 构建产物 revision 前 8 位。口径与脚本 gate-check.mjs::distRevision 逐字一致：
 *  sha256(sha256(dist/host.js)+":"+sha256(dist/client.js)).slice(0,16)；缺失/不可读 ⇒ 'absent'。 */
function distRevision8(ws: string): string {
  const hostPath = join(ws, 'dist', 'host.js');
  const clientPath = join(ws, 'dist', 'client.js');
  if (!existsSync(hostPath) || !existsSync(clientPath)) return 'absent';
  try {
    const fileHash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
    return createHash('sha256').update(`${fileHash(hostPath)}:${fileHash(clientPath)}`).digest('hex').slice(0, 8);
  } catch {
    return 'absent';
  }
}
/** G3 判定核心（不含循环身份/产物证据）。 */
function gateG3(ws: string, cfg: string | null): GateCheckResult {
  const buildCmd = readYamlString(cfg, 'build_cmd');
  if (!buildCmd) return { pass: false, detail: 'No build command configured' };
  // cycle-99b：shell:true + 缺 windowsHide = G3 门禁每次跑 build 弹一个 cmd 窗口。
  const r = spawnSync(buildCmd, { cwd: ws, timeout: 120000, shell: true, encoding: 'utf-8', windowsHide: true });
  return r.status === 0
    ? { pass: true, detail: `Build passed: ${buildCmd}` }
    : { pass: false, detail: `Build failed: ${buildCmd}` };
}
/**
 * 质量门完整判定（含**逐维裁决**——cycle-77 修 F-04，cycle-72 债务台账 §4）。
 * 被守卫缺陷：原生侧把「门的 pass/detail」与「质量维结论」分成两字段，账本写入只消费前者
 * ⇒ 质量维 FAIL 时账本仍可能记 PASS（fail-open）。修法：逐维裁决词与 pass/detail 同一次解析
 * 算出，供账本拼 `[Q1:PASS,Q5:FAIL]`；`checkQualityGate` 仍返回 `{pass,detail}` 纯形状。
 */
export interface QualityGateEvaluation {
  pass: boolean;
  detail: string;
  /** 逐维裁决词（PASS / FAIL / SKIP / ABSENT）；无 cycle 目录或无报告时 null = 无可评估证据。 */
  dimensionRows: string[] | null;
}

/** 质量门结果 + 账本合流证据（附加字段不改变 {pass, detail} 契约；差分测试只比这两字段）。 */
export type QualityGateDetail = GateCheckResult & { dimensionRows?: string[] };

/** 质量门完整判定（gate-check.mjs checkQualityGate + dimensionRows 同构）。 */
export function evaluateQualityGate(workspaceRoot: string, gateId: string): QualityGateEvaluation {
  const latest = latestCycle(workspaceRoot);
  if (!latest) return { pass: false, detail: 'No cycle directory', dimensionRows: null };
  const evalResultsPath = join(latest.dir, '项目评估报告.md');
  if (!existsSync(evalResultsPath)) return { pass: false, detail: 'No eval results (run eval-runner first)', dimensionRows: null };
  const evalContent = readFileSync(evalResultsPath, 'utf-8');
  const checks = QUALITY_CHECKS[gateId] ?? [];
  const failedChecks: string[] = [];
  const unevaluatedChecks: string[] = [];
  const dimensionRows: string[] = [];
  for (const q of checks) {
    const row = parseQualityRow(evalContent, q);
    if (row === null) {
      unevaluatedChecks.push(`${q}(row absent)`);
      dimensionRows.push(`${q}:ABSENT`); // 行缺失 ≠ PASS：账本必须能读出"没有证据"
    } else if (row === 'SKIP') {
      unevaluatedChecks.push(`${q}(SKIP)`);
      dimensionRows.push(`${q}:SKIP`);
    } else if (row === 'FAIL') {
      failedChecks.push(q);
      dimensionRows.push(`${q}:FAIL`);
    } else {
      dimensionRows.push(`${q}:PASS`);
    }
  }
  if (failedChecks.length > 0) {
    return { pass: false, detail: `Quality dimensions failed: ${failedChecks.join(', ')}`, dimensionRows };
  }
  if (unevaluatedChecks.length > 0) {
    return { pass: false, detail: `Quality dimensions not evaluated — gate cannot close without evidence: ${unevaluatedChecks.join(', ')}`, dimensionRows };
  }
  return { pass: true, detail: `Quality dimensions passed: ${checks.join(', ')}`, dimensionRows };
}

/** 质量门判定（gate-check.mjs:133-174 同构：三态——缺行/SKIP 都不能关门）。 */
export function checkQualityGate(workspaceRoot: string, gateId: string): GateCheckResult {
  // 薄包装：只暴露 {pass, detail}（既有测试用 toEqual 钉死该形状，逐维证据走 evaluateQualityGate）
  const { pass, detail } = evaluateQualityGate(workspaceRoot, gateId);
  return { pass, detail };
}

/**
 * 循环身份后缀（cycle-79 修 O-01）。被守卫缺陷：账本去重键是 (result, detail)，而 G1/G2/G3
 * 的 detail 原与循环无关 ⇒ 跨循环同结论被静默 dedup（cycle-78 的 G2/G3 仍是 cycle-77 记录）。
 * 修法：追加 `§cycle-N`。G0 不套（detail 已含 `in cycle-N`）；须与脚本同名函数逐字全等。
 */
function withCycleTag(result: GateCheckResult, latest: { name: string } | null): GateCheckResult {
  if (!latest) return result;
  return { ...result, detail: `${result.detail} §${latest.name}` };
}

const GATE_FN: Record<string, (ws: string, cfg: string | null) => GateCheckResult> = {
  G0: (ws) => checkG0(ws),
  G1: (ws) => checkG1(ws), // cycle-79 O-01：循环身份在 checkG1/G2/G3 内单点追加
  G2: (ws, cfg) => checkG2(ws, cfg),
  G3: (ws, cfg) => checkG3(ws, cfg), // cycle-80 WS-3：G3 另追加 dist revision 证据
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
      const qEval = evaluateQualityGate(workspaceRoot, g);
      // F-04：逐维裁决供 recordNative 拼账本 detail；只加附加字段（pass/detail 与脚本逐字节一致）
      const qResult: QualityGateDetail = qEval.dimensionRows
        ? { pass: qEval.pass, detail: qEval.detail, dimensionRows: qEval.dimensionRows }
        : { pass: qEval.pass, detail: qEval.detail };
      quality[g] = qResult;
      if (!qEval.pass) allPass = false;
    }
  }
  return { gates, quality, allPass, exitCode: allPass ? 0 : 1 };
}
