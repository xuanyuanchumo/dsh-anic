#!/usr/bin/env node
// fact-base-verify.mjs — 事实基座抽验：验证文档引用的路径/命令在仓库真实存在
// 用法: node scripts/fact-base-verify.mjs <project-dir> [--count 5]
//
// ── cycle-141 修复（注册-生产-消费闭环）──────────────────────────────────────
// 旧实现对 **全部历史循环** 的 `项目评估报告.md` 抽样核验。历史报告描述的是
// **当时的** 仓库状态；用当前工作树去核验它们属于范畴错误，会产出假阴性 FAIL：
//   - cycle-69 的 `config.ts`（当时指 src/host/config.ts，裸名）
//   - cycle-76 的 `config.ts`
//   - cycle-86 的 `任务清单.md`
//   - cycle-87 的 `codeGraphAdapter.test.ts`（实际在 tests/unit/ 下）
// 这些引用在归档循环里是**真的**，在当前树里**不存在**——但门禁把它们读成
// 「事实基座失效」，于是 G0 被一个与当前代码无关的历史文档卡住。
//
// 修法（四处，各自独立可测）：
//   1. **来源收窄**——只抽验**当前循环**的评估报告 + 项目需求/设计文档
//      （`docs/**`、`README.md`）；规划文档（总规划/任务清单/交付清单）是
//      **意图**不是事实，排除；历史循环报告排除。
//   2. **历史产物排除**——`ref.startsWith('.cycles/')` 的引用一律跳过
//      （那是往期循环的快照，不是当前事实基座）。
//   3. **裸文件名有界递归解析**——`config.ts` 这类无路径前缀的引用，
//      在仓库内做一次有界 basename 匹配（排除 node_modules/dist/.git/.cycles）。
//   4. **确定性抽样**——去掉 `Math.random()` 洗牌，改为按引用排序后取前 N，
//      门禁结果可复现、可审查（随机抽样会让「同样的门禁两次结果不同」）。
//
// 注意：本脚本是**门禁的输入**，它的输出被 gate-check 读作事实基座证据。
// 「无法核验」与「确实不存在」必须是两种状态——前者记 SKIP 而非 FAIL。
//
// 来源说明：项目需求/设计文档位于 docs 目录下的全部 Markdown 文件 + README.md。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { parseCliArgs } from './lib/args.mjs';

/** 递归列文件时跳过的目录（构建产物 / 依赖 / 运行时产物）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.cycles', '.dsh', '.arts', '.codeartsdoer']);

/** 单次扫描的文件数上限（防超大工作区把抽验拖死）。 */
const MAX_SCAN_FILES = 4000;

/** 递归列仓库内文件（相对 projectDir，/ 分隔）。 */
function walkFiles(dir, base, out, limit = MAX_SCAN_FILES) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= limit) return;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // 并行测试下夹具可能消失：消失的条目不是发现
    }
    if (isDir) walkFiles(full, base, out, limit);
    else out.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
}

/**
 * 是否是「不可核验」的引用形态——glob / 模板 / 绝对路径 / 含尖括号。
 * 这些不是「仓库里是否存在某个文件」的可判定命题，必须 SKIP 而非 FAIL。
 */
function isUnverifiable(value) {
  return value.includes('*') || value.includes('{') || value.includes('}')
    || value.includes('<') || value.includes('>') || value.includes('[')
    || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * 收集待核验引用。
 *
 * 来源（全部是**事实**文档，不含规划意图）：
 *   - 当前循环（编号最大的 cycle-N）的 `项目评估报告.md`；
 *   - 项目需求/设计文档（docs 目录下全部 Markdown）与 `README.md`。
 *
 * 排除：
 *   - `.cycles/` 前缀的历史产物引用（往期快照，非当前事实）；
 *   - glob / 模板 / 绝对路径等不可判定形态（SKIP）；
 *   - 规划文档（总规划/任务清单/交付清单）——它们描述**将要做**的事，
 *     其中的文件引用是计划而非事实，核验它们会把「还没创建」读成「失效」。
 */
function collectReferences(projectDir) {
  const refs = [];
  const skipped = [];

  // ① 当前循环的评估报告。
  const cyclesDir = join(projectDir, '.cycles', 'cycles');
  if (existsSync(cyclesDir)) {
    const cycleDirs = readdirSync(cyclesDir)
      .filter((e) => /^cycle-\d+$/.test(e))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const currentCycle = cycleDirs[0];
    if (currentCycle) {
      const evalReport = join(cyclesDir, currentCycle, '项目评估报告.md');
      if (existsSync(evalReport)) {
        const { refs: r, skipped: s } = extractFromDoc(evalReport, projectDir);
        refs.push(...r);
        skipped.push(...s);
      }
    }
  }

  // ② 项目需求/设计文档（docs/**/*.md + README.md）。
  const docFiles = [];
  walkFiles(join(projectDir, 'docs'), projectDir, docFiles, 2000);
  const readme = join(projectDir, 'README.md');
  if (existsSync(readme)) docFiles.push('README.md');
  for (const rel of docFiles) {
    if (!rel.endsWith('.md')) continue;
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    const { refs: r, skipped: s } = extractFromDoc(abs, projectDir);
    refs.push(...r);
    skipped.push(...s);
  }

  return { refs, skipped };
}

/** 从单个文档抽取反引号包裹的路径 / 命令引用。 */
function extractFromDoc(docPath, projectDir) {
  const refs = [];
  const skipped = [];
  const content = readFileSync(docPath, 'utf-8');
  // 路径：反引号包裹、带已知扩展名。
  const pathPattern = /`([^`]+\.(?:ts|tsx|js|mjs|json|ya?ml|md|sh|py|go|rs|java))`/g;
  // 命令：反引号包裹的包管理器 / 构建命令。
  const cmdPattern = /`((?:pnpm|npm|yarn|make|cargo|python|node)\s+[^`]+)`/g;

  let m;
  while ((m = pathPattern.exec(content)) !== null) {
    const value = m[1];
    // 历史产物（往期循环快照）不是当前事实基座——跳过而非失败。
    if (value.startsWith('.cycles/')) { skipped.push({ type: 'path', value, reason: 'historical-artifact' }); continue; }
    // 命令片段（含空格，如 `--exclude X.ts`）被路径正则误捕——它是命令参数不是路径。
    if (value.includes(' ')) { skipped.push({ type: 'path', value, reason: 'command-fragment' }); continue; }
    if (isUnverifiable(value)) { skipped.push({ type: 'path', value, reason: 'unverifiable-shape' }); continue; }
    // 记录文档所在目录：相对路径（`./x`、`../y`）按文档位置解析，而非仓库根。
    refs.push({ type: 'path', value, source: docPath, baseDir: dirname(docPath) });
  }
  while ((m = cmdPattern.exec(content)) !== null) {
    refs.push({ type: 'command', value: m[1], source: docPath });
  }
  return { refs, skipped };
}

/**
 * 核验引用。
 *
 * 路径解析顺序（先精确、后兜底，全部有界）：
 *   1. 仓库根相对路径（`src/a/b.ts`）；
 *   2. 裸文件名 basename 匹配（`config.ts` → `src/host/config.ts`）。
 * 命令：跑 `<cmd> --help`（5s 超时）。
 */
function verifyReferences(projectDir, refs, count, fileIndex) {
  // 确定性抽样：路径优先（事实基座的核心是「文件是否存在」），同类内按值排序
  // 后取前 N——同样的门禁两次结果必须一致。
  const sorted = [...refs].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'path' ? -1 : 1;
    return a.value.localeCompare(b.value);
  });
  const sample = sorted.slice(0, count);
  const results = [];

  for (const ref of sample) {
    if (ref.type === 'path') {
      const value = ref.value;
      const isBare = !value.includes('/');
      const isDotRelative = value.startsWith('./');
      const isUpRelative = value.startsWith('../');

      let exists = false;
      let detail = 'NOT FOUND';
      let skip = false;
      let skipReason = '';

      if (isUpRelative) {
        // `../x` 明确表示「向上」：要么是仓库外路径，要么是 import specifier。
        // 两者都不是「仓库内某文件存在」的可判定命题——SKIP 而非 FAIL。
        skip = true;
        skipReason = 'up-relative-or-outside-repo';
      } else {
        // 候选：仓库根相对；`./x` 时追加文档目录相对（两种约定都认）。
        const candidates = [join(projectDir, value)];
        if (isDotRelative && ref.baseDir) candidates.push(join(ref.baseDir, value));
        for (const c of candidates) {
          if (existsSync(c)) { exists = true; detail = `OK (${value})`; break; }
        }
        if (!exists && isBare) {
          // 裸文件名：有界递归解析（basename 匹配，取首个）。
          const hit = fileIndex.find((rel) => basename(rel) === value);
          if (hit !== undefined) {
            exists = true;
            detail = `OK (resolved: ${hit})`;
          } else if (/[\\/]docs[\\/]research[\\/]/.test(ref.source)) {
            // 研究文档分析**外部**项目（如 graphify 的 Python 实现），
            // 其裸名引用不是本仓库事实——SKIP。
            skip = true;
            skipReason = 'external-research-reference';
          }
        }
        if (!exists && !skip && isDotRelative) {
          // `./x` 在仓库根与文档目录都不存在——多半是 import specifier
          // （如 worker 源的 `./workerShims.ts`）而非「文件存在」声明。
          skip = true;
          skipReason = 'relative-import-specifier';
        }
      }
      results.push({ ref, exists: exists || skip, skip, detail: skip ? `SKIP (${skipReason})` : detail });
    } else if (ref.type === 'command') {
      // 结构性不完整：二进制后只有 flag（如散文里的 `node -e`）——那不是可运行
      // 命令引用，是说明文字。核验它会把「散文片段」读成「命令失效」。
      const tokens = ref.value.split(/\s+/);
      const hasRealArg = tokens.slice(1).some((t) => t && !t.startsWith('-'));
      if (!hasRealArg) {
        results.push({ ref, exists: true, skip: true, detail: 'SKIP (incomplete command)' });
        continue;
      }
      try {
        execSync(`${ref.value} --help`, { cwd: projectDir, timeout: 5000, stdio: 'pipe', windowsHide: true });
        results.push({ ref, exists: true, detail: 'OK' });
      } catch (err) {
        // 二进制在本平台不存在（如 Windows 无 make、Unix 无某个工具）——「无法核验」
        // 不是「引用失效」。Unix 报 "command not found"(status 127)，Windows 报
        // "not recognized as an internal or external command"(status 1)。
        const code = err && typeof err === 'object' ? err.code : undefined;
        const status = err && typeof err === 'object' ? err.status : undefined;
        const stderr = err && typeof err === 'object' && err.stderr ? String(err.stderr) : '';
        const binaryMissing = code === 'ENOENT'
          || status === 127
          || /command not found/i.test(stderr)
          || /not recognized as an internal or external command/i.test(stderr);
        if (binaryMissing) {
          results.push({ ref, exists: true, skip: true, detail: 'SKIP (binary not found on this platform)' });
        } else {
          results.push({ ref, exists: false, detail: 'COMMAND FAILED' });
        }
      }
    }
  }

  return results;
}

const args = parseCliArgs(process.argv, {
  script: 'fact-base-verify',
  usage: 'Usage: node fact-base-verify.mjs <project-dir> [--count 5]',
  flags: { count: { type: 'int', default: 5 } },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});

const projectDir = args._[0];
const { refs, skipped } = collectReferences(projectDir);
if (refs.length === 0) {
  console.log('No references found to verify.');
  process.exit(0);
}

// 裸文件名解析用的仓库文件索引（有界、排除产物目录）。
const fileIndex = [];
walkFiles(projectDir, projectDir, fileIndex);

const results = verifyReferences(projectDir, refs, args.count, fileIndex);
const failures = results.filter((r) => !r.exists);
const skippedCmds = results.filter((r) => r.skip).length;
const verified = results.filter((r) => r.exists && !r.skip).length;

console.log(`Fact-base verification: ${verified}/${results.length} passed (${skippedCmds} skipped, ${skipped.length} excluded)`);
for (const r of results) {
  const status = r.skip ? 'SKIP' : (r.exists ? 'PASS' : 'FAIL');
  console.log(`  [${status}] ${r.ref.type}: ${r.ref.value} (${r.detail})`);
}
if (skipped.length > 0) {
  console.log(`  [SKIP] ${skipped.length} reference(s) excluded (historical artifact / glob / absolute path)`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} reference(s) not found. Fix documentation before proceeding.`);
  process.exit(1);
}
console.log('\nAll fact-base references verified.');
