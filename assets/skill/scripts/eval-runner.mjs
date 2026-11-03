#!/usr/bin/env node
// eval-runner.mjs — E1-E8 + Q1-Q8 评估维度运行器：执行评估并生成评估报告
// 用法: node scripts/eval-runner.mjs <project-dir> [--dimensions E1,E2,...,Q1,Q2,...] [--cycle N] [--quality]
// v1.8.7-fork（cycle-14）：
//   D-1403/D-1404（v1.8.6）：①Q4 秘密扫描/Q6 a11y+响应式/Q7 错误处理
//   从 shell grep|wc 改为纯 Node scanSourceLines——DSH 宿主主平台 Windows 无
//   grep/wc，四子检查原先恒 SKIP（质量门永远缺证据）；②Q6 i18n 候选加入 DSH
//   插件规范位置 locale/（与 src/locale/）；③a11y/responsive 扫描扩展名加入
//   .ts（DSH 客户端约定 createElement 无 JSX、CSS-in-TS）。
//   D-1405：Q4 秘密扫描两段式精筛（关键词紧邻 =/: 且右侧为非空字符串字面量）
//   ——宽匹配在本仓 138/138 全假阳性（design-token 助手 token('x') 误报），
//   精筛归零 FP 且真秘钥（api_key = "sk-…"）仍命中。
//   D-1406：Q4 依赖审计通道复活——原 'npm audit … || true' 在 cmd.exe 恒抛错
//   进 catch（Windows 从未活过）；加入 pnpm audit（DSH 生态标配）与
//   --registry=npmjs 回退（npmmirror 无 bulk 审计端点）；退出码不作判据，
//   以能否解析出 metadata 为准。首跑即曝出本仓 2 critical（tinypool RCE）。

import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { parseCliArgs } from './lib/args.mjs';
import { DIMENSIONS, resolveDimensions } from './lib/dimensions.mjs';
import { loadProjectConfig, getYamlString } from './lib/config.mjs';
import { getLatestCycleDir } from './lib/cycle.mjs';
import { atomicWriteFileSync } from './lib/fs-safe.mjs';
import { collectImportGraph, findCircularDeps } from './lib/importGraph.mjs';
import { timeoutFor, isTimeoutError, resolveTimeout, timeoutFromConfig } from './lib/budget.mjs';
// cycle-97 P0（增量缓存基线）：Merkle 树哈希让「源码没变 ⇒ 昂贵命令结果可复用」
// 成为可证明的事实（SHA-256 全量指纹），而不是猜测。缓存只做**诚实复用**：
// 命中时结果标注 cached:true（报告与门禁看得到证据来源）；任何校验失败
// （版本变/项目变/哈希变/超龄/解析坏）都自动回退全量执行——宁可慢不可假绿。
import {
  calculateDirMerkleRoot,
  isCacheValid,
  loadCache,
  saveCache,
  detectDetailedChanges,
} from './lib/merkle-hash.mjs';
// cycle-97 P3-2（影响域抽样）：smoke 档（≤5% 变更）时把 test 命令收窄到
// 「反向可达变更文件」的测试子集（数学模型：reverse reachability closure）。
// partial/full 档不收窄——抽样纪律：档位越高越接近全量，宁可慢不可假绿。
import { computeTestImpact, buildSmokeTestCommand, collectTestFiles } from './lib/testImpact.mjs';
// cycle-97 P1（并行收割器）：原子写 + 安全删除 + detached spawn。
// 子进程结果文件是门禁证据的中间形态，用原子写防半截 JSON 被父进程读到。
import { writeFileSyncParallel, rmFileSyncSafe as rmSyncSafe, mkdirSyncSafe } from './lib/fs-parallel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');

// DIMENSIONS 词表来自 scripts/lib/dimensions.mjs（唯一来源，修 S-2；
// references/evaluation.md 与 config.example.yml 已对齐到本词表）

// 修字典序缺陷：getLatestCycle 改用 lib/cycle.mjs 的数值序（原 .sort().pop() 在
// cycle-10 之后会选错目录：'cycle-9' > 'cycle-10'）
const getLatestCycle = getLatestCycleDir;

// 修 iteration-5（N-10 脚本侧最小实现）：三态裁决 PASS / FAIL / SKIP。
// 原先"无法评估"一律返回 { pass: true, detail: '...(skipped)' }，等于评估器对没评估过的
// 东西写 PASS——门禁随后在无证据的情况下关闭（fail-open，与 S-1 的 lint/build 恒 PASS 同族）。
// SKIP 的语义是"本次没有证据"：报告写 SKIP、退出码仍为 0（否则文档型项目永远无法运行），
// 但 gate-check --quality 视 SKIP 为不可关门——门禁必须有证据。
function skipped(detail) {
  return { pass: false, skipped: true, detail: `${detail} → SKIP (not evaluated)` };
}

// D-1404（cycle-14）：源码行扫描的纯 Node 实现，替代原先 shell 出的
// `grep -rn "..." --include=*.ts src/ | wc -l`。原实现在 DSH 宿主主平台
// Windows（cmd.exe 无 grep/wc）上必然走 catch → SKIP——Q4 秘密扫描、Q6
// a11y+响应式、Q7 错误处理四项子检查在主平台上永远「不可用」，质量门
// 永远缺证据（静默降级，正是 iteration-5 要消灭的 fail-open 亲戚）。
// 语义与 grep -rn 逐行对齐：扩展名过滤、行级正则（大小写敏感，同无 -i
// 的 grep）、返回 {file,line,text}[]（file 为相对项目根的路径）。
// D-1403：扩展名集合由调用方给——a11y/responsive 在 DSH 生态里必须含
// .ts（客户端约定 createElement 无 JSX、CSS-in-TS，无 .tsx/.css 文件）。
function scanSourceLines(projectDir, { extensions, regex, maxMatches = 10000 } = {}) {
  const srcDir = join(projectDir, 'src');
  const matches = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (matches.length >= maxMatches) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      const lines = readFileSync(full, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ file: relative(projectDir, full), line: i + 1, text: lines[i] });
          if (matches.length >= maxMatches) break;
        }
      }
    }
  };
  walk(srcDir);
  return matches;
}

// 组合多个子检查：任一 FAIL ⇒ FAIL；无 FAIL 但有 SKIP ⇒ SKIP；否则 PASS。
// （Q4/Q5/Q6/Q7/Q8 是多个子检查的合取，SKIP 必须在合取里传播而不是被吞掉）
function combine(results) {
  const detail = results.map(r => r.detail || r.output || '').filter(Boolean).join('; ');
  if (results.some(r => !r.pass && !r.skipped)) return { pass: false, detail };
  if (results.some(r => r.skipped)) return { pass: false, skipped: true, detail };
  return { pass: true, detail };
}

// 修 S-1：loadConfig 改走 scripts/lib/config.mjs 唯一入口（原先读从未被 init-workflow
// 创建的 .cycles/cycle-config.yml，缺文件静默返回 ''）。缺配置 = 响亮失败，不再静默降级。
function loadConfig(projectDir) {
  try {
    return loadProjectConfig(projectDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function runTestCommand(projectDir, configContent, smokeCmdOverride) {
  // 引号容错解析（修 S-8：各脚本自带 /test_cmd:\s*"([^"]+)"/ 且要求双引号）
  // P3-2：smoke 档传入 smokeCmdOverride（影响域收窄后的命令）——覆盖原始
  // test_cmd；三态语义不变，仅测试集变小（mode/count 已在控制台披露）。
  const testCmd = smokeCmdOverride ?? getYamlString(configContent, 'test_cmd');
  if (!testCmd) return { pass: false, output: 'test_cmd not configured in .cycles/config.yml' };
  try {
    // cycle-40（场地实验 #1 根修）：maxBuffer 提到 16MB——大工作区（5390 用例）
    // 的 stderr 超 execSync 默认 1MB 会 throw ENOBUFS，旧 catch 把它当测试失败
    // （E3/E8 误报 FAIL，detail 首行恰是 vitest DEPRECATED 弃用告警——真根因是
    // 缓冲区溢出而非测试红）。ENOBUFS ≠ 测试失败：如实按「无法评估」处理。
    // 超时同理与失败区分：e.signal === 'SIGTERM' 且 e.killed = true 是超时形态
    //（execSync 超时 kill 进程），真实测试失败 e.status 是数字退出码。
    const output = execSync(testCmd, { cwd: projectDir, timeout: resolveTimeout('test', { configMs: timeoutFromConfig(configContent, 'test') }), stdio: 'pipe', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return { pass: true, output: output.toString().trim() };
  } catch (e) {
    if (e.code === 'ENOBUFS') {
      // 缓冲区溢出 = 判定器看不见完整输出 = 没有证据：SKIP 而非 FAIL（三态纪律）
      return { pass: false, skipped: true, output: 'test output exceeded 16MB buffer (ENOBUFS) — cannot judge, reduce test verbosity or run tests separately' };
    }
    if (isTimeoutError(e)) {
      // 超时 = 未跑完 = 无结论证据：SKIP 而非 FAIL（把半截 stderr 当失败详情是
      // cycle-39 归因错误的另一半根因——超时被折叠成 FAIL 且 detail 恰是弃用告警）
      return { pass: false, skipped: true, output: `test command exceeded its ${timeoutFor('test')}ms budget — cannot judge (workspace tests take longer than the budget; run test_cmd separately and attach the report, or raise test_timeout_ms)` };
    }
    // cycle-98（证据完整性根修）：失败分支原来**只保留 stderr 前 2000 字**——
    // vitest 的失败清单（FAIL ... 行）与汇总表都在 **stdout**，stderr 只有
    // 测试自身的 console 噪音（如 cliArgsGuard 故意跑 --zzz 的预期报错）。
    // 结果：E3/E8 FAIL 时 detail 首行是"[gate-check] 未知旗标: --zzz"，
    // 真失败原因完全不可见（本轮实测踩中）。改为 stdout 尾部（汇总表在尾部）
    // + stderr 头部（早期报错），两段都留证据。
    const stdoutTail = e.stdout ? e.stdout.toString().trim().slice(-14000) : '';
    // cycle-98 二次修正：vitest 的**失败详情段走 stderr**（且在输出尾部）——
    // stderr 头部只有测试自身的 console 噪音（--zzz 预期报错等）。留尾部。
    const stderrHead = e.stderr ? e.stderr.toString().trim().slice(-14000) : '';
    return { pass: false, output: `${stdoutTail}${stderrHead ? `\n--- stderr ---\n${stderrHead}` : ''}` || e.message };
  }
}

function runLintCommand(projectDir, configContent) {
  const lintCmd = getYamlString(configContent, 'lint_cmd');
  if (!lintCmd) {
    // 修 S-1 附带缺陷：原先缺配置返回 {pass:true, 'No lint command configured (skipped)'}——
    // 评估器无法评估不得记 PASS（禁默认值兜底，docs/anic/09 §6.4）
    return { pass: false, output: 'lint_cmd not configured in .cycles/config.yml' };
  }
  try {
    const output = execSync(lintCmd, { cwd: projectDir, timeout: resolveTimeout('lint', { configMs: timeoutFromConfig(configContent, 'lint') }), stdio: 'pipe', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { pass: true, output: output.toString().trim() };
  } catch (e) {
    if (e.code === 'ENOBUFS') {
      return { pass: false, skipped: true, output: 'lint output exceeded 8MB buffer (ENOBUFS) — cannot judge' };
    }
    // cycle-98：同 test——失败证据以 stdout 尾部为主（lint 的违规清单在 stdout）。
    const lintStdoutTail = e.stdout ? e.stdout.toString().trim().slice(-2400) : '';
    const lintStderrHead = e.stderr ? e.stderr.toString().trim().slice(0, 800) : '';
    return { pass: false, output: `${lintStdoutTail}${lintStderrHead ? `\n--- stderr ---\n${lintStderrHead}` : ''}` || e.message };
  }
}

function runBuildCommand(projectDir, configContent) {
  const buildCmd = getYamlString(configContent, 'build_cmd');
  if (!buildCmd) {
    return { pass: false, output: 'build_cmd not configured in .cycles/config.yml' };
  }
  try {
    execSync(buildCmd, { cwd: projectDir, timeout: resolveTimeout('build', { configMs: timeoutFromConfig(configContent, 'build') }), stdio: 'pipe', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { pass: true, output: 'Build passed' };
  } catch (e) {
    if (e.code === 'ENOBUFS') {
      return { pass: false, skipped: true, output: 'build output exceeded 8MB buffer (ENOBUFS) — cannot judge' };
    }
    return { pass: false, output: 'Build failed' };
  }
}

function checkSpecAlignment(projectDir) {
  const intentDir = join(projectDir, '.cycles', 'intent');
  if (!existsSync(intentDir)) return skipped('No intent directory');
  const mdFiles = readdirSync(intentDir).filter(f => f.endsWith('.md'));
  if (mdFiles.length === 0) return skipped('No intent documents');
  return { pass: true, detail: `${mdFiles.length} intent document(s) found: ${mdFiles.join(', ')}` };
}

function checkSpecConformance(projectDir) {
  const intentDir = join(projectDir, '.cycles', 'intent');
  if (!existsSync(intentDir)) return skipped('No intent directory');
  const specPath = join(intentDir, 'spec.md');
  if (!existsSync(specPath)) return skipped('No spec.md');
  const planPath = join(intentDir, 'plan.md');
  if (!existsSync(planPath)) return skipped('spec.md found but no plan.md (conformance not evaluable)');
  return { pass: true, detail: 'spec.md and plan.md found, conformance check passed' };
}

function checkDocSync(projectDir) {
  const readmePath = join(projectDir, 'README.md');
  if (!existsSync(readmePath)) return skipped('No README');
  return { pass: true, detail: 'README exists' };
}

function checkSecurity(projectDir) {
  const envFiles = ['.env', '.env.local', '.env.production'];
  const found = envFiles.filter(f => existsSync(join(projectDir, f)));
  if (found.length === 0) return { pass: true, detail: 'No .env files present' };

  // 修 iteration-5：.env 存在但项目没有 .gitignore 时，原实现的整个 if 块不成立，
  // 直接落到最后一行 'No security issues detected'——明文凭据可提交却被报为无安全问题。
  // 缺证据不能等于通过：没有 .gitignore 本身就是最坏情况（没有任何忽略规则）。
  const gitignorePath = join(projectDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return { pass: false, detail: `Env files present with no .gitignore at all: ${found.join(', ')} (credentials are trackable)` };
  }
  const gitignore = readFileSync(gitignorePath, 'utf-8');
  const notIgnored = found.filter(f => !gitignore.includes(f));
  if (notIgnored.length > 0) {
    return { pass: false, detail: `Env files not in .gitignore: ${notIgnored.join(', ')}` };
  }
  return { pass: true, detail: `Env files ignored: ${found.join(', ')}` };
}

function checkHardcodedSecrets(projectDir) {
  if (!existsSync(join(projectDir, 'src'))) return skipped('No src/ directory');
  // D-1404：纯 Node 扫描（原 grep -rn 在 Windows 上不可用 → 恒 SKIP）。
  // D-1405：两段式精筛。原宽匹配（行含 password|secret|token 即计）
  //   在真实生产仓上 138/138 全假阳性——design-token 助手 token('anic-border')
  //   与 sanitizeEnv 自身的凭据清洗代码全部误报，检测通道不可用。
  // 精筛语义：秘钥样关键词【紧邻】= 或 : 且右侧是非空字符串字面量——
  //   即「疑似凭据名的硬编码赋值」。函数调用 token('x')、函数定义
  //   const token = (n) => …、常量 TOKEN_SCOPE = '…'（关键词后随 _SCOPE）
  //   均不触发；api_key = "sk-…"、{ token: 'abc' }、accessToken = "x" 命中。
  const preFilter = /password|secret|api_key|token/i;
  const precise = /(password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/i;
  let hits;
  try {
    hits = scanSourceLines(projectDir, {
      extensions: ['.ts', '.js', '.tsx', '.jsx'],
      regex: preFilter,
    });
  } catch {
    return skipped('Secret scan unavailable (source scan failed)');
  }
  const suspicious = hits.filter(
    (h) =>
      !h.text.includes('//') &&
      // cycle-97：字符串字面量「斜杠星号」会被 scriptBudgetContract 的块注释剥离
      // 正则误当成真块注释的开始（后续新增 JSDoc 提供闭合符后吞掉 16k 字符、
      // 连吃两个预算调用点）。改用字符编码构造，语义不变（检测行内出现块注释
      // 开始符），该两字符序列不再出现在本文件任何字节流位置。
      !h.text.includes('/' + '*') &&
      !h.text.includes('process.env') &&
      precise.test(h.text),
  );
  if (suspicious.length > 0) {
    return { pass: false, detail: `${suspicious.length} potential hardcoded secrets found` };
  }
  return { pass: true, detail: 'No hardcoded secrets detected' };
}

function runAuditJson(cmd, projectDir) {
  // npm/pnpm audit 在发现漏洞时以非零码退出，但 JSON 仍写 stdout——
  // 退出码不可作为失败判据，只能以「能否解析出 metadata」为准。
  try {
    return execSync(cmd, {
      cwd: projectDir, timeout: timeoutFor('audit'), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8',
      windowsHide: true, // cycle-99b：audit 子进程不弹窗
    });
  } catch (e) {
    const out = typeof e.stdout === 'string' ? e.stdout : '';
    return out || null; // 非零退出但带 JSON → 继续解析；无输出 → null
  }
}

function checkDependencyAudit(projectDir) {
  // D-1406：原实现两处 Windows/pnpm 生态致命伤——
  //   ① 'npm audit --json 2>/dev/null || true'：cmd.exe 无 true 命令，npm 非零退出时
  //     execSync 抛错进 catch → 恒 SKIP（主平台上通道从未活过）；
  //   ② 只认 package-lock.json 的 metadata：pnpm 仓（DSH 生态标配）永远 SKIP。
  // 探测顺序：有 pnpm-lock.yaml → pnpm audit（默认 registry，失败时回退 npmjs
  // 源——npmmirror 等镜像无 bulk 审计端点）；有 package-lock.json → npm audit。
  const hasNpmLock = existsSync(join(projectDir, 'package-lock.json'));
  const hasPnpmLock = existsSync(join(projectDir, 'pnpm-lock.yaml'));
  const audits = [];
  if (hasPnpmLock) {
    audits.push('pnpm audit --json');
    audits.push('pnpm audit --json --registry=https://registry.npmjs.org');
  }
  if (hasNpmLock) audits.push('npm audit --json');
  if (audits.length === 0) return skipped('No package-lock.json / pnpm-lock.yaml to audit');
  for (const cmd of audits) {
    const output = runAuditJson(cmd, projectDir);
    if (!output) continue;
    let vulns;
    try {
      vulns = JSON.parse(output).metadata?.vulnerabilities;
    } catch {
      continue;
    }
    if (!vulns) continue;
    const highVulns = vulns.high || 0;
    const criticalVulns = vulns.critical || 0;
    if (criticalVulns > 0) {
      return { pass: false, detail: `${criticalVulns} critical vulnerabilities` };
    }
    if (highVulns > 0) {
      return { pass: false, detail: `${highVulns} high vulnerabilities` };
    }
    return { pass: true, detail: 'No high/critical vulnerabilities' };
  }
  return skipped('npm/pnpm audit unavailable (no vulnerability metadata from any registry)');
}

function checkArchitectureLayers(projectDir) {
  const srcDir = join(projectDir, 'src');
  if (!existsSync(srcDir)) return skipped('No src/ directory');

  const knownLayers = ['client', 'host', 'shared', 'adapters', 'server', 'lib'];
  const foundLayers = readdirSync(srcDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const hasAdapter = foundLayers.some(l => l.includes('adapter') || l === 'adapters');
  if (!hasAdapter && foundLayers.length > 2) {
    return { pass: false, detail: 'No adapter layer found for external service isolation' };
  }
  return { pass: true, detail: `${foundLayers.length} layers detected, adapter pattern present` };
}

function checkCircularDeps(projectDir) {
  // D-1408（cycle-14）：原 `npx madge --circular … || true` 两处主平台致命伤——
  // ① Windows（DSH 宿主主平台）npx madge 触发交互式下载提示 → 恒失败 SKIP；
  // ② '|| true' 在 cmd.exe 无 true 命令：madge 非零退出（真正发现环时）execSync
  //   抛错进 catch → 环被静默吞成 SKIP（fail-open，最需报警时失明）。
  // 改纯 Node 相对 import 图 + DFS 环检测（scripts/lib/importGraph.mjs，零外部依赖）。
  let graph;
  try {
    graph = collectImportGraph(projectDir);
  } catch {
    return skipped('Import graph collection failed');
  }
  if (graph.files.length === 0) return skipped('No source files to analyze');
  const cycles = findCircularDeps(graph);
  if (cycles.length > 0) {
    const sample = cycles
      .slice(0, 3)
      .map((members) => members.map((f) => relative(projectDir, f)).join(' ↔ '))
      .join('；');
    return { pass: false, detail: `${cycles.length} circular dependencies detected: ${sample}` };
  }
  return { pass: true, detail: `No circular dependencies (${graph.files.length} source files)` };
}

function checkA11y(projectDir) {
  const srcDir = join(projectDir, 'src');
  if (!existsSync(srcDir)) return skipped('No src/ directory');

  // D-1404：纯 Node 扫描（原 grep|wc 在 Windows 上不可用 → 恒 SKIP）。
  // D-1403：扩展名加入 .ts/.js——DSH 生态客户端约定 createElement（无 JSX），
  // aria 属性写在 .ts 文件里；只扫 .tsx/.jsx 会漏报整个 DSH 插件生态。
  let hits;
  try {
    hits = scanSourceLines(projectDir, {
      extensions: ['.tsx', '.jsx', '.ts', '.js'],
      regex: /aria-|role=/,
    });
  } catch {
    return skipped('a11y check unavailable (source scan failed)');
  }
  if (hits.length === 0) {
    return { pass: false, detail: 'No ARIA attributes found in frontend code' };
  }
  return { pass: true, detail: `${hits.length} ARIA attributes found` };
}

function checkI18n(projectDir) {
  // D-1403：加入 DSH 插件规范位置——根 locale/（package.json 导出
  // ./locale 下全部 json，dsh-client-ui 的 i18n 约定）与 src/locale/。
  // cycle-97：注释里不写「斜杠星号」序列（glob 形态）——scriptBudgetContract
  // 的块注释剥离正则会把「行注释尾字符 + 星号」误配成块注释开始，吞掉
  // 后续上万字节（含两个预算调用点）。glob 语义由下方 readdirSync 表达。
  // 原候选只有 src/i18n、src/client/i18n、public/locales 三个通用 Web
  // 位置，对 DSH 插件项目全部失配 → Q6 恒 SKIP。
  const i18nPaths = [
    join(projectDir, 'src', 'i18n'),
    join(projectDir, 'src', 'client', 'i18n'),
    join(projectDir, 'public', 'locales'),
    join(projectDir, 'locale'),
    join(projectDir, 'src', 'locale'),
  ];
  const found = i18nPaths.filter(p => existsSync(p));
  if (found.length === 0) return skipped('No i18n directory');
  return { pass: true, detail: `i18n directory found: ${found[0].replace(projectDir, '')}` };
}

function checkResponsive(projectDir) {
  // D-1404：纯 Node 扫描；D-1403：扩展名加入 .ts——DSH 生态 CSS-in-TS
  // （如 panelCss.ts 里的 @media/@container），无独立 .css 文件。
  let hits;
  try {
    hits = scanSourceLines(projectDir, {
      extensions: ['.tsx', '.jsx', '.css', '.scss', '.ts'],
      regex: /@media|useMediaQuery|breakpoint/,
    });
  } catch {
    return skipped('Responsive check unavailable (source scan failed)');
  }
  if (hits.length === 0) {
    return { pass: false, detail: 'No responsive design breakpoints found' };
  }
  return { pass: true, detail: `${hits.length} responsive breakpoints found` };
}

function checkComplexity(projectDir) {
  // D-1415（cycle-15，D-1404 漏网同型）：原 `… 2>&1 || true` 在 cmd.exe 无 true
  // 命令——band-detector 非零退出时 execSync 抛错进 catch → SKIP（fail-open）。改
  // execFileSync 直跑（无 shell 语义），非零退出时从 e.stdout 取完整输出按文本裁决。
  // cycle-78（v2.6.0 语义分层）起：告警本身**不再**导致非零退出（默认报告模式恒 0，
  // 只有目录/配置/历史快照这类执行失败才非零），所以这里的 catch 分支已从「告警主
  // 路径」退化为执行失败的兜底；判定仍只看报告文本（OVER_BUDGET / WE 计数），
  // 因为「复杂度是否超标」是报告内容，不是脚本执行成败。
  let output = '';
  try {
    output = execFileSync('node', [join(SKILL_ROOT, 'scripts', 'band-detector.mjs'), projectDir, '--threshold', '0.15'], {
      timeout: timeoutFor('script'), stdio: 'pipe', encoding: 'utf-8',
    });
  } catch (e) {
    output = String(e.stdout ?? '');
    if (!output) return skipped('Complexity check unavailable (band-detector failed)');
  }
  if (output.includes('OVER_BUDGET')) {
    return { pass: false, detail: 'Complexity over budget' };
  }
  const weMatch = output.match(/(\d+) Western Electric rule violation/);
  if (weMatch) {
    // 统计控制信号：过程漂移提示（如复杂度改善也会触发）——可见但不过度 FAIL
    return { pass: true, detail: `Complexity within bands (${weMatch[1]} WE rule signal(s), statistical control advisory)` };
  }
  if (output.includes('WARNING')) {
    return { pass: true, detail: 'Complexity within bands (warning)' };
  }
  return { pass: true, detail: 'Complexity within acceptable bands' };
}

function checkErrorHandling(projectDir) {
  if (!existsSync(join(projectDir, 'src'))) return skipped('No src/ directory');
  // D-1404：纯 Node 扫描（原 grep|wc 在 Windows 上不可用 → 恒 SKIP）。
  let hits;
  try {
    hits = scanSourceLines(projectDir, {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      regex: /try|catch|ErrorBoundary|error/,
    });
  } catch {
    return skipped('Error handling check unavailable (source scan failed)');
  }
  if (hits.length === 0) {
    return { pass: false, detail: 'No error handling patterns found' };
  }
  return { pass: true, detail: `${hits.length} error handling patterns found` };
}

/**
 * cycle 目录的绝对路径（活跃区优先；活跃区没有则回退归档区）。
 * cycle-101：getLatestCycleDir 已支持归档回退，但它只返回**名字**——
 * 两个区的同名目录需要按存在性解析真实位置，否则归档后会拼出不存在的路径。
 */
function cycleDirPath(projectDir, cycleDir) {
  const active = join(projectDir, '.cycles', 'cycles', cycleDir);
  if (existsSync(active)) return active;
  const archived = join(projectDir, '.cycles', 'archive', cycleDir);
  if (existsSync(archived)) return archived;
  return active; // 两处都不存在时返回活跃区路径（由调用方的 existsSync 判缺失）
}

function checkDeliveryChecklist(projectDir, cycleDir) {
  if (!cycleDir) return { pass: false, detail: 'No cycle directory' };
  const checklistPath = join(cycleDirPath(projectDir, cycleDir), '交付清单.md');
  if (!existsSync(checklistPath)) return { pass: false, detail: 'No delivery checklist' };
  const content = readFileSync(checklistPath, 'utf-8');
  const requiredItems = ['Release 构建产物', '最终测试报告', '非功能验证报告', '验证签名', '文档更新记录', '环境配置说明', '数据清理记录', '审计日志'];
  const missing = requiredItems.filter(item => !content.includes(item));
  if (missing.length > 0) {
    return { pass: false, detail: `Missing ${missing.length} items: ${missing.join(', ')}` };
  }
  return { pass: true, detail: 'All 8 delivery checklist items present' };
}

function checkTestReports(projectDir, cycleDir) {
  if (!cycleDir) return { pass: false, detail: 'No cycle directory' };
  const testReportsDir = join(cycleDirPath(projectDir, cycleDir), 'test-reports');
  if (!existsSync(testReportsDir)) return { pass: false, detail: 'No test reports directory' };
  const reports = readdirSync(testReportsDir).filter(e => e.endsWith('.md'));
  if (reports.length === 0) return { pass: false, detail: 'No test reports' };
  return { pass: true, detail: `${reports.length} test report(s) found` };
}

function checkReviewEvidence(projectDir, cycleDir) {
  if (!cycleDir) return { pass: false, detail: 'No cycle directory' };
  const cycleReviewPath = join(projectDir, '.cycles', 'cycles', cycleDir, '评审标准.md');
  const globalReviewPath = join(projectDir, '.cycles', 'REVIEW.md');
  if (existsSync(cycleReviewPath)) return { pass: true, detail: 'Cycle-specific review criteria found' };
  if (existsSync(globalReviewPath)) return { pass: true, detail: 'Global REVIEW.md found' };
  return skipped('No review criteria');
}

// cycle-62（技能 v2.5.2）：E5 性能基线工件通道。
// 原实现 iteration-5 硬编码 skipped——「性能基线」维永远无证据。判定形状与
// checkDeliveryChecklist 同构（existsSync → 内容关键词），关键词「基线」「阈值」
// 防空文件占位。三态纪律不变：无工件 = SKIP（不是 FAIL——项目没声明基线
// 不是错误，是没证据）。阈值是声明不是判定：越线监督归 control_bands 管道，
// 本检查只认证据形状。
function checkPerformanceBaseline(projectDir) {
  const baselinePath = join(projectDir, '.cycles', 'performance-baseline.md');
  if (!existsSync(baselinePath)) {
    return skipped('Performance baseline artifact .cycles/performance-baseline.md not found (create it with 基线 table + 阈值 to enable E5)');
  }
  const content = readFileSync(baselinePath, 'utf-8');
  const hasBaseline = content.includes('基线');
  const hasThreshold = content.includes('阈值');
  if (!hasBaseline || !hasThreshold) {
    return skipped('Performance baseline artifact exists but lacks 基线/阈值 shape (empty or placeholder file)');
  }
  const rows = content.split('\n').filter((l) => l.trim().startsWith('|')).length;
  return { pass: true, detail: `Performance baseline artifact found (${rows} table rows, 基线+阈值 shape OK)` };
}


// 报告里的一格裁决：三态（PASS / FAIL / SKIP）。SKIP 必须显式落盘，
// 否则读者（与 gate-check --quality）无法区分"评估通过"与"没评估"。
function statusOf(r) {
  if (r.skipped) return 'SKIP';
  return r.pass ? 'PASS' : 'FAIL';
}

function generateReport(projectDir, cycleDir, results, dimsToRun) {
  const evalDims = dimsToRun.filter(d => DIMENSIONS[d].category === 'eval');
  const qualityDims = dimsToRun.filter(d => DIMENSIONS[d].category === 'quality');

  const lines = [
    `# 评估报告`,
    ``,
    `**循环**: ${cycleDir || 'N/A'}`,
    `**时间**: ${new Date().toISOString()}`,
    `**评估维度**: ${evalDims.join(', ')}`,
    `**质量评审维度**: ${qualityDims.join(', ')}`,
    // cycle-97 P0/P1/P2 可观测性元数据：证据来源（缓存/并行/串行）与抽样档位
    // 是报告的「采集方式声明」——读者（与 auto-fix-loop）据此判断结果可信度。
    `**证据来源**: ${cmdNeeded.length === 0 ? 'static-analysis-only (no expensive commands)' : cacheUsable ? 'cache-hit (Merkle-verified)' : parallelStarted.length > 0 ? `parallel x${parallelStarted.length} + serial fallback` : 'serial'}`,
    `**抽样档位**: ${samplingHint}`,
    ``,
  ];

  if (evalDims.length > 0) {
    lines.push(`## E1-E8 评估结果`, ``, `| 维度 | 名称 | 结果 | 详情 |`, `|------|------|------|------|`);
    for (const dim of evalDims) {
      const r = results[dim];
      const status = statusOf(r);
      lines.push(`| ${dim} | ${DIMENSIONS[dim].name} | ${status} | ${r.detail || r.output || ''} |`);
    }
    lines.push(``);
  }

  if (qualityDims.length > 0) {
    lines.push(`## Q1-Q8 质量评审结果`, ``, `| 维度 | 名称 | 结果 | 详情 |`, `|------|------|------|------|`);
    for (const dim of qualityDims) {
      const r = results[dim];
      const status = statusOf(r);
      lines.push(`| ${dim} | ${DIMENSIONS[dim].name} | ${status} | ${r.detail || r.output || ''} |`);
    }
    lines.push(``);
  }

  const passed = dimsToRun.filter(d => results[d].pass).length;
  const skippedDims = dimsToRun.filter(d => results[d].skipped);
  const failed = dimsToRun.length - passed - skippedDims.length;
  lines.push(
    `## 总结`, ``,
    `- 通过: ${passed}/${dimsToRun.length}`,
    `- 失败: ${failed}`,
    `- 未评估(SKIP): ${skippedDims.length}${skippedDims.length > 0 ? ` → ${skippedDims.join(', ')}` : ''}`,
    ``,
  );

  if (failed > 0) {
    lines.push(`> **警告**: ${failed} 个维度未通过，需要修复后再进入下一阶段。`);
  }
  if (skippedDims.length > 0) {
    lines.push(`> **注意**: ${skippedDims.length} 个维度未评估——SKIP ≠ PASS，门禁需更多证据才能关闭（gate-check --quality 视 SKIP 为不可关门）。`);
  }

  return lines.join('\n');
}

const args = parseCliArgs(process.argv, {
  script: 'eval-runner',
  usage: 'Usage: node eval-runner.mjs <project-dir> [--dimensions E1,E2,...,Q1,Q2,...] [--cycle N] [--quality]',
  // cycle-97 P1：run-cmd-only/run-cmd-out 是并行子进程的隐藏模式（父进程
  // spawn 时传入）。声明在此以通过 parseCliArgs 的未知旗标守卫；正常 CLI
  // 形状不变（usage 不列它们——面向用户的接口面保持干净）。
  flags: {
    dimensions: { type: 'string', default: 'all' },
    cycle: { type: 'int' },
    quality: { type: 'boolean' },
    'run-cmd-only': { type: 'string' },
    'run-cmd-out': { type: 'string' },
  },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});

const projectDir = resolve(args._[0]);
const configContent = loadConfig(projectDir);

let dimsToRun;
try {
  // 修 S-11：未知维度响亮失败（原先 .filter(s => DIMENSIONS[s]) 静默剔除，
  // `--dimensions E9` 会静默变成空集并以退出码 0 结束）
  dimsToRun = resolveDimensions({ dimensions: args.dimensions, quality: args.quality });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const cycleDir = args.cycle ? `cycle-${args.cycle}` : getLatestCycle(projectDir);

// ── cycle-97 P0：惰性执行 + Merkle 缓存基线 ─────────────────────────
// 原实现无条件跑满 test/lint/build 三条昂贵命令，即使 `--dimensions E1`
// 只要文档对齐（~0s）。三层数据结构：
//   1. 命令 → 依赖它的维度集合（依赖图，决定「哪些命令必须跑」）
//   2. Merkle 根 → 上次成功结果（缓存键，决定「哪些命令可复用」）
//   3. 惰性 memo → 首次访问才执行（决定「实际跑了什么」）
// 组合效果：请求维度不含昂贵命令 → 0 条命令；含但源码未变 → 0 条命令（缓存命中）；
// 都不满足 → 只跑必需的命令（部分拆分），而不是历史上恒跑满三条。
const CMD_DEPS = {
  test: ['E3', 'E8'],
  lint: ['E4', 'Q7'],
  build: ['Q3'],
};
const CACHE_FILE = join(projectDir, '.cycles', '.eval-cache.json');
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(SKILL_ROOT, '..', '..', '..', 'package.json'), 'utf-8')).version ?? 'unknown';
  } catch {
    return 'unknown'; // 版本读不到时退化「未知」→ 缓存版本校验必然不等 → 全量执行（诚实回退）
  }
})();

const dimsSet = new Set(dimsToRun);
const cmdNeeded = Object.entries(CMD_DEPS)
  .filter(([, deps]) => deps.some((d) => dimsSet.has(d)))
  .map(([cmd]) => cmd);

// 缓存有效性三查：文件存在+版本+项目+Merkle 根一致+未超龄（7 天）。
// 源码指纹范围与 scanSourceLines 同步：src/ 下的 .ts/.js/.mjs——
// 这正是 test/lint/build 的输入面。
// cycle-97 P3-3（配置指纹入缓存键，根修「改了 test_cmd 还复用旧结果」）：
// 缓存键 = 源码 Merkle 根 ⊕ 命令配置指纹（三条命令原文）。理由：缓存复用的
// 判据是「输入相同 ⇒ 输出相同」，而命令行本身就是输入的一部分——test_cmd
// 从 `vitest run` 改成 `vitest run --reporter=verbose`，源码一个字节没动，
// 旧缓存也会被错误命中（假绿的配置面变体）。指纹只含实际被消费的三键，
// 不含 project_name 等无关字段（避免无关配置编辑击穿缓存）。
const CFG_FINGERPRINT = ['test', 'lint', 'build']
  .map((kind) => {
    const key = { test: 'test_cmd', lint: 'lint_cmd', build: 'build_cmd' }[kind];
    return `${kind}=${getYamlString(configContent, key) ?? ''}`;
  })
  .join('|');
const CFG_FINGERPRINT_KEY = (() => {
  try {
    return createHash('sha256').update(CFG_FINGERPRINT).digest('hex').slice(0, 16);
  } catch { return CFG_FINGERPRINT.slice(0, 16); }
})();
// cycle-99 缓存键正确性根修：Merkle 根原来只扫 `src/`——tests/ 的期望修正、
// 测试新增/删除都不进键，导致「改了测试但缓存仍 hit」的假绿（本轮实测：
// sessionWorkspaceClaim.test.ts 期望修正后连续两次命中旧结果）。改为 src+tests
// 双根合成（顺序固定 ⇒ 确定性；单根不存在时退化为另一根）。
const merkleRoot = cmdNeeded.length > 0
  ? calculateDirMerkleRoot(join(projectDir, 'src')) + ':' + calculateDirMerkleRoot(join(projectDir, 'tests'))
  : null;
// 复合缓存键：源码指纹在前（主导变更检测读数），配置指纹在后（等值校验）。
// 两侧任一变化 → 键不等 → miss（诚实回退）。
const COMPOSITE_KEY = merkleRoot === null ? null : `${merkleRoot}:${CFG_FINGERPRINT_KEY}`;
const cacheUsable = cmdNeeded.length > 0
  && isCacheValid(CACHE_FILE, projectDir, PKG_VERSION, 7 * 24 * 60 * 60 * 1000, merkleRoot) // ← 与存入同根比对（缺陷三根修）
  && loadCache(CACHE_FILE)?.merkleRoot === merkleRoot
  && loadCache(CACHE_FILE)?.cfgFingerprint === CFG_FINGERPRINT_KEY; // ← P3-3：配置面等值校验

if (cmdNeeded.length === 0) {
  console.log(`[eval-runner] no expensive commands needed for dimensions: ${dimsToRun.join(', ')} — skipping test/lint/build entirely`);
} else if (cacheUsable) {
  console.log(`[eval-runner] source Merkle root unchanged — reusing cached results for: ${cmdNeeded.join(', ')} (evidence: ${CACHE_FILE})`);
} else {
  const changed = (() => {
    const prev = loadCache(CACHE_FILE);
    if (!prev) return 'first run (no cache)';
    if (prev.version !== PKG_VERSION) return `plugin version changed (${prev.version} → ${PKG_VERSION})`;
    if (prev.cfgFingerprint !== CFG_FINGERPRINT_KEY) {
      // P3-3：配置面变更独立归因——源码没动但命令变了，读者需要知道为什么没命中
      return 'command config changed (test_cmd/lint_cmd/build_cmd)';
    }
    if (prev.merkleRoot !== merkleRoot) {
      const d = detectDetailedChanges(projectDir, CACHE_FILE);
      return `source changed: ${d.changedFiles.length}/${d.totalFiles} files (e.g. ${d.changedFiles.slice(0, 3).join(', ') || '—'})`;
    }
    return 'cache metadata mismatch';
  })();
  console.log(`[eval-runner] cache miss (${changed}) — will run: ${cmdNeeded.join(', ')}`);
}

// ── cycle-97 P2：智能抽样读数（动态评估深度的事实来源）────────────────
// 变更比例 → 抽样档位（纯读数，不改变本次评估行为——三态纪律与全量命令
// 语义不变）。档位映射（信息论意义：变更越多，上次结果的可信度越低）：
//   0%        → reuse   （已被缓存命中覆盖）
//   ≤5% 文件  → smoke   （快速冒烟档足够捕捉回归）
//   ≤20% 文件 → partial （部分维度可信）
//   >20% 文件 → full    （全量评估，无捷径）
// 读数写入报告元数据（--sampling hint），供 auto-fix-loop 与宿主在
// 「评估失败后选修复策略」时参考：smoke 档失败建议先扩大样本再定位根因。
const samplingInfo = (() => {
  if (cacheUsable) return { tier: 'reuse', ratio: 0, hint: 'reuse (0% change)' };
  const prev = loadCache(CACHE_FILE);
  if (!prev || !prev.fileHashes || merkleRoot === null) return { tier: 'full', ratio: 1, hint: 'full (no baseline)' };
  const d = detectDetailedChanges(projectDir, CACHE_FILE);
  const ratio = d.totalFiles > 0 ? d.changedFiles.length / d.totalFiles : 1;
  const tier = ratio === 0 ? 'reuse' : ratio <= 0.05 ? 'smoke' : ratio <= 0.2 ? 'partial' : 'full';
  return { tier, ratio, hint: `${tier} (${(ratio * 100).toFixed(1)}% of ${d.totalFiles} source files changed)`, changedFiles: d.changedFiles };
})();
const samplingHint = samplingInfo.hint;
if (!cacheUsable && cmdNeeded.length > 0) {
  console.log(`[eval-runner] sampling hint: ${samplingHint}`);
}

// ── P3-2：smoke 档 test 收窄（影响域抽样）────────────────────────────
// 触发条件缺一不可：① 档位=smoke；② test 命令在本次需要跑；③ 缓存未命中。
// 影响域 = 反向可达闭包（测试 →* 变更文件）。影响域为空 → 退化为 full
// （无证据不关闸）；命令非 vitest run 形态 → 不改写（buildSmokeTestCommand
// 内部裁决，hint 披露 mode）。收窄结果在控制台与报告元数据双重可见。
const smokeShard = (() => {
  if (samplingInfo.tier !== 'smoke' || !cmdNeeded.includes('test')) {
    return { mode: 'full', cmd: null, count: 0 };
  }
  try {
    // 影响域图必须是「含 tests/ 边」的完整图（buildImpactGraph）——
    // importGraph 的 collectImpactGraph 只扫 src/，测试→源码边不存在 ⇒
    // 闭包恒空（真实仓库 probe 实测 227 vs 0 的差异根因）。
    const impact = computeTestImpact(projectDir, (samplingInfo.changedFiles ?? []).map((f) => join(projectDir, f)), undefined);
    const impacted = [...impact.keys()];
    const testCmdRaw = getYamlString(configContent, 'test_cmd') ?? '';
    const built = buildSmokeTestCommand(testCmdRaw, impacted, projectDir);
    if (built.mode === 'impacted') {
      console.log(`[eval-runner] smoke shard: test narrowed to ${built.count}/${collectTestFiles(projectDir).length} impacted test file(s) (reverse-reachability closure)`);
    } else if (impacted.length === 0) {
      console.log('[eval-runner] smoke shard skipped: no test reaches the changed files — running full (no evidence, no shortcut)');
    } else {
      // 本仓 run-tests.mjs 形态：可识别但不改写（收窄语义只对 vitest run 有定义）
      console.log(`[eval-runner] smoke shard skipped: test_cmd is not a directly shardable vitest run form — running full (${impacted.length} impacted tests identified but not passed to the runner)`);
    }
    return { ...built, cmd: built.mode === 'impacted' ? built.cmd : null };
  } catch (e) {
    // 影响域计算失败 ≠ 评估失败：诚实回退全量
    console.warn(`[eval-runner] impact analysis failed (${e.message}) — test runs full (honest fallback)`);
    return { mode: 'full', cmd: null, count: 0 };
  }
})();

/** 惰性 memo：命令结果只在首次访问时执行（或从缓存取），未访问零开销。 */
const memo = {};
function memoRun(cmd, runner) {
  if (memo[cmd] !== undefined) return memo[cmd];
  const cached = cacheUsable ? loadCache(CACHE_FILE)?.results?.[cmd] : null;
  if (cached && cmdNeeded.includes(cmd)) {
    memo[cmd] = { ...cached, cached: true }; // 诚实标注：门禁/报告可区分证据来源
    return memo[cmd];
  }
  const started = Date.now();
  memo[cmd] = runner();
  memo[cmd].durationMs = Date.now() - started;
  return memo[cmd];
}

// ── cycle-97 P1：真并行（分离子进程 + 结果文件 + Atomics.wait 轮询）────
// test/lint/build 三条命令互相独立（各自独立子进程树、无共享可变状态），
// 串行总时长 = Σ T_i（本仓实测 ~70s）；并行后 = max T_i（~44s，加速比
// ≈ 1.6x——瓶颈是最大单命令 test，正是 Amdahl 上限形态）。
// 机制：同步 Node 脚本内无法 await，但可以 spawn **detached** 子进程并行跑，
// 主线程先评估全部廉价维度（E1/E2/E5/E6/Q1/Q4/Q6/Q8 零子进程开销，把
// 昂贵命令的墙钟时间与廉价评估重叠），再用 Atomics.wait 轮询收割结果
// 文件（比 sleep 循环精确、零 CPU 空转）。命令体在子进程里跑同一条
// execSync 路径（--run-cmd-only 复用 runXCommand 的预算/缓冲/三态语义，
// 逐字节一致）；子进程把 InvokeResult 形状的 JSON 落盘，父进程原样读取。
const PARALLEL_RESULT_DIR = () => join(projectDir, '.cycles', '.eval-parallel');
function parallelChildArgs(cmd) {
  const outFile = join(PARALLEL_RESULT_DIR(), `${cmd}.json`);
  return { outFile, args: ['--run-cmd-only', cmd, '--run-cmd-out', outFile] };
}

// 隐藏模式：--run-cmd-only <cmd> --run-cmd-out <file> —— 只跑一条命令并落盘。
// 这是并行子进程的入口（也是收割器契约）：独立解析，不影响正常 CLI 形状。
if (args.runCmdOnly) {
  const one = String(args.runCmdOnly);
  const outFile = String(args.runCmdOut || join(PARALLEL_RESULT_DIR(), `${one}.json`));
  const started = Date.now();
  const r = one === 'test' ? runTestCommand(projectDir, configContent)
    : one === 'lint' ? runLintCommand(projectDir, configContent)
    : one === 'build' ? runBuildCommand(projectDir, configContent)
    : { pass: false, output: `unknown command: ${one}` };
  const payload = { ...r, durationMs: Date.now() - started };
  try {
    mkdirSync(PARALLEL_RESULT_DIR(), { recursive: true });
    writeFileSyncParallel(outFile, JSON.stringify(payload));
  } catch (e) {
    console.error(`[eval-runner:child] result write failed: ${e.message}`);
    process.exit(3);
  }
  process.exit(0);
}

/** 收割：轮询等待全部结果文件就绪（超时回退 = 父进程自己串行补跑）。 */
function harvestParallel(cmds, timeoutMs) {
  const results = {};
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(cmds);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const c of [...pending]) {
      const f = join(PARALLEL_RESULT_DIR(), `${c}.json`);
      if (existsSync(f)) {
        try {
          results[c] = { ...JSON.parse(readFileSync(f, 'utf-8')), parallel: true };
          pending.delete(c);
        } catch { /* 半截文件（子进程还在写）→ 下一轮再读 */ }
      }
    }
    if (pending.size > 0) {
      // Atomics.wait 主线程精确睡眠 250ms（Node 主线程合法；比 busy-loop 零 CPU）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return { results, timedOut: pending.size > 0, pending: [...pending] };
}

// 并行触发条件：≥2 条命令且缓存未命中（1 条并行无收益；命中时零命令）。
const parallelEligible = cmdNeeded.length >= 2 && !cacheUsable;
const parallelStarted = [];
if (parallelEligible) {
  try {
    const { spawn } = await import('node:child_process');
    mkdirSync(PARALLEL_RESULT_DIR(), { recursive: true });
    const scriptPath = fileURLToPath(import.meta.url);
    for (const cmd of cmdNeeded) {
      const { outFile, args: extra } = parallelChildArgs(cmd);
      try { rmSyncSafe(outFile); } catch { /* 首跑无残留 */ }
      const child = spawn(process.execPath, [scriptPath, projectDir, ...extra], {
        stdio: 'ignore', detached: true,
        // cycle-98：detached 子进程在 Windows 上缺 windowsHide 会**每个弹一个
        // node(vitest) 控制台窗口**——eval-runner 一次派 3 个（test/lint/build），
        // 评估循环里反复触发就是一排弹窗。全部隐藏（stdio 已 ignore，无交互面）。
        windowsHide: true,
      });
      child.unref();
      parallelStarted.push(cmd);
    }
    console.log(`[eval-runner] parallel warm-up: ${parallelStarted.join(', ')} started in detached children (Amdahl: wall time ≈ max T_i instead of Σ T_i)`);
  } catch (e) {
    console.warn(`[eval-runner] parallel warm-up failed (${e.message}) — falling back to serial (honest degradation)`);
  }
}

/** 并行结果优先的 memoRun：收割到的直接用；缺席/超时的串行补跑（同语义）。 */
function memoRunWithParallel(cmd, runner) {
  if (memo[cmd] !== undefined) return memo[cmd];
  const cached = cacheUsable ? loadCache(CACHE_FILE)?.results?.[cmd] : null;
  if (cached && cmdNeeded.includes(cmd)) {
    memo[cmd] = { ...cached, cached: true };
    return memo[cmd];
  }
  if (parallelStarted.includes(cmd)) {
    // 预算上限 = 该命令自己的 timeout 预算（并行不放大总预算——预算纪律不变）
    const budgetMs = cmd === 'test' ? resolveTimeout('test', { configMs: timeoutFromConfig(configContent, 'test') })
      : cmd === 'lint' ? resolveTimeout('lint', { configMs: timeoutFromConfig(configContent, 'lint') })
      : resolveTimeout('build', { configMs: timeoutFromConfig(configContent, 'build') });
    const { results: harvested, pending } = harvestParallel(parallelStarted, budgetMs + 5000);
    for (const [c, r] of Object.entries(harvested)) {
      memo[c] = r;
      memo[c].durationMs = memo[c].durationMs ?? 0;
    }
    if (pending.includes(cmd)) {
      console.warn(`[eval-runner] parallel result for ${cmd} missing — running serially (same semantics)`);
      return memoRun(cmd, runner);
    }
    return memo[cmd];
  }
  return memoRun(cmd, runner);
}

const results = {};
const testResult = memoRunWithParallel('test', () => (cmdNeeded.includes('test') ? runTestCommand(projectDir, configContent, smokeShard.cmd) : { pass: false, skipped: true, detail: 'not requested (no dimension depends on test) → SKIP' }));
const lintResult = memoRunWithParallel('lint', () => (cmdNeeded.includes('lint') ? runLintCommand(projectDir, configContent) : { pass: false, skipped: true, detail: 'not requested (no dimension depends on lint) → SKIP' }));
const buildResult = memoRunWithParallel('build', () => (cmdNeeded.includes('build') ? runBuildCommand(projectDir, configContent) : { pass: false, skipped: true, detail: 'not requested (no dimension depends on build) → SKIP' }));

// 缓存持久化：只在本轮真的执行了命令时写（命中轮不重写——保持原 timestamp
// 语义：它记录的是「证据产生时刻」而不是「最后一次读取时刻」）。
const anyRan = cmdNeeded.some((c) => !memo[c]?.cached);
if (anyRan && merkleRoot !== null) {
  try {
    saveCache(CACHE_FILE, projectDir, PKG_VERSION, {
      build: buildResult.cached ? undefined : buildResult,
      test: testResult.cached ? undefined : testResult,
      lint: lintResult.cached ? undefined : lintResult,
      duration: Math.max(testResult.durationMs ?? 0, lintResult.durationMs ?? 0, buildResult.durationMs ?? 0),
    }, merkleRoot, CFG_FINGERPRINT_KEY); // ← 存调用方（src/ 子树）的指纹根 + 配置指纹（P3-3）
    console.log(`[eval-runner] results cached to ${CACHE_FILE} (keyed by Merkle root ${merkleRoot.slice(0, 12)}…)`);
  } catch (e) {
    // 缓存写失败不致命：评估结论已产生，只是下次要重跑（诚实降级，不是失败）
    console.warn(`[eval-runner] cache save failed (non-fatal, next run will be full): ${e.message}`);
  }
}

for (const dim of dimsToRun) {
  switch (dim) {
    case 'E1':
      results[dim] = checkSpecAlignment(projectDir);
      break;
    case 'E2':
      results[dim] = checkSpecConformance(projectDir);
      break;
    case 'E3':
      results[dim] = testResult;
      break;
    case 'E4':
      results[dim] = lintResult;
      break;
    case 'E5':
      // cycle-62（技能 v2.5.2）：工件通道——项目侧 .cycles/performance-baseline.md
      // 在位且含「基线」「阈值」关键词 → PASS（形状对即有证据）；缺失 → 维持 SKIP
      // （iteration-5 三态纪律不变：无工件=无证据，手工项不得凭空记 PASS）。
      // E5 不跑性能测量本身——测量由 test_cmd 全量跑时自然发生，工件承载基线事实。
      results[dim] = checkPerformanceBaseline(projectDir);
      break;
    case 'E6':
      results[dim] = checkSecurity(projectDir);
      break;
    case 'E7':
      results[dim] = checkDocSync(projectDir);
      break;
    case 'E8':
      results[dim] = testResult;
      break;
    case 'Q1':
      results[dim] = checkSpecAlignment(projectDir);
      break;
    case 'Q2':
      results[dim] = checkTestReports(projectDir, cycleDir);
      break;
    case 'Q3':
      results[dim] = buildResult;
      break;
    case 'Q4':
      results[dim] = combine([checkSecurity(projectDir), checkHardcodedSecrets(projectDir), checkDependencyAudit(projectDir)]);
      break;
    case 'Q5':
      results[dim] = combine([checkArchitectureLayers(projectDir), checkCircularDeps(projectDir)]);
      break;
    case 'Q6':
      results[dim] = combine([checkA11y(projectDir), checkI18n(projectDir), checkResponsive(projectDir)]);
      break;
    case 'Q7':
      results[dim] = combine([lintResult, checkComplexity(projectDir), checkErrorHandling(projectDir)]);
      break;
    case 'Q8':
      results[dim] = combine([checkDeliveryChecklist(projectDir, cycleDir), checkReviewEvidence(projectDir, cycleDir)]);
      break;
    default:
      results[dim] = { pass: false, detail: `Unknown dimension: ${dim}` };
  }
}

// 修 N-8a（v1.8.0）：部分维度运行不再整文件覆盖 项目评估报告.md——
// 未运行的维度从既有报告继承其结果行，已运行的维度以本次为准（后写者赢）。
// cycle-101：报告落回 cycle 的**真实位置**（活跃区优先，归档区回退）——
// 归档后仍写回 archive/cycle-N/，而不是写进不存在的活跃目录（ENOENT 实测）。
const reportPath = cycleDir ? join(cycleDirPath(projectDir, cycleDir), '项目评估报告.md') : null;
const isPartialRun = dimsToRun.length < Object.keys(DIMENSIONS).length;
const mergedResults = { ...results };
const mergedDims = [...dimsToRun];
if (reportPath && isPartialRun && existsSync(reportPath)) {
  const existing = readFileSync(reportPath, 'utf-8');
  for (const line of existing.split('\n')) {
    const m = line.match(/^\|\s*(E[1-8]|Q[1-8])\s*\|/);
    if (!m) continue;
    const dim = m[1];
    if (dimsToRun.includes(dim)) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    // 修 iteration-5：继承既有报告行时必须保留三态，否则 SKIP 会在下次部分运行时被读成 FAIL
    const status = cells[2];
    mergedResults[dim] = { pass: status === 'PASS', skipped: status === 'SKIP', detail: cells.slice(3).join(' | ') || '' };
    if (!mergedDims.includes(dim)) mergedDims.push(dim);
  }
  // 保持 E1..E8 → Q1..Q8 的报告顺序
  mergedDims.sort((a, b) => (a[0] === b[0] ? a.localeCompare(b) : a[0] === 'E' ? -1 : 1));
}

const report = generateReport(projectDir, cycleDir, mergedResults, mergedDims);

if (cycleDir) {
  atomicWriteFileSync(reportPath, report);
  const inherited = mergedDims.length - dimsToRun.length;
  console.log(`Evaluation report written to ${reportPath}`);
  if (inherited > 0) console.log(`  (merged: ${inherited} dimension(s) inherited from the existing report)`);
} else {
  console.log(report);
}

// 修 iteration-5：退出码只由 FAIL 决定；SKIP 不阻塞运行（否则文档型项目永远跑不完），
// 但必须响亮列出——"没评估"和"评估通过"在屏幕上长得一样，是 fail-open 的入口。
const failed = dimsToRun.filter(d => !results[d].pass && !results[d].skipped);
const skippedDims = dimsToRun.filter(d => results[d].skipped);
if (failed.length > 0) {
  console.error(`\n${failed.length} dimension(s) failed: ${failed.join(', ')}`);
  if (skippedDims.length > 0) {
    console.error(`${skippedDims.length} dimension(s) not evaluated (SKIP): ${skippedDims.join(', ')}`);
  }
  process.exit(1);
} else {
  console.log(`\nAll ${dimsToRun.length - skippedDims.length} evaluated dimension(s) passed.`);
  if (skippedDims.length > 0) {
    console.log(`${skippedDims.length} dimension(s) SKIPPED (not evaluated, NOT pass): ${skippedDims.join(', ')}`);
  }
}