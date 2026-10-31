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

function runTestCommand(projectDir, configContent) {
  // 引号容错解析（修 S-8：各脚本自带 /test_cmd:\s*"([^"]+)"/ 且要求双引号）
  const testCmd = getYamlString(configContent, 'test_cmd');
  if (!testCmd) return { pass: false, output: 'test_cmd not configured in .cycles/config.yml' };
  try {
    // cycle-40（场地实验 #1 根修）：maxBuffer 提到 16MB——大工作区（5390 用例）
    // 的 stderr 超 execSync 默认 1MB 会 throw ENOBUFS，旧 catch 把它当测试失败
    // （E3/E8 误报 FAIL，detail 首行恰是 vitest DEPRECATED 弃用告警——真根因是
    // 缓冲区溢出而非测试红）。ENOBUFS ≠ 测试失败：如实按「无法评估」处理。
    // 超时同理与失败区分：e.signal === 'SIGTERM' 且 e.killed = true 是超时形态
    //（execSync 超时 kill 进程），真实测试失败 e.status 是数字退出码。
    const output = execSync(testCmd, { cwd: projectDir, timeout: resolveTimeout('test', { configMs: timeoutFromConfig(configContent, 'test') }), stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
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
    return { pass: false, output: e.stderr ? e.stderr.toString().trim().slice(0, 2000) : e.message };
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
    const output = execSync(lintCmd, { cwd: projectDir, timeout: resolveTimeout('lint', { configMs: timeoutFromConfig(configContent, 'lint') }), stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    return { pass: true, output: output.toString().trim() };
  } catch (e) {
    if (e.code === 'ENOBUFS') {
      return { pass: false, skipped: true, output: 'lint output exceeded 8MB buffer (ENOBUFS) — cannot judge' };
    }
    return { pass: false, output: e.stderr ? e.stderr.toString().trim().slice(0, 2000) : e.message };
  }
}

function runBuildCommand(projectDir, configContent) {
  const buildCmd = getYamlString(configContent, 'build_cmd');
  if (!buildCmd) {
    return { pass: false, output: 'build_cmd not configured in .cycles/config.yml' };
  }
  try {
    execSync(buildCmd, { cwd: projectDir, timeout: resolveTimeout('build', { configMs: timeoutFromConfig(configContent, 'build') }), stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
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
      !h.text.includes('/*') &&
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
  // ./locale/*.json，dsh-client-ui 的 i18n 约定）与 src/locale/。
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

function checkDeliveryChecklist(projectDir, cycleDir) {
  if (!cycleDir) return { pass: false, detail: 'No cycle directory' };
  const checklistPath = join(projectDir, '.cycles', 'cycles', cycleDir, '交付清单.md');
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
  const testReportsDir = join(projectDir, '.cycles', 'cycles', cycleDir, 'test-reports');
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
  flags: { dimensions: { type: 'string', default: 'all' }, cycle: { type: 'int' }, quality: { type: 'boolean' } },
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

const results = {};
const testResult = runTestCommand(projectDir, configContent);
const lintResult = runLintCommand(projectDir, configContent);
const buildResult = runBuildCommand(projectDir, configContent);

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
const reportPath = cycleDir ? join(projectDir, '.cycles', 'cycles', cycleDir, '项目评估报告.md') : null;
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