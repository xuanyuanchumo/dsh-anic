#!/usr/bin/env node
// org-status.mjs — Agent 组织状态管理 CLI：支持 status/agent/review/auto-fallback 命令
// 用法:
//   状态: node org-status.mjs <project-dir> status
//   Agent: node org-status.mjs <project-dir> agent [--role <role>] [--assign <model>]
//   审查: node org-status.mjs <project-dir> review
//   熔断回退: node org-status.mjs <project-dir> auto-fallback

import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './lib/args.mjs';
import { loadProjectConfig, getAutonomyLevel as getAutonomyLevelFromConfig } from './lib/config.mjs';
import { getLatestCycleDir, listCycleDirNames } from './lib/cycle.mjs';
import { atomicWriteFileSync } from './lib/fs-safe.mjs';

const CIRCUIT_BREAKER_CONDITIONS = [
  { id: 'CB1', name: '同一异常连续3次自动修复失败', check: (projectDir) => {
    const incidentsDir = join(projectDir, '.cycles', 'incidents');
    if (!existsSync(incidentsDir)) return { triggered: false };
    const files = readdirSync(incidentsDir).filter(f => f.includes('auto-fix-fail'));
    return { triggered: files.length >= 3, detail: `${files.length} consecutive auto-fix failures` };
  }},
  { id: 'CB2', name: '门禁自动判定存疑且无法自动定论', check: (projectDir) => {
    // 归一 + 可观测（cycle-78 WS-G）：账本不可用时明确 SKIP 并点名原因，
    // 不再「裸数组 → TypeError → 整个 org-status 崩溃」，也不静默当成「无 DOUBT」。
    const ledger = loadLedgerEntries(projectDir);
    if (!ledger.ok) return { triggered: false, skipped: true, detail: `ledger unavailable — ${ledger.reason}` };
    const ambiguous = ledgerDoubtCount(ledger.entries);
    return { triggered: ambiguous > 0, detail: `${ambiguous} ambiguous gate results` };
  }},
  { id: 'CB3', name: '涉及真实用户数据/明文凭据且无隔离方案', check: (projectDir) => {
    const incidentsDir = join(projectDir, '.cycles', 'incidents');
    if (!existsSync(incidentsDir)) return { triggered: false };
    const files = readdirSync(incidentsDir).filter(f => f.includes('H1') && f.includes('circuit'));
    return { triggered: files.length > 0, detail: `${files.length} H1 circuit breaker incidents` };
  }},
  { id: 'CB4', name: '破坏性操作影响范围不可评估或不可回滚', check: (projectDir) => {
    const incidentsDir = join(projectDir, '.cycles', 'incidents');
    if (!existsSync(incidentsDir)) return { triggered: false };
    const files = readdirSync(incidentsDir).filter(f => f.includes('H2') && f.includes('circuit'));
    return { triggered: files.length > 0, detail: `${files.length} H2 circuit breaker incidents` };
  }},
  { id: 'CB5', name: '性能指标超预警阈值且1轮优化后仍未恢复', check: (projectDir) => bandUnrecovered(projectDir) },
  { id: 'CB6', name: '人类主动要求审计/切换到L3', check: (projectDir) => {
    const configContent = loadConfig(projectDir);
    const match = configContent.match(/human_override:\s*(L3|true)/i);
    return { triggered: !!match, detail: match ? 'Human override requested' : '' };
  }},
  { id: 'CB7', name: '无人值守超时/资源上限', check: (projectDir) => {
    const configContent = loadConfig(projectDir);
    const timeoutMatch = configContent.match(/session_timeout:\s*(\d+)/);
    if (!timeoutMatch) return { triggered: false };
    const timeoutHours = parseInt(timeoutMatch[1]);
    return { triggered: timeoutHours > 24, detail: `Session timeout ${timeoutHours}h > 24h limit` };
  }},
  { id: 'CB8', name: '自动化资源上限（累计重试>10次或熔断>3次）', check: (projectDir) => {
    const incidentsDir = join(projectDir, '.cycles', 'incidents');
    if (!existsSync(incidentsDir)) return { triggered: false };
    const allIncidents = readdirSync(incidentsDir);
    const circuitIncidents = allIncidents.filter(f => f.includes('circuit'));
    return { triggered: circuitIncidents.length > 3, detail: `${circuitIncidents.length} total circuit incidents (>3)` };
  }},
];

const AUTONOMY_LEVELS = {
  L1: { name: '辅助模式', desc: '人类主导，Agent 提供建议和草案', color: 'BLUE' },
  L2: { name: '协作模式', desc: 'Agent 执行，人类审批关键决策', color: 'YELLOW' },
  L3: { name: '自主模式', desc: 'Agent 自主执行，人类监控门禁', color: 'GREEN' },
  L4: { name: '全自动模式', desc: 'Agent 全自主，人类仅干预异常', color: 'RED' },
};

// —— CB5 形状归一 + 双形状判据（cycle-78 WS-F）——
// 被修缺陷（fail-open，本轮实测）：原 CB5 读 `history.snapshots`，而 `band-detector.mjs`
// 写入 `.cycles/band-history.json` 的是**裸数组** ⇒ `snapshots` undefined ⇒ 取 `.length`
// 抛 TypeError 被 `catch { return { triggered: false } }` 吞掉 ⇒ **技能侧 CB5 永不触发**
// （该熔断的安全作用等于不存在，且没有任何断言会红）。附带第二处死谓词：
// 旧判据 `s.status === 'OVER_BUDGET'` —— 没有任何生产者写过 `status` 字段。
//
// 宿主侧同族实现 src/host/evolution/breakerSignals.ts 已按「双形状」修复，本处与其
// **逐字同语义**（同一判定两份实现必须同义，否则差分契约迟早以「一边触发一边不触发」变红）：
//   · 容器归一：裸数组直接用；`{ snapshots: [...] }` 包裹取内部数组；其他 → null
//   · 单条判据：`band === 'alarm'`（自主带形状）或 `overBudgetCount > 0`（质量带形状=
//     真实生产形状：该轮存在超预算文件即质量未恢复）
//   · 判定：末 2 条**都**命中才触发（「连续 2 轮」）；不足 2 条 / 坏 JSON / 非数组 →
//     不触发且**不抛**（采集失败是「没信号」，不是「熔断」，也不能让 org-status 崩）
function normalizeBandHistory(history) {
  if (Array.isArray(history)) return history;
  if (history && typeof history === 'object' && Array.isArray(history.snapshots)) return history.snapshots;
  return null;
}

function bandEntryUnrecovered(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.band === 'alarm') return true; // 自主带形状（既有语义，向后兼容）
  return typeof entry.overBudgetCount === 'number' && entry.overBudgetCount > 0; // 质量带形状
}

/** CB5 信号：末 2 条 band-history 快照均「性能未恢复」才触发。 */
function bandUnrecovered(projectDir) {
  const bandHistoryPath = join(projectDir, '.cycles', 'band-history.json');
  if (!existsSync(bandHistoryPath)) return { triggered: false };
  try {
    const entries = normalizeBandHistory(JSON.parse(readFileSync(bandHistoryPath, 'utf-8')));
    if (!entries || entries.length < 2) return { triggered: false };
    const bothOver = entries.slice(-2).every(bandEntryUnrecovered);
    // detail 只在真触发时给出：非触发却打印「连续超预算」会自相矛盾（旧形态的隐患）
    return bothOver
      ? { triggered: true, detail: 'Complexity over budget for 2 consecutive cycles' }
      : { triggered: false };
  } catch { return { triggered: false }; }
}

// —— 账本形状归一 + 可观测加载（cycle-78 WS-G）——
// 被修缺陷（**崩溃**，比 fail-open 更坏）：CB2 检查、CB2 诊断、review 汇总三处各自
// 直接 `ledger.entries.slice(-4)` / `ledger.entries.filter(...)`，而宿主侧 ledgerHasDoubt
// 两种形状（`{entries:[…]}` 包裹 / 裸数组）都接受。遇到裸数组账本时 `entries` 为
// undefined ⇒ 未捕获 TypeError ⇒ **整个 org-status 崩溃**（实测
// `TypeError: ledger.entries.slice is not a function`，连 CB1…CB8 一行都打印不出来）。
// 当前生产不可达仅因 gate-ledger.mjs 写包裹形态——形状口径不一致是随时可爆的定时器。
//
// 归一语义（与宿主侧同口径，纯形状处理，绝不改写条目内容）：
//   · 包裹 `{ entries: [...] }` → 取 entries
//   · 裸数组 → 原样使用（条目集合等价；账本是"条目列表"，外层包装只是容器）
//   · 其他形状 / 坏 JSON / 缺文件 → ok:false + reason（**不抛**）
// **必须在读 .entries 之前判 Array.isArray**：裸数组上的 `.entries` 不是 undefined，而是
// `Array.prototype.entries` 这个**函数**——所以旧代码的报错是
// `ledger.entries.slice is not a function`（在函数上找 slice），而 `gate-ledger --verify`
// 里 `ledger.entries.length` 恰好等于函数的形参个数 0 ⇒ 静默「0 条 + Valid: YES」。
// 这个原型方法遮蔽是同一形状错误在同一仓里表现为「崩溃」与「静默清空」两种症状的根因。
// 诚实语义（反 fail-open，也反误报）：账本不可用时 CB2 **明确 SKIP 并点名原因**——
// 既不静默当成「无 DOUBT」（旧的 fail-open 方向），也不据此触发熔断（采集失败 ≠ 事故）。
const LEDGER_REL = ['.cycles', 'gates', 'ledger.json'];

function loadLedgerEntries(projectDir) {
  const ledgerPath = join(projectDir, ...LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    return { ok: false, entries: [], reason: `ledger missing (${LEDGER_REL.join('/')})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  } catch (err) {
    return { ok: false, entries: [], reason: `ledger unparsable: ${err && err.message ? err.message : String(err)}` };
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries) ? parsed.entries : null);
  if (!entries) {
    return { ok: false, entries: [], reason: 'ledger shape not recognized (expected array or { entries: [...] })' };
  }
  return { ok: true, entries, reason: null };
}

/** CB2 判据（与宿主侧 ledgerHasDoubt 逐字同语义）：最近 4 条中 FAIL 且 detail 空/含 ambiguous。
 * 注意不认 `result === 'doubt'`：没有任何生产者写过该值（gate-ledger 只接受 PASS|FAIL），
 * 双实现口径必须一致，否则「一边触发一边不触发」的差分漂移会重新出现。 */
function ledgerDoubtCount(entries) {
  return entries
    .slice(-4)
    .filter(e => e && e.result === 'FAIL' && (!e.detail || String(e.detail).includes('ambiguous')))
    .length;
}

const AGENT_ROLES = {
  orchestrator: { name: '编排者', desc: '分解任务、分配给子 Agent、汇总结果' },
  builder: { name: '构建者', desc: '编写代码、创建测试、修复缺陷' },
  reviewer: { name: '审查者', desc: '审查代码、验证规格符合度、安全审计' },
  evaluator: { name: '评估者', desc: '运行评估维度、生成评估报告' },
  gatekeeper: { name: '门禁守卫', desc: '执行门禁检查、记录结果、阻止未通过流转' },
};

// 修 S-1：配置统一走 scripts/lib/config.mjs。org-status 是观察型命令，允许在未 init
// 的项目上运行（门禁类脚本才强制 fail-loud），但缺配置必须说出来，不得静默。
function loadConfig(projectDir) {
  try {
    return loadProjectConfig(projectDir);
  } catch {
    console.error(`[config] .cycles/config.yml not found in ${projectDir}; autonomy status defaults to L2 (run init-workflow to create it)`);
    return '';
  }
}

// 修 S-7/S-8：引号容错解析统一走 lib/config.mjs（原 /autonomy_level:\s*(L[1-4])/
// 匹配不了 autonomy_level: "L4"——这正是"降级记录与实际级别脱钩"的根因之一）。
// 保持原默认值 L2 不变。
function getAutonomyLevel(configContent) {
  return getAutonomyLevelFromConfig(configContent, 'L2');
}

// 修 S-7：降级 = 写入 → 回读 → 按回读事实记录（Post-Verify，docs/anic/09 §6.6）。
// 原实现 content.replace(/autonomy_level:\s*L4/, ...) 对带引号的 "L4" 不匹配，
// 却无条件打印 'Autonomy downgraded' 并写"已降级"事故记录——写后从不回读。
function applyAutonomyDowngrade(projectDir, fromLevel, toLevel) {
  const configPath = join(projectDir, '.cycles', 'config.yml');
  if (!existsSync(configPath)) {
    return { ok: false, observedLevel: fromLevel, reason: 'config file missing' };
  }
  const content = readFileSync(configPath, 'utf-8');
  const rewrite = new RegExp(`autonomy_level:\\s*["']?${fromLevel}["']?`);
  if (!rewrite.test(content)) {
    return { ok: false, observedLevel: getAutonomyLevel(content), reason: `autonomy_level pattern for ${fromLevel} not found in config` };
  }
  atomicWriteFileSync(configPath, content.replace(rewrite, `autonomy_level: ${toLevel}`));
  // Post-Verify：回读并按实际解析结果判定，不信任写入意图
  const observedLevel = getAutonomyLevel(readFileSync(configPath, 'utf-8'));
  return { ok: observedLevel === toLevel, observedLevel, reason: observedLevel === toLevel ? '' : `re-read got ${observedLevel}, expected ${toLevel}` };
}

function getCircuitBreakerState(projectDir) {
  const cyclesBaseDir = join(projectDir, '.cycles', 'cycles');
  if (!existsSync(cyclesBaseDir)) return { tripped: false, count: 0 };

  // v1.8.3：数值序（原 sort() 字典序让"连续失败统计"在 cycle-10 之后乱序——
  // 连续性统计对遍历顺序敏感，乱序会算错 maxConsecutive）
  const cycleDirs = listCycleDirNames(cyclesBaseDir);
  let consecutiveFailures = 0;
  let maxConsecutive = 0;

  for (const cd of cycleDirs) {
    const evalPath = join(cyclesBaseDir, cd, '项目评估报告.md');
    if (existsSync(evalPath)) {
      const content = readFileSync(evalPath, 'utf-8');
      const statusMatch = content.match(/综合判定[：:]\s*(PASS|FAIL)/) || content.match(/状态[：:]\s*(PASS|FAIL)/);
      const isFail = statusMatch ? statusMatch[1] === 'FAIL' : false;
      if (isFail) {
        consecutiveFailures++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveFailures);
      } else {
        consecutiveFailures = 0;
      }
    }
  }

  return {
    tripped: maxConsecutive >= 3,
    count: maxConsecutive,
    threshold: 3,
  };
}

function getAgentAssignments(configContent) {
  const assignments = {};
  const sectionMatch = configContent.match(/agent_org:[\s\S]*?(?=\n[a-z]|\n#|$)/);
  if (sectionMatch) {
    const section = sectionMatch[0];
    const rolePattern = /(\w+):\s*"([^"]+)"/g;
    let match;
    while ((match = rolePattern.exec(section)) !== null) {
      if (AGENT_ROLES[match[1]]) {
        assignments[match[1]] = match[2];
      }
    }
  }
  return assignments;
}

function updateAgentAssignment(projectDir, role, model) {
  const configPath = join(projectDir, '.cycles', 'config.yml');
  if (!existsSync(configPath)) {
    console.error('Config file not found. Run init-workflow first.');
    process.exit(1);
  }

  let content = readFileSync(configPath, 'utf-8');

  if (!AGENT_ROLES[role]) {
    console.error(`Unknown role: ${role}. Valid roles: ${Object.keys(AGENT_ROLES).join(', ')}`);
    process.exit(1);
  }

  const pattern = new RegExp(`(agent_org:[\\s\\S]*?${role}:\\s*")([^"]*)(")`, 'g');
  if (pattern.test(content)) {
    content = content.replace(pattern, `$1${model}$3`);
  } else {
    if (!content.includes('agent_org:')) {
      content += '\nagent_org:\n';
    }
    content += `  ${role}: "${model}"\n`;
  }

  atomicWriteFileSync(configPath, content);
  console.log(`Updated ${role} -> ${model}`);
}

function getReviewSummary(projectDir) {
  // 账本汇总先算、且**两条 return 分支形状必须一致**（cycle-78 WS-G）：原先「无
  // .cycles/cycles 目录」的提前 return 只给 {totalCycles, reviews}，而 cmdReview 直接读
  // `summary.gateSummary.passed` ⇒ 在未初始化/空工作区上 `org-status review` 必崩
  // （本轮实测 TypeError）。同族纪律：同一函数的多个出口不能给出不同形状。
  const ledger = loadLedgerEntries(projectDir);
  const gateSummary = { passed: 0, failed: 0 };
  if (ledger.ok) {
    gateSummary.passed = ledger.entries.filter(e => e && e.result === 'PASS').length;
    gateSummary.failed = ledger.entries.filter(e => e && e.result === 'FAIL').length;
  }
  // 不可用时如实标注：不把「读不到账本」伪装成「通过 0 / 失败 0」这种看起来正常的统计
  const ledgerReason = ledger.ok ? null : ledger.reason;

  const cyclesBaseDir = join(projectDir, '.cycles', 'cycles');
  if (!existsSync(cyclesBaseDir)) return { totalCycles: 0, reviews: [], gateSummary, ledgerReason };

  // v1.8.3：数值序（评审摘要按 cycle 序展示，字典序在两位数后乱序）
  const cycleDirs = listCycleDirNames(cyclesBaseDir);
  const reviews = [];

  for (const cd of cycleDirs) {
    const evalPath = join(cyclesBaseDir, cd, '项目评估报告.md');
    if (existsSync(evalPath)) {
      const content = readFileSync(evalPath, 'utf-8');
      const scores = {};
      const scorePattern = /E(\d)[^\d]*(\d+(?:\.\d+)?)/g;
      let match;
      while ((match = scorePattern.exec(content)) !== null) {
        scores[`E${match[1]}`] = parseFloat(match[2]);
      }
      const hasFail = content.includes('FAIL') || content.includes('失败');
      reviews.push({ cycle: cd, scores, hasFail });
    }
  }

  return { totalCycles: cycleDirs.length, reviews, gateSummary, ledgerReason };
}

function cmdStatus(projectDir) {
  const configContent = loadConfig(projectDir);
  const autonomyLevel = getAutonomyLevel(configContent);
  const circuitBreaker = getCircuitBreakerState(projectDir);
  const assignments = getAgentAssignments(configContent);
  const levelInfo = AUTONOMY_LEVELS[autonomyLevel];

  console.log(`=== Agent Organization Status ===`);
  console.log(`Project: ${projectDir}`);
  console.log(``);

  console.log(`Autonomy Level: ${autonomyLevel} — ${levelInfo.name}`);
  console.log(`  Description: ${levelInfo.desc}`);
  console.log(``);

  console.log(`Circuit Breaker:`);
  console.log(`  State: ${circuitBreaker.tripped ? 'TRIPPED (autonomy downgraded to L1)' : 'OK'}`);
  console.log(`  Consecutive failures: ${circuitBreaker.count}/${circuitBreaker.threshold}`);
  console.log(``);

  console.log(`Agent Roles:`);
  for (const [key, role] of Object.entries(AGENT_ROLES)) {
    const assigned = assignments[key] || 'unassigned';
    console.log(`  ${role.name} (${key}): ${assigned}`);
    console.log(`    ${role.desc}`);
  }
  console.log(``);

  if (circuitBreaker.tripped) {
    console.error(`Circuit breaker TRIPPED. Autonomy downgraded to L1. Human intervention required.`);
  }

  console.log(`=== End of Org Status ===`);
}

function cmdAgent(projectDir, role, assign) {
  if (role && assign) {
    updateAgentAssignment(projectDir, role, assign);
    return;
  }

  const configContent = loadConfig(projectDir);
  const assignments = getAgentAssignments(configContent);

  console.log(`=== Agent Role Assignments ===`);
  console.log(``);

  for (const [key, roleInfo] of Object.entries(AGENT_ROLES)) {
    const assigned = assignments[key] || 'unassigned';
    console.log(`  ${roleInfo.name} (${key})`);
    console.log(`    Description: ${roleInfo.desc}`);
    console.log(`    Assigned model: ${assigned}`);
    console.log(``);
  }

  if (!role && !assign) {
    console.log(`To assign a model: node org-status.mjs <project-dir> agent --role <role> --assign <model>`);
    console.log(`Valid roles: ${Object.keys(AGENT_ROLES).join(', ')}`);
  }
}

function cmdReview(projectDir) {
  const summary = getReviewSummary(projectDir);
  const configContent = loadConfig(projectDir);
  const autonomyLevel = getAutonomyLevel(configContent);
  const circuitBreaker = getCircuitBreakerState(projectDir);

  console.log(`=== Organization Review ===`);
  console.log(`Project: ${projectDir}`);
  console.log(``);

  console.log(`Autonomy Level: ${autonomyLevel}`);
  console.log(`Circuit Breaker: ${circuitBreaker.tripped ? 'TRIPPED' : 'OK'} (${circuitBreaker.count}/${circuitBreaker.threshold})`);
  console.log(`Total Cycles: ${summary.totalCycles}`);
  console.log(``);

  console.log(`Gate Summary:`);
  console.log(`  Passed: ${summary.gateSummary.passed}`);
  console.log(`  Failed: ${summary.gateSummary.failed}`);
  // 账本不可用时明细为 0/0，必须点名，否则读者会把「读不到」当成「全过」
  if (summary.ledgerReason) console.log(`  (ledger unavailable — ${summary.ledgerReason})`);
  console.log(``);

  if (summary.reviews.length > 0) {
    console.log(`Cycle Reviews:`);
    for (const r of summary.reviews) {
      const scoreStr = Object.entries(r.scores)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`  ${r.cycle}: ${r.hasFail ? 'FAIL' : 'PASS'} | ${scoreStr || 'no scores'}`);
    }
  } else {
    console.log(`No cycle reviews found.`);
  }

  console.log(``);

  const allScores = summary.reviews.flatMap(r => Object.values(r.scores));
  if (allScores.length > 0) {
    const avg = allScores.reduce((s, v) => s + v, 0) / allScores.length;
    const min = Math.min(...allScores);
    const max = Math.max(...allScores);
    console.log(`Score Statistics:`);
    console.log(`  Average: ${avg.toFixed(2)}`);
    console.log(`  Min: ${min.toFixed(2)} | Max: ${max.toFixed(2)}`);
  }

  console.log(``);
  console.log(`=== End of Review ===`);
}

function diagnoseCondition(projectDir, cond) {
  const diagnosis = { id: cond.id, name: cond.name, rootCause: '', fixAction: '', fixable: false };

  switch (cond.id) {
    case 'CB1': {
      const incidentsDir = join(projectDir, '.cycles', 'incidents');
      if (!existsSync(incidentsDir)) break;
      const files = readdirSync(incidentsDir).filter(f => f.includes('auto-fix-fail'));
      if (files.length === 0) break;

      let lastError = '';
      for (const f of files.slice(-3)) {
        const content = readFileSync(join(incidentsDir, f), 'utf-8');
        const reasonMatch = content.match(/原因[：:]\s*(.+)/);
        if (reasonMatch) lastError = reasonMatch[1].trim();
      }
      diagnosis.rootCause = `连续自动修复失败，最近错误: ${lastError || '未知'}`;
      diagnosis.fixAction = '运行 auto-fix-loop.mjs --max-retries 5 进行更深层次的修复尝试';
      diagnosis.fixable = true;
      break;
    }
    case 'CB2': {
      // 与 check 共用同一归一函数（cycle-78 WS-G）：诊断不得另写第二份账本解析，
      // 否则「check 说触发、诊断找不到原因」这类双实现漂移必然重现。
      const ledger = loadLedgerEntries(projectDir);
      if (!ledger.ok) break;
      const ambiguousEntries = ledger.entries
        .slice(-4)
        .filter(e => e && e.result === 'FAIL' && (!e.detail || String(e.detail).includes('ambiguous')));

      if (ambiguousEntries.length > 0) {
        const gates = ambiguousEntries.map(e => e.gate).join(', ');
        diagnosis.rootCause = `门禁 ${gates} 判定存疑，缺少充分详情`;
        diagnosis.fixAction = `重新运行 gate-check.mjs --gate ${gates} 获取更详细的判定证据`;
        diagnosis.fixable = true;
      }
      break;
    }
    case 'CB3': {
      const incidentsDir = join(projectDir, '.cycles', 'incidents');
      if (!existsSync(incidentsDir)) break;
      const files = readdirSync(incidentsDir).filter(f => f.includes('H1') && f.includes('circuit'));
      if (files.length === 0) break;

      for (const f of files) {
        const content = readFileSync(join(incidentsDir, f), 'utf-8');
        if (content.includes('.env')) {
          diagnosis.rootCause = '涉及 .env 文件但未在 .gitignore 中';
          diagnosis.fixAction = '将 .env 添加到 .gitignore，或创建 .env.example 模板';
          diagnosis.fixable = true;
          break;
        }
        if (content.includes('credentials') || content.includes('secret') || content.includes('password')) {
          diagnosis.rootCause = '涉及明文凭据文件';
          diagnosis.fixAction = '将敏感文件添加到 .gitignore，使用环境变量替代明文凭据';
          diagnosis.fixable = true;
          break;
        }
      }
      break;
    }
    case 'CB4': {
      const incidentsDir = join(projectDir, '.cycles', 'incidents');
      if (!existsSync(incidentsDir)) break;
      const files = readdirSync(incidentsDir).filter(f => f.includes('H2') && f.includes('circuit'));
      if (files.length === 0) break;

      for (const f of files) {
        const content = readFileSync(join(incidentsDir, f), 'utf-8');
        if (content.includes('Large impact scope')) {
          diagnosis.rootCause = '破坏性操作影响范围过大（>10文件）';
          diagnosis.fixAction = '将变更拆分为更小的批次，每批≤10文件';
          diagnosis.fixable = false;
          break;
        }
        if (content.includes('No git history')) {
          diagnosis.rootCause = '无 git 历史可用于回滚';
          diagnosis.fixAction = '初始化 git 仓库并提交当前状态作为回滚基线';
          diagnosis.fixable = true;
          break;
        }
      }
      break;
    }
    case 'CB5': {
      // 与 check 同一套归一化/双形状判据（cycle-78 WS-F）——诊断不得另写一份解析，
      // 否则「check 说触发、诊断找不到原因」这类双实现漂移会再次出现。
      const bandHistoryPath = join(projectDir, '.cycles', 'band-history.json');
      if (!existsSync(bandHistoryPath)) break;
      try {
        const entries = normalizeBandHistory(JSON.parse(readFileSync(bandHistoryPath, 'utf-8')));
        if (!entries || entries.length < 2) break;
        const recent = entries.slice(-2);
        if (!recent.every(bandEntryUnrecovered)) break;
        const last = recent[recent.length - 1] ?? {};
        const hotspots = Array.isArray(last.hotspots) ? last.hotspots : [];
        const overCount = typeof last.overBudgetCount === 'number' ? last.overBudgetCount : 0;
        // 两种形状的「证据来源」不同：自主带快照没有 overBudgetCount，质量带快照没有
        // 逐文件热点清单 → 如实说明来源，不要用 0/空串假装「没有热点文件」。
        const shapeText = last.band === 'alarm'
          ? '自主带快照 band=alarm，无逐文件清单'
          : `质量带快照，该轮 overBudgetCount=${overCount}，无逐文件清单`;
        const hotspotText = hotspots.length > 0
          ? hotspots.slice(0, 3).map(h => h.file).join(', ')
          : shapeText;
        diagnosis.rootCause = `复杂度连续超预算，热点文件: ${hotspotText}`;
        diagnosis.fixAction = '对热点文件进行重构，拆分复杂函数，降低圈复杂度';
        diagnosis.fixable = true;
      } catch { break; }
      break;
    }
    case 'CB6': {
      diagnosis.rootCause = '人类主动要求审计或切换到 L3';
      diagnosis.fixAction = '无需自动修复，人类已主动介入';
      diagnosis.fixable = false;
      break;
    }
    case 'CB7': {
      diagnosis.rootCause = '无人值守超时或资源上限';
      diagnosis.fixAction = '启动新会话并释放资源';
      diagnosis.fixable = false;
      break;
    }
    case 'CB8': {
      const incidentsDir = join(projectDir, '.cycles', 'incidents');
      if (!existsSync(incidentsDir)) break;
      const allIncidents = readdirSync(incidentsDir);
      const circuitIncidents = allIncidents.filter(f => f.includes('circuit'));
      diagnosis.rootCause = `累计熔断 ${circuitIncidents.length} 次（>3），自动化资源耗尽`;
      diagnosis.fixAction = '清理旧的熔断事故记录，重置重试计数';
      diagnosis.fixable = true;
      break;
    }
  }

  return diagnosis;
}

function attemptAutoFix(projectDir, diagnosis) {
  if (!diagnosis.fixable) {
    console.log(`  [SKIP] ${diagnosis.id}: 无法自动修复 — ${diagnosis.rootCause}`);
    return { success: false, reason: 'not fixable' };
  }

  console.log(`  [DIAGNOSE] ${diagnosis.id}: ${diagnosis.rootCause}`);
  console.log(`  [FIX ACTION] ${diagnosis.fixAction}`);

  switch (diagnosis.id) {
    case 'CB3': {
      const gitignorePath = join(projectDir, '.gitignore');
      let gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
      const envPatterns = ['.env', '.env.local', '.env.production', '.env.*'];
      let added = [];
      for (const p of envPatterns) {
        if (!gitignore.includes(p)) {
          gitignore += `${p}\n`;
          added.push(p);
        }
      }
      if (added.length > 0) {
        atomicWriteFileSync(gitignorePath, gitignore);
        console.log(`  [FIXED] 已将 ${added.join(', ')} 添加到 .gitignore`);
        return { success: true, action: `Added ${added.join(', ')} to .gitignore` };
      }
      return { success: false, reason: 'no patterns to add' };
    }
    case 'CB4': {
      if (diagnosis.fixAction.includes('初始化 git')) {
        try {
          execSync('git init && git add -A && git commit -m "baseline for rollback"', {
            cwd: projectDir,
            timeout: 10000, stdio: 'pipe', encoding: 'utf-8',
            windowsHide: true, // cycle-99c：CB4 自动修复的 git 子进程不弹窗
          });
          console.log(`  [FIXED] Git 仓库已初始化并创建基线提交`);
          return { success: true, action: 'Initialized git repo with baseline commit' };
        } catch (e) {
          console.log(`  [FIX FAILED] Git 初始化失败: ${e.message}`);
          return { success: false, reason: e.message };
        }
      }
      return { success: false, reason: 'impact scope too large, requires human judgment' };
    }
    case 'CB8': {
      const incidentsDir = join(projectDir, '.cycles', 'incidents');
      if (!existsSync(incidentsDir)) return { success: false, reason: 'no incidents dir' };
      const allIncidents = readdirSync(incidentsDir);
      const oldCircuitIncidents = allIncidents.filter(f => f.includes('circuit'));
      let cleaned = 0;
      for (const f of oldCircuitIncidents) {
        const filePath = join(incidentsDir, f);
        try {
          unlinkSync(filePath);
          cleaned++;
        } catch {}
      }
      if (cleaned > 0) {
        console.log(`  [FIXED] 已清理 ${cleaned} 个旧熔断事故记录，重置重试计数`);
        return { success: true, action: `Cleaned ${cleaned} old circuit incident records` };
      }
      return { success: false, reason: 'could not clean incident records' };
    }
    default:
      console.log(`  [MANUAL FIX REQUIRED] ${diagnosis.fixAction}`);
      return { success: false, reason: 'requires manual intervention' };
  }
}

function cmdAutoFallback(projectDir) {
  const configContent = loadConfig(projectDir);
  const currentLevel = getAutonomyLevel(configContent);
  const circuitBreaker = getCircuitBreakerState(projectDir);

  console.log(`=== Auto-Fallback Assessment (Fix-First Strategy) ===`);
  console.log(`Current Autonomy Level: ${currentLevel}`);
  console.log(`Circuit Breaker State: ${circuitBreaker.tripped ? 'TRIPPED' : 'OK'} (${circuitBreaker.count}/${circuitBreaker.threshold})`);
  console.log(``);

  let anyTriggered = false;
  const triggeredConditions = [];
  const fixResults = [];

  for (const cond of CIRCUIT_BREAKER_CONDITIONS) {
    const result = cond.check(projectDir);
    // 三态：TRIGGERED / OK / SKIP。SKIP = 信号源不可用（如账本缺失/损坏）——既不是
    // 「触发」也不是「安全」，旧实现把这种状态静默当成 OK（fail-open），必须显式出来。
    const status = result.skipped ? 'SKIP' : (result.triggered ? 'TRIGGERED' : 'OK');
    console.log(`  [${status}] ${cond.id}: ${cond.name}`);
    if (result.detail) console.log(`    Detail: ${result.detail}`);

    if (result.triggered) {
      anyTriggered = true;
      triggeredConditions.push({ id: cond.id, name: cond.name, detail: result.detail });
    }
  }

  console.log(``);

  if (!anyTriggered) {
    console.log(`No circuit breaker conditions triggered. Autonomy level ${currentLevel} maintained.`);
    return;
  }

  console.log(`=== Phase 1: Diagnose Root Cause ===`);
  const diagnoses = [];
  for (const tc of triggeredConditions) {
    const cond = CIRCUIT_BREAKER_CONDITIONS.find(c => c.id === tc.id);
    if (!cond) continue;
    const diagnosis = diagnoseCondition(projectDir, cond);
    diagnoses.push(diagnosis);
    console.log(`  ${diagnosis.id}: ${diagnosis.rootCause}`);
    console.log(`    Fixable: ${diagnosis.fixable ? 'YES' : 'NO'}`);
    if (diagnosis.fixAction) console.log(`    Fix Action: ${diagnosis.fixAction}`);
  }
  console.log(``);

  console.log(`=== Phase 2: Attempt Auto-Fix ===`);
  let allFixed = true;
  for (const diagnosis of diagnoses) {
    const fixResult = attemptAutoFix(projectDir, diagnosis);
    fixResults.push({ id: diagnosis.id, ...fixResult });
    if (!fixResult.success) allFixed = false;
  }
  console.log(``);

  if (allFixed) {
    console.log(`=== All triggered conditions auto-fixed. Re-checking... ===`);
    let stillTriggered = false;
    for (const cond of CIRCUIT_BREAKER_CONDITIONS) {
      const result = cond.check(projectDir);
      if (result.triggered) {
        console.log(`  [STILL TRIGGERED] ${cond.id}: ${cond.name}`);
        stillTriggered = true;
      }
    }
    if (!stillTriggered) {
      console.log(`All conditions resolved. Autonomy level ${currentLevel} maintained.`);
      return;
    }
    console.log(`Some conditions still triggered after fix attempt.`);
  }

  console.log(`=== Phase 3: Fallback (fix attempts exhausted) ===`);
  // 修 S-7：L4→L3 与 L3→L2 合并为一条 Post-Verify 路径（原两段同构代码各自
  // 正则改写 + 无条件日志 + 无条件"已降级"事故记录）。
  if (currentLevel === 'L4' || currentLevel === 'L3') {
    const targetLevel = currentLevel === 'L4' ? 'L3' : 'L2';
    const downgrade = applyAutonomyDowngrade(projectDir, currentLevel, targetLevel);

    const incidentsDir = join(projectDir, '.cycles', 'incidents');
    if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const incidentPath = join(incidentsDir, `incident-auto-fallback-${timestamp}.md`);
    const triggeredStr = triggeredConditions.map(c => `- ${c.id}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('\n');
    const diagnosisStr = diagnoses.map(d => `- ${d.id}: 根因=${d.rootCause}; 修复=${d.fixable ? '已尝试' : '不可自动修复'}`).join('\n');
    // 事故记录只陈述回读到的真实级别（修 S-7：不再声称未发生的降级）
    const eventLine = downgrade.ok
      ? `熔断自动回退 ${currentLevel} → ${downgrade.observedLevel}`
      : `熔断触发，但自动回退未生效（config 未按预期改写）`;
    const downgradeLine = downgrade.ok
      ? `自主级别回退：${currentLevel} → ${downgrade.observedLevel}（已回读验证）`
      : `自主级别回退失败：期望 ${targetLevel}，实际仍为 ${downgrade.observedLevel}（${downgrade.reason}）`;
    const incidentContent = `# 事故记录：熔断自动回退（先修复后降级）\n\n## 基本信息\n| 字段 | 值 |\n|---|---|\n| 时间 | ${timestamp} |\n| 事件 | ${eventLine} |\n| 触发条件 | ${triggeredConditions.length} 个 |\n\n## 触发条件\n${triggeredStr}\n\n## 根因诊断\n${diagnosisStr}\n\n## 修复尝试\n${fixResults.map(r => `- ${r.id}: ${r.success ? '修复成功' : `修复失败 (${r.reason})`}`).join('\n')}\n\n## 影响范围\n- ${downgradeLine}\n- 需要人类介入诊断\n\n## 恢复条件\n- 根因已定位且修复已验证\n- 人类确认问题已修复\n- 手动恢复 autonomy_level 为 ${currentLevel}\n`;
    atomicWriteFileSync(incidentPath, incidentContent);
    console.log(`Incident recorded: ${incidentPath}`);

    if (downgrade.ok) {
      console.log(`Autonomy downgraded: ${currentLevel} → ${downgrade.observedLevel} (verified by re-read)`);
      console.error(`\nCircuit breaker triggered after fix attempts. Autonomy downgraded ${currentLevel} → ${downgrade.observedLevel}. Human intervention required.`);
      process.exit(2);
    } else {
      // 降级失败比降级成功更严重：自动化带没有收窄，必须最响亮地失败
      console.error(`Autonomy downgrade FAILED: ${downgrade.reason} (observed ${downgrade.observedLevel}, expected ${targetLevel}).`);
      console.error(`\nCircuit breaker triggered and downgrade could not be applied. HUMAN INTERVENTION REQUIRED IMMEDIATELY.`);
      process.exit(2);
    }
  } else {
    console.error(`\nCircuit breaker conditions detected but already at ${currentLevel}. No further auto-fallback.`);
    process.exit(1);
  }
}

const args = parseCliArgs(process.argv, {
  script: 'org-status',
  usage: 'Usage: node org-status.mjs <project-dir> status|agent|review|auto-fallback [--role <role>] [--assign <model>]',
  flags: { role: { type: 'string' }, assign: { type: 'string' } },
  positionals: { min: 2, max: 2, name: '<project-dir> <command>' },
});

const projectDir = resolve(args._[0]);
const command = args._[1];

switch (command) {
  case 'status':
    cmdStatus(projectDir);
    break;
  case 'agent':
    cmdAgent(projectDir, args.role, args.assign);
    break;
  case 'review':
    cmdReview(projectDir);
    break;
  case 'auto-fallback':
    cmdAutoFallback(projectDir);
    break;
  default:
    console.error(`Unknown command: ${command}. Use status, agent, review, or auto-fallback.`);
    process.exit(1);
}