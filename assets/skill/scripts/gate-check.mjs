#!/usr/bin/env node
// gate-check.mjs — G0-G3 收敛门禁 + 质量门禁自动判定
// 用法: node scripts/gate-check.mjs <project-dir> [--gate G0|G1|G2|G3|all] [--quality] [--record]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseCliArgs } from './lib/args.mjs';
import { loadProjectConfig, getYamlString } from './lib/config.mjs';
import { getLatestCycleDir } from './lib/cycle.mjs';
import { parseTaskRows } from './lib/tasks.mjs';
import { appendEntry, loadLedger } from './lib/ledger.mjs';
import { resolveTimeout, timeoutFromConfig, isTimeoutError } from './lib/budget.mjs';

// 修 S-1：唯一 config 入口。原先读从未被 init-workflow 创建的 .cycles/cycle-config.yml，
// 且错误提示自相矛盾（"No .cycles/cycle-config.yml found. Run init-workflow first."——
// init-workflow 生成的是 config.yml）。缺配置 = 响亮失败，提示指向正确文件。
function loadConfig(projectDir) {
  try {
    return loadProjectConfig(projectDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// 修字典序缺陷：数值序取最新 cycle（原 .sort().pop() 在 cycle-10 之后选错目录）
const getLatestCycle = getLatestCycleDir;

/**
 * cycle 的**真实目录**：活跃区优先，归档区回退。
 * cycle-101：全部循环归档后活跃区合法为空（archive-cycle 正常收口态），
 * 旧实现一律拼 .cycles/cycles/<name> ⇒ G0/G1/G2 全判「缺失」并**写进不可变账本**
 * （假 FAIL 永久留痕，比评估器侧的假红更严重）。
 */
function cycleBaseDir(projectDir, cycleName) {
  const active = join(projectDir, '.cycles', 'cycles', cycleName);
  if (existsSync(active)) return active;
  const archived = join(projectDir, '.cycles', 'archive', cycleName);
  if (existsSync(archived)) return archived;
  return active;
}

// cycle-79 修 O-01（cycle-78 审计日志 §6 / 债务台账 O-01）：账本 `--record` 的去重键是
// (result, detail)，而 G1/G2/G3 的 detail 原先是**循环无关**字符串（如
// `Zero failures, zero errors (测试报告.md)`）⇒ 跨循环同结论被**静默 dedup**：
// 本循环没有自己的 G2/G3 审计条目（实测 cycle-78 的 G2/G3 仍是 cycle-77 05:02 的记录）。
// 修法：detail 末尾追加本循环身份 `§cycle-N`，让去重键自带循环身份——不同循环必然不同，
// 同循环重复跑仍命中 dedup。
// G0 不套本函数：它的 detail 已含 `in cycle-N`（四门因此都自带循环身份）。
// 无法确定循环（无 cycle 工作区）时不追加——宁可缺省，也不编造循环名。
function withCycleTag(result, cycleName) {
  if (!cycleName) return result;
  return { ...result, detail: `${result.detail} §${cycleName}` };
}

// cycle-80 WS-3 G-04：构建产物「新鲜度」证据。被守卫缺陷＝「源码改了忘 build」：
// G3 原先只跑 build_cmd 就判 PASS，**不记录它到底产出哪一份字节** ⇒ dist/ 是旧的
// （cycle-71 非功能报告实录两次：改完 src 未 build 即跑真机探针，测的是旧字节码，
// 而 dist/ 被 gitignore，提交清单里看不到它）也会"看起来全绿"。
// 修法：detail 追加 `[dist=<revision 前 8 位>]`——revision 内容哈希口径与宿主侧**同一算法**：
//   sha256( sha256(dist/host.js) + ":" + sha256(dist/client.js) ).slice(0, 16)，展示取前 8 位。
// dist 缺失/不可读 ⇒ `[dist=absent]`（诚实标注，绝不伪造位数）。该证据只增不改：G3 的
// pass/fail 仍只由 build_cmd 决定（新鲜度不是第二条判据），但 detail 变化会让 --record
// 去重键变化——这是预期：每份新产物都是新证据。
function distRevision(projectDir) {
  const hostPath = join(projectDir, 'dist', 'host.js');
  const clientPath = join(projectDir, 'dist', 'client.js');
  if (!existsSync(hostPath) || !existsSync(clientPath)) return null;
  try {
    const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const revision = createHash('sha256').update(`${fileHash(hostPath)}:${fileHash(clientPath)}`).digest('hex');
    return revision.slice(0, 16);
  } catch {
    return null;
  }
}

// 把产物证据拼在门 detail 末尾（与循环身份 §cycle-N 的先后顺序：cycle 先、dist 后）
function withDistEvidence(result, projectDir) {
  const revision = distRevision(projectDir);
  return { ...result, detail: `${result.detail} [dist=${revision ? revision.slice(0, 8) : 'absent'}]` };
}

// cycle-39 T-3903：读嵌套 YAML 布尔（gates.G2.journey_coverage 形态，两空格缩进）。
// 行级解析，零依赖；未声明 → false（默认不启用——旧行为不变）。
function getYamlNestedBoolean(content, section, key2, leaf) {
  const re = new RegExp(`^${section}:\\s*$\\n(?:[^\\n]*\\n)*?^\\s{2}${key2}:\\s*$\\n(?:[^\\n]*\\n)*?^\\s{4}${leaf}:\\s*(true|false)\\s*$`, 'm');
  const m = content.match(re);
  return m ? m[1] === 'true' : false;
}

function checkG0(projectDir) {
  const cyclesDir = join(projectDir, '.cycles', 'cycles');
  if (!existsSync(cyclesDir)) return { pass: false, detail: 'No .cycles directory' };

  // 修字典序缺陷：统一走 lib/cycle.mjs 数值序（原 .sort().pop() 在 cycle-10 之后选错目录）
  const latestCycle = getLatestCycle(projectDir);
  if (!latestCycle) return { pass: false, detail: 'No cycle workspace' };

  const evalReport = join(cycleBaseDir(projectDir, latestCycle), '项目评估报告.md');
  if (!existsSync(evalReport)) return { pass: false, detail: 'No evaluation report' };

  // 修 iteration-5（N-10 脚本侧）：存在性不是完整性。空报告、只有标题的报告、
  // 或维度行全被删掉的报告原先都能关闭 G0。门禁必须有裁决行作为证据。
  const evalContent = readFileSync(evalReport, 'utf-8');
  const verdictRows = evalContent.match(/^\|\s*(E[1-8]|Q[1-8])\s*\|/gm) || [];
  if (verdictRows.length === 0) {
    return { pass: false, detail: `Evaluation report has no dimension verdict rows (${latestCycle}/项目评估报告.md)` };
  }

  return { pass: true, detail: `Evaluation report found in ${latestCycle} (${verdictRows.length} dimension rows)` };
}

function checkG1(projectDir) {
  const cyclesDir = join(projectDir, '.cycles', 'cycles');
  const latestCycle = getLatestCycle(projectDir);
  if (!latestCycle) return { pass: false, detail: 'No cycle workspace' };
  const taskList = join(cycleBaseDir(projectDir, latestCycle), '任务清单.md');

  if (!existsSync(taskList)) return { pass: false, detail: 'No task list' };

  const content = readFileSync(taskList, 'utf-8');
  // 修 N-1（v1.8.0）：G1 从"整文件 includes('待办')"改为解析 P0-P3 任务表行。
  // v1.8.3：解析器抽到 lib/tasks.mjs（archive-cycle isCycleComplete 共用同一实现，
  // 消灭"G1 说完成、归档说没完成"的分叉）。
  const taskRows = parseTaskRows(content);

  if (taskRows.length === 0) return { pass: false, detail: 'No task entries found (fill the task tables in 任务清单.md)' };

  const pending = taskRows.filter(cells => cells[cells.length - 1] !== '完成');
  if (pending.length > 0) return { pass: false, detail: `${pending.length} of ${taskRows.length} tasks not completed` };
  return { pass: true, detail: `All ${taskRows.length} tasks completed` };
}

// cycle-39 T-3903：journey_coverage 门禁实现（此前 config.yml 的
// gates.G2.journey_coverage: true 是装饰性声明——零代码消费，审计发现）。
// 语义：config journeys 声明的每条旅程的 test_files 必须真实存在且非空。
// 「声明了旅程覆盖但没有可验证的测试映射」= 没有证据 = 不许关 G2。
// chaos_coverage：语义应为「混沌用例全过」，但 journeys 协议没有 chaos
// 旅程定义——声明与协议脱节，本仓 config.yml 已删除该键（诚实优先：
// 装饰性门禁声明是负债，不是保护）。
function checkJourneyCoverage(projectDir, configContent) {
  const journeyMatch = configContent.match(/^journeys:\s*$/m);
  if (!journeyMatch) return { pass: true, detail: 'No journeys declared (journey_coverage vacuously true)' };

  // 解析 journeys 段（行级，与 lib/config.mjs 同风格；test_files 形态 ["a", "b"]）
  const lines = configContent.split('\n');
  const startIdx = lines.findIndex(l => /^journeys:\s*$/.test(l));
  const missing = [];
  let journeyCount = 0;
  let inTestFiles = false;
  let currentJourney = '';
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 段结束
    const jm = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (jm) { journeyCount++; currentJourney = jm[1]; inTestFiles = false; continue; }
    if (/^\s*test_files:\s*\[(.*)\]\s*$/.test(line)) {
      inTestFiles = true;
      const files = (line.match(/^\s*test_files:\s*\[(.*)\]\s*$/)?.[1] ?? '')
        .split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (files.length === 0) {
        missing.push(`${currentJourney}: test_files declared but empty`);
      } else {
        for (const f of files) {
          if (!existsSync(join(projectDir, f))) missing.push(`${currentJourney}: ${f}`);
        }
      }
      continue;
    }
    if (inTestFiles) continue; // 多行数组形态忽略（本仓正典是单行）
  }
  if (journeyCount === 0) return { pass: true, detail: 'journeys section empty' };
  if (missing.length > 0) {
    return { pass: false, detail: `Journey coverage broken: ${missing.join('; ')} (journey_coverage requires declared test files to exist)` };
  }
  return { pass: true, detail: `Journey coverage OK (${journeyCount} journeys, all test files exist)` };
}

function checkG2(projectDir, configContent) {
  const cyclesDir = join(projectDir, '.cycles', 'cycles');
  const latestCycle = getLatestCycle(projectDir);
  if (!latestCycle) return { pass: false, detail: 'No cycle workspace' };
  const testReportsDir = join(cycleBaseDir(projectDir, latestCycle), 'test-reports');

  if (!existsSync(testReportsDir)) return { pass: false, detail: 'No test reports directory' };

  const reports = readdirSync(testReportsDir).filter(e => e.endsWith('.md'));
  if (reports.length === 0) return { pass: false, detail: 'No test reports' };

  // 修字典序（v1.8.0）：按修改时间取最新报告（原 .sort().pop() 字典序在
  // test-report-10 vs test-report-9 这类文件名上会选错"最新"）。
  //
  // cycle-72 修「派生报告顶替正典报告」（Lead 实测：同一缺陷连续触发三条假 FAIL 入账）：
  //   旧实现无差别取 mtime 最新 *.md，于是 test-reports/ 下**任何**新增 .md 都能顶替
  //   致证报告——`auto-fix-report.md`（auto-fix-loop 每次必产出的机器报告，无 §2 汇总表）
  //   与证据册/审计册（本就不该作为测试证据）都会让 G2 判 FAIL，且该 FAIL 经 --record
  //   写进**不可变**哈希链账本（假 FAIL 永久留痕）。
  //   修法：**正典命名优先**（测试报告.md / test-report.md），仅当正典名不存在时才回退
  //   到 mtime 最新；派生报告（auto-fix-report.md）永不作为致证。选中结果**必须回显**，
  //   并如实标注被忽略的更晚非正典报告（可审计：读的人要知道 G2 判的是哪一份）。
  const CANONICAL_REPORTS = ['测试报告.md', 'test-report.md'];
  const DERIVED_REPORTS = ['auto-fix-report.md'];
  const mtimeOf = (f) => statSync(join(testReportsDir, f)).mtimeMs;
  const canonical = CANONICAL_REPORTS.find(f => reports.includes(f)) ?? null;
  const eligible = reports.filter(f => !DERIVED_REPORTS.includes(f));
  const byMtime = eligible.map(f => ({ f, m: mtimeOf(f) })).sort((a, b) => b.m - a.m);
  const latestReport = canonical ?? (byMtime[0]?.f ?? reports[0]);
  // 被忽略的更晚非正典报告（如实回显，不静默）
  const newerNonCanonical = canonical
    ? eligible.filter(f => f !== canonical && mtimeOf(f) > mtimeOf(canonical))
    : [];
  const ignoredNote = newerNonCanonical.length > 0
    ? ` [ignored newer non-canonical: ${newerNonCanonical.join(', ')}]`
    : '';
  const content = readFileSync(join(testReportsDir, latestReport), 'utf-8');

  // 修 iteration-5：报告格式本身是契约（assets/templates/test-report.md §2 汇总表）。
  // 原先"失败/错误 行都不存在"会被解析成 0/0 并判 PASS——自由文本或残缺报告
  // 因此可以关掉 G2。格式无法识别 = 没有证据 = FAIL（不是 0 个失败）。
  if (!/^\|\s*(通过|失败|错误)\s*\|/m.test(content)) {
    return { pass: false, detail: `Test report summary not recognized: ${latestReport} has no 通过/失败 rows (expected the §2 汇总 table)${ignoredNote}` };
  }

  const failMatch = content.match(/\|\s*失败\s*\|\s*(\d+)\s*\|/);
  const errorMatch = content.match(/\|\s*错误\s*\|\s*(\d+)\s*\|/);

  const failures = failMatch ? parseInt(failMatch[1], 10) : 0;
  const errors = errorMatch ? parseInt(errorMatch[1], 10) : 0;

  if (failures > 0 || errors > 0) {
    return { pass: false, detail: `${failures} failures, ${errors} errors (${latestReport})${ignoredNote}` };
  }

  // cycle-39 T-3903：journey_coverage 检查（config gates.G2.journey_coverage: true 时启用）
  const journeyCoverage = getYamlNestedBoolean(configContent, 'gates', 'G2', 'journey_coverage');
  if (journeyCoverage) {
    const j = checkJourneyCoverage(projectDir, configContent);
    if (!j.pass) return { pass: false, detail: `${j.detail} (plus zero failures in ${latestReport})${ignoredNote}` };
  }
  return { pass: true, detail: `Zero failures, zero errors (${latestReport}${journeyCoverage ? ' + journey coverage verified' : ''})${ignoredNote}` };
}

function checkG3(projectDir, configContent) {
  // 引号容错解析（修 S-8：统一走 lib/config.mjs，不再各自写要求双引号的正则）
  const buildCmd = getYamlString(configContent, 'build_cmd');

  if (!buildCmd) return { pass: false, detail: 'No build command configured' };

  // cycle-96 WS-C：预算改由 lib/budget.mjs 单一事实源给出（原写死 120000，
  // 与 eval-runner 的同义调用点无对照）。可经 config build_timeout_ms 覆盖。
  const timeoutMs = resolveTimeout('build', { configMs: timeoutFromConfig(configContent, 'build') });
  try {
    execSync(buildCmd, { cwd: projectDir, timeout: timeoutMs, stdio: 'pipe', windowsHide: true });
    return { pass: true, detail: `Build passed: ${buildCmd}` };
  } catch (e) {
    // 超时不是「构建失败」：根本没有构建结论（半截输出会被读成失败原因）。
    // 判据复用 lib/budget.mjs 的 isTimeoutError（三处调用点同一形态，不各写一份）。
    if (isTimeoutError(e)) {
      return {
        pass: false,
        detail: `Build timed out after ${timeoutMs}ms budget: ${buildCmd} (raise build_timeout_ms or build separately)`,
      };
    }
    return { pass: false, detail: `Build failed: ${buildCmd}` };
  }
}

function checkQualityGate(projectDir, configContent, gateId) {
  const cycleDir = getLatestCycle(projectDir);
  if (!cycleDir) return { pass: false, detail: 'No cycle directory' };

  const evalResultsPath = join(cycleBaseDir(projectDir, cycleDir), '项目评估报告.md');
  if (!existsSync(evalResultsPath)) return { pass: false, detail: 'No eval results (run eval-runner first)' };

  const evalContent = readFileSync(evalResultsPath, 'utf-8');

  const qualityChecks = {
    G0: ['Q1', 'Q5'],
    G1: ['Q7'],
    G2: ['Q2'],
    G3: ['Q3', 'Q4'],
  };

  const checks = qualityChecks[gateId] || [];
  const failedChecks = [];
  const unevaluatedChecks = [];
  // cycle-77 修 F-04（cycle-72 债务台账 §4）：逐维裁决必须与账本 detail 同源。
  // 被守卫缺陷：质量结论原先只打印到 stdout，账本只记门的基本判定——G0 基本 PASS 而
  // Q5 FAIL 时账本留下 `G0 PASS`，读侧 fail-open（误判"上次 G0 全过"）。
  // 这里在**同一次解析**里记下每一维的裁决词（PASS/FAIL/SKIP/ABSENT），供 --record
  // 直接拼进 detail，不再二次解析报告（两次解析 = 两个真相源）。
  const dimensionRows = [];

  for (const q of checks) {
    // 修 iteration-5：三态。原先只有 'FAIL' 会被拦下——行缺失（match=null）与
    // SKIP（评估器无法评估）都静默通过，"缺证据=通过"正是 fail-open 的定义。
    const pattern = new RegExp(`^\\| ${q} \\|.*\\|\\s*(PASS|FAIL|SKIP)\\s*\\|`, 'm');
    const match = evalContent.match(pattern);
    if (!match) {
      unevaluatedChecks.push(`${q}(row absent)`);
      dimensionRows.push(`${q}:ABSENT`); // 行缺失 ≠ PASS：账本必须能读出"没有证据"
    } else if (match[1] === 'SKIP') {
      unevaluatedChecks.push(`${q}(SKIP)`);
      dimensionRows.push(`${q}:SKIP`);
    } else if (match[1] === 'FAIL') {
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

const args = parseCliArgs(process.argv, {
  script: 'gate-check',
  usage: 'Usage: node gate-check.mjs <project-dir> [--gate G0|G1|G2|G3|all] [--quality] [--record]',
  flags: { gate: { type: 'string', default: 'all' }, quality: { type: 'boolean' }, record: { type: 'boolean' } },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});

const projectDir = resolve(args._[0]);
const configContent = loadConfig(projectDir);

const gates = {
  G0: () => checkG0(projectDir),
  // cycle-79 O-01：G1/G2/G3 追加循环身份（与宿主原生 gateEngine.checkG1/G2/G3 逐字全等，
  // 差分契约抓漂移）。G0 除外——它的 detail 已含 `in cycle-N`。
  G1: () => withCycleTag(checkG1(projectDir), getLatestCycle(projectDir)),
  G2: () => withCycleTag(checkG2(projectDir, configContent), getLatestCycle(projectDir)),
  // cycle-80 WS-3：G3 再追加 dist revision 证据（cycle 身份在前、产物证据在后）
  G3: () => withDistEvidence(withCycleTag(checkG3(projectDir, configContent), getLatestCycle(projectDir)), projectDir),
};

const gatesToCheck = args.gate === 'all' ? ['G0', 'G1', 'G2', 'G3'] : [args.gate];
let allPass = true;

for (const g of gatesToCheck) {
  const result = gates[g]();
  const status = result.pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${g}: ${result.detail}`);
  if (!result.pass) allPass = false;

  // ── cycle-77 修 F-04（cycle-72 债务台账 §4「质量维不入账」）──────────────
  // 被守卫缺陷：旧顺序是「先 --record 记门的基本判定 → 之后才跑质量检查」，质量维结论
  // 只进 stdout 并置 allPass=false。于是 G0 基本 PASS / Q5 FAIL 时账本留下一条 `G0 PASS`，
  // 与最终裁决（exit 1 / FAILED）**是两个答案**——账本读侧 fail-open。
  // 修法：把质量裁决上移到落账**之前**（同源同刻），逐维裁决并入账本 detail
  // （形如 `... 3 dimension rows [Q1:PASS,Q5:FAIL]`），且质量维 FAIL 时账本结果记 FAIL。
  // 不带 --quality 时 detail 逐字节不变；退出码语义不变（仍有 FAIL 即 exit 1）。
  let finalPass = result.pass;
  let qualitySuffix = '';
  if (args.quality && result.pass) {
    const qResult = checkQualityGate(projectDir, configContent, g);
    const qStatus = qResult.pass ? 'PASS' : 'FAIL';
    console.log(`  [${qStatus}] ${g}-Quality: ${qResult.detail}`);
    if (!qResult.pass) {
      allPass = false;
      finalPass = false;
    }
    if (Array.isArray(qResult.dimensionRows) && qResult.dimensionRows.length > 0) {
      qualitySuffix = ` [${qResult.dimensionRows.join(',')}]`;
    }
  }

  // 修 N-2（v1.8.0）：--record 时把门禁结果写入账本（PASS 与 FAIL 都记——
  // org-status 的 CB2 熔断条件依赖账本里的 FAIL 记录）。带去重：该门最新一条
  // 记录的 (result, detail) 与本次相同时跳过，重复运行不会污染账本。
  // cycle-77：result/detail 取**含质量维的最终裁决**（见上方 F-04 段）。
  // cycle-79（O-01）：detail = `<门 detail（G1-G3 已含 §cycle-N）><质量段>`——去重键因此
  // 自带循环身份，跨循环同结论不会再被静默 dedup；同循环重复跑仍命中 unchanged 分支。
  if (args.record) {
    const ledgerStatus = finalPass ? 'PASS' : 'FAIL';
    const ledgerDetail = `${result.detail || 'N/A'}${qualitySuffix}`;
    const ledger = loadLedger(projectDir);
    const lastForGate = [...ledger.entries].reverse().find(e => e.gate === g);
    if (lastForGate && lastForGate.result === ledgerStatus && lastForGate.detail === ledgerDetail) {
      console.log(`  [LEDGER] ${g} unchanged, not re-recorded`);
    } else {
      const entry = appendEntry(projectDir, g, ledgerStatus, ledgerDetail);
      console.log(`  [LEDGER] ${g} ${entry.result} recorded (hash ${entry.hash.substring(0, 16)}...)`);
    }
  }
}

if (!allPass) {
  console.error('\nGate check FAILED. Fix issues before proceeding.');
  process.exit(1);
} else {
  console.log('\nAll gates PASSED.');
}