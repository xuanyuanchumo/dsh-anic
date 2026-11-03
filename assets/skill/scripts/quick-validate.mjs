#!/usr/bin/env node
// quick-validate.mjs — 自检脚本：验证 skill 包完整性
// 用法: node quick-validate.mjs <skill-dir>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseCliArgs } from './lib/args.mjs';

const REQUIRED_FILES = [
  'SKILL.md',
];

const REQUIRED_DIRS = [
  'references',
  'assets',
  'scripts',
  'evals',
];

const EXPECTED_REFERENCES = [
  'playbook.md',
  'principles.md',
  'gates.md',
  'autonomy.md',
  'auto-cycle.md',
  'multi-agent-gate.md',
  'evaluation.md',
  'quality-review.md',
  'state-transition.md',
  'adoption.md',
  'graph.md',
  'project-config.md',
  'scripts-reference.md',
  'troubleshooting.md',
];

const EXPECTED_SCRIPTS = [
  'init-workflow.mjs',
  'init-cycle.mjs',
  'gate-check.mjs',
  'eval-runner.mjs',
  'band-detector.mjs',
  'workflow-state.mjs',
  'gate-ledger.mjs',
  'plan-sync-check.mjs',
  'org-status.mjs',
  'fact-base-verify.mjs',
  'mcp-server.mjs',
  'quick-validate.mjs',
  'archive-cycle.mjs',
  'hitl-audit.mjs',
  'auto-fix-loop.mjs',
  'multi-agent-gate.mjs',
];

const EXPECTED_ASSETS_DIRS = [
  'templates',
  'config',
  'hooks',
];

// ---------- iteration-5：漂移守卫（错误级）----------
// 四轮进化中反复出现的漂移家族——版本三处漂移（1.5.0/1.6.0 曾并存）、配置入口分裂
// （cycle-config.yml vs config.yml）、绕过原子写、B 族旧词表残留——原先只能靠人工 grep
// 逐轮扫（每轮都能扫出新的一层：人读文档 / agent prompt / 机器 schema）。这里把它们变成
// 机器检查。守卫必须是 ERROR（exit 1）：告警级守卫等于没有守卫——没有任何一次构建会红。

// 逐字符清空注释但保留换行，保证报错行号指向真实位置（见 CLAUDE.md 扫描器纪律：
// 直接删除注释会让所有后续行号上移，指向错误的位置）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function walkFiles(dir, predicate, out = [], base = dir) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, out, base);
    else if (predicate(path)) out.push({ path, rel: path.slice(base.length + 1) });
  }
  return out;
}

// 守卫自身必须能失败：找不到锚点时不是"跳过"，而是报错（否则守卫会随被守卫物一起消失）
function checkVersionConsistency(skillDir) {
  const errors = [];
  const info = [];
  const anchors = [];

  const readIf = (rel) => {
    const p = join(skillDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };

  const skillMd = readIf('SKILL.md');
  const skillV = skillMd && skillMd.match(/MCP Tools \(v(\d+\.\d+\.\d+)\)/);
  if (skillV) anchors.push({ file: 'SKILL.md (MCP Tools vX)', version: skillV[1] });

  const serverSrc = readIf('scripts/mcp-server.mjs');
  const serverV = serverSrc && serverSrc.match(/name:\s*"ai-native-iteration-cycle",\s*version:\s*"(\d+\.\d+\.\d+)"/);
  if (serverV) anchors.push({ file: 'scripts/mcp-server.mjs (Server version)', version: serverV[1] });

  // iteration-6（cycle-75）：**第 4 版本位**——运行期横幅。
  // 实测缺陷：三锚均为 2.5.2，而脚本打印的横幅停在 v1.6.0（落后 9 个次版本），
  // 且**结构上不可见**——只要没人真跑起 MCP server 就永不暴露，升级 SOP 漏改
  // 一处即可潜伏多轮。版本守卫必须覆盖**每一处会被人读到的版本字面量**，
  // 否则「版本漂移」这个家族只是换了个藏身处。
  const bannerV = serverSrc && serverSrc.match(/MCP Server v(\d+\.\d+\.\d+)/);
  if (bannerV) anchors.push({ file: 'scripts/mcp-server.mjs (runtime banner)', version: bannerV[1] });

  const changelog = readIf('CHANGELOG.md');
  const clV = changelog && changelog.match(/^##\s+(\d+\.\d+\.\d+)/m);
  if (clV) anchors.push({ file: 'CHANGELOG.md (top entry)', version: clV[1] });

  // 锚点下限随覆盖面上调：3 → 4（少一个锚点 = 守卫面出现缺口，必须报错而非静默收窄）。
  const REQUIRED_ANCHORS = 4;
  if (anchors.length < REQUIRED_ANCHORS) {
    errors.push(`Version guard anchors incomplete (${anchors.length}/${REQUIRED_ANCHORS} found: ${anchors.map(a => a.file).join(', ') || 'none'}) — SKILL.md/MCP Tools(vX), mcp-server.mjs version, mcp-server.mjs runtime banner, CHANGELOG.md top entry are all required`);
  } else {
    const versions = new Set(anchors.map(a => a.version));
    if (versions.size > 1) {
      errors.push(`Version drift: ${anchors.map(a => `${a.file}=${a.version}`).join(' | ')}`);
    } else {
      info.push(`Version consistent across ${anchors.length} anchors: ${[...versions][0]}`);
    }
  }
  return { errors, info };
}

function checkConfigEntryUniqueness(scriptsDir) {
  const errors = [];
  // 样例字面量按拼接构造：守卫不得匹配自己的源码（CLAUDE.md：guard 必须自证不误伤）
  const LEGACY_NAME = 'cycle-' + 'config.yml';
  const files = walkFiles(scriptsDir, (p) => p.endsWith('.mjs'));
  for (const { path, rel } of files) {
    if (rel === join('lib', 'config.mjs')) continue; // 兼容层所在，唯一允许处
    const src = stripComments(readFileSync(path, 'utf-8'));
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(LEGACY_NAME)) {
        errors.push(`Config entry split: scripts/${rel}:${i + 1} references the legacy cycle-config filename in code (must go through scripts/lib/config.mjs)`);
      }
    }
  }
  return errors;
}

function checkAtomicWrites(scriptsDir) {
  const errors = [];
  const warnings = [];
  const CALL = 'writeFile' + 'Sync(';
  const IMPORT_RE = new RegExp('import\\s*\\{[^}]*\\b' + 'writeFile' + 'Sync' + '\\b[^}]*\\}');
  const files = walkFiles(scriptsDir, (p) => p.endsWith('.mjs'));
  for (const { path, rel } of files) {
    const raw = readFileSync(path, 'utf-8');
    const src = stripComments(raw);
    if (rel !== join('lib', 'fs-safe.mjs') && src.includes(CALL)) {
      const line = src.split('\n').findIndex(l => l.includes(CALL)) + 1;
      errors.push(`Non-atomic write: scripts/${rel}:${line} calls ${CALL.slice(0, -1)} directly (use lib/fs-safe.mjs atomicWriteFileSync)`);
    }
    // 死 import：引了 writeFileSync 却没有调用点（v1.8.3 改造后的遗留）
    if (IMPORT_RE.test(src) && !src.includes(CALL)) {
      warnings.push(`Unused import: scripts/${rel} imports ${CALL.slice(0, -1)} but never calls it`);
    }
  }
  return { errors, warnings };
}

// B 族（已废弃）维度名不得再作为维度名出现。"技术债务/功能覆盖"等词在别处是正常概念
// （.cycles/tech-debt/ 台账、复盘里的"减少技术债务"），所以只在**与维度编号绑定**的
// 上下文里判罚：同一行出现 E1-E8/Q1-Q8，或形如 name: "…" 的维度名绑定。
// 过宽的规则会把概念词误判成漂移——那正是"守卫变成噪音后被忽略"的路径。
const RETIRED_DIMENSION_NAMES = ['功能覆盖', '架构健康', '技术债务', '测试成熟度', '性能与稳定', '安全与可访问', '创新差异化', '多源对照增强'];
const VOCAB_EXEMPT = [join('references', 'evaluation.md'), 'CHANGELOG.md', join('scripts', 'quick-validate.mjs')];

function isDimensionNameContext(line) {
  const boundToId = /\b[EQ][1-8]\b/.test(line);
  const boundByName = /name\s*[:：]\s*["']?/.test(line);
  return boundToId || boundByName;
}

function checkDimensionVocabulary(skillDir) {
  const errors = [];
  const files = walkFiles(skillDir, (p) => /\.(md|yml|yaml|json)$/.test(p));
  for (const { path, rel } of files) {
    if (VOCAB_EXEMPT.includes(rel)) continue;
    const src = readFileSync(path, 'utf-8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!isDimensionNameContext(lines[i])) continue;
      for (const name of RETIRED_DIMENSION_NAMES) {
        if (lines[i].includes(name)) {
          errors.push(`Retired dimension vocabulary: ${rel}:${i + 1} uses "${name}" as a dimension name (B family retired; scripts/lib/dimensions.mjs is the only source)`);
        }
      }
    }
  }
  return errors;
}

// ---------- cycle-80 WS-3 G-04：发行新鲜度（--freshness，默认关闭）----------
// 被守卫缺陷：本脚本原先只校验四锚与目录结构 ⇒「assets 改了忘 repair / 文档与发行源脱钩」
// 依旧全绿，因为判据里**没有**"发行面是否与自身一致"的证据（cycle-72 F-07 实事故：live 副本
// 落后发行源、manifest 版本滞留，而 quick-validate 照常说 PASS）。
// 只做**可机械判定**的两类，不做模糊语义检查：
//  ① scripts 索引完整性（双向）：scripts/*.mjs ↔ references/scripts-reference.md 的目录索引；
//  ② 版本锚一致性：SKILL.md 的 `MCP Tools (vX.Y.Z)` == CHANGELOG.md 顶部 `## X.Y.Z`，
//     且 references 里 `技能 vX.Y.Z` 自述版本必须同号（同一次发布的文档面）。
// 附：若 CHANGELOG 顶部条声明了「SKILL.md（N 行）」，机械比对实际行数；未声明则明示 skip
// （不猜"应该多少行"——那属于语义判断，会变成噪音）。
function checkFreshness(skillDir) {
  const items = [];
  const readIf = (rel) => {
    const p = join(skillDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
  const ref = readIf(join('references', 'scripts-reference.md'));
  const scriptsDir = join(skillDir, 'scripts');
  const actual = existsSync(scriptsDir)
    ? readdirSync(scriptsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => e.name)
      .sort()
    : [];

  // ① scripts 索引（双向：真实脚本都要被登记；登记项都必须真实存在）
  if (!ref) {
    items.push({ ok: false, text: 'references/scripts-reference.md missing — cannot verify scripts index' });
  } else {
    const indexed = [...ref.matchAll(/^\s*-\s*\[scripts\/([^\]]+\.mjs)\]/gm)].map((m) => m[1]);
    const missing = actual.filter((n) => !indexed.includes(n));
    const ghost = indexed.filter((n) => !actual.includes(n));
    items.push(missing.length === 0
      ? { ok: true, text: `scripts index complete (${actual.length}/${actual.length} scripts documented)` }
      : { ok: false, text: `scripts index missing: ${missing.map((n) => `scripts/${n}`).join(', ')} — add a TOC entry in references/scripts-reference.md` });
    if (ghost.length > 0) {
      items.push({ ok: false, text: `scripts index has ghost entries: ${ghost.map((n) => `scripts/${n}`).join(', ')} — files do not exist` });
    }
  }

  // ② 版本锚一致性（发行源本体 ↔ 变更日志顶部；references 自述版本同号）
  const skillV = (readIf('SKILL.md') || '').match(/MCP Tools \(v(\d+\.\d+\.\d+)\)/);
  const changelog = readIf('CHANGELOG.md') || '';
  const clV = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m);
  if (!skillV || !clV) {
    const which = !skillV ? 'SKILL.md "MCP Tools (vX.Y.Z)"' : 'CHANGELOG.md top "## X.Y.Z"';
    items.push({ ok: false, text: `version anchor missing: ${which} not found` });
  } else if (skillV[1] !== clV[1]) {
    items.push({ ok: false, text: `version anchor drift: SKILL.md=${skillV[1]} vs CHANGELOG.md top=${clV[1]}` });
  } else {
    items.push({ ok: true, text: `version anchor consistent: SKILL.md=CHANGELOG.md top=${skillV[1]}` });
    const refVersions = [...new Set([...((ref || '').matchAll(/技能 v(\d+\.\d+\.\d+)/g))].map((m) => m[1]))];
    const drifted = refVersions.filter((v) => v !== skillV[1]);
    items.push(drifted.length > 0
      ? { ok: false, text: `references version drift: ${drifted.map((v) => `技能 v${v}`).join(', ')} vs SKILL.md=${skillV[1]}` }
      : { ok: true, text: refVersions.length > 0 ? `references declare skill v${skillV[1]} consistently` : 'references declare no explicit skill version (nothing to drift)' });
    // ③ 可选行数声明（CHANGELOG 顶部条若写了「SKILL.md（N 行）」才比对）
    const topEntry = changelog.split(/^##\s+\d+\.\d+\.\d+/m)[1] || '';
    const claim = topEntry.match(/SKILL\.md[（(]\s*(\d+)\s*行/);
    const skillLines = (readIf('SKILL.md') || '').split('\n').length;
    if (claim) {
      items.push(Number(claim[1]) === skillLines
        ? { ok: true, text: `SKILL.md line-count matches CHANGELOG claim: ${skillLines}` }
        : { ok: false, text: `SKILL.md line-count drift: actual=${skillLines} vs CHANGELOG claim=${claim[1]}` });
    } else {
      items.push({ ok: true, text: `SKILL.md line-count: no claim in CHANGELOG top entry (actual=${skillLines}, nothing to verify)` });
    }
  }
  return items;
}

function validateSkillPackage(skillDir) {
  const errors = [];
  const warnings = [];
  const info = [];

  for (const f of REQUIRED_FILES) {
    const path = join(skillDir, f);
    if (!existsSync(path)) {
      errors.push(`Missing required file: ${f}`);
    } else {
      info.push(`Found: ${f}`);
    }
  }

  for (const d of REQUIRED_DIRS) {
    const path = join(skillDir, d);
    if (!existsSync(path)) {
      errors.push(`Missing required directory: ${d}/`);
    } else {
      info.push(`Found: ${d}/`);
    }
  }

  const refsDir = join(skillDir, 'references');
  if (existsSync(refsDir)) {
    for (const ref of EXPECTED_REFERENCES) {
      const path = join(refsDir, ref);
      if (!existsSync(path)) {
        warnings.push(`Missing reference: references/${ref}`);
      }
    }
  }

  const scriptsDir = join(skillDir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const script of EXPECTED_SCRIPTS) {
      const path = join(scriptsDir, script);
      if (!existsSync(path)) {
        warnings.push(`Missing script: scripts/${script}`);
      } else {
        try {
          const content = readFileSync(path, 'utf-8');
          if (!content.startsWith('#!/usr/bin/env node')) {
            warnings.push(`Script ${script} missing shebang line`);
          }
          if (!content.includes('// ') && !content.includes('import ')) {
            warnings.push(`Script ${script} appears empty or malformed`);
          }
        } catch {
          warnings.push(`Cannot read script: scripts/${script}`);
        }
      }
    }
  }

  const assetsDir = join(skillDir, 'assets');
  if (existsSync(assetsDir)) {
    for (const d of EXPECTED_ASSETS_DIRS) {
      const path = join(assetsDir, d);
      if (!existsSync(path)) {
        warnings.push(`Missing assets directory: assets/${d}/`);
      }
    }
  }

  const evalsDir = join(skillDir, 'evals');
  if (existsSync(evalsDir)) {
    const evalFiles = readdirSync(evalsDir).filter(f => f.endsWith('.json'));
    if (evalFiles.length === 0) {
      warnings.push('No eval JSON files found in evals/');
    } else {
      for (const ef of evalFiles) {
        try {
          JSON.parse(readFileSync(join(evalsDir, ef), 'utf-8'));
          info.push(`Valid eval: evals/${ef}`);
        } catch {
          errors.push(`Invalid JSON in evals/${ef}`);
        }
      }
    }
  }

  if (existsSync(join(skillDir, 'SKILL.md'))) {
    const skillContent = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    if (skillContent.length < 500) {
      warnings.push('SKILL.md seems too short (< 500 chars)');
    }
    if (!skillContent.includes('## ') && !skillContent.includes('# ')) {
      warnings.push('SKILL.md missing markdown headers');
    }
  }

  // ---------- iteration-5：漂移守卫（错误级，见文件头说明）----------
  const versionCheck = checkVersionConsistency(skillDir);
  errors.push(...versionCheck.errors);
  info.push(...versionCheck.info);

  errors.push(...checkConfigEntryUniqueness(join(skillDir, 'scripts')));
  errors.push(...checkDimensionVocabulary(skillDir));

  const atomicCheck = checkAtomicWrites(join(skillDir, 'scripts'));
  errors.push(...atomicCheck.errors);
  warnings.push(...atomicCheck.warnings);

  let totalSize = 0;
  const countFiles = (dir) => {
    if (!existsSync(dir)) return 0;
    let count = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // cycle-98：pnpm 布局下符号链接可能悬空（node_modules/.pnpm/...），readdir 失败不算损坏。
      return 0;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // 悬空符号链接：Dirent.isSymbolicLink() 为真时 statSync 会 ENOENT（实测
      // node_modules/.pnpm/node_modules/tslib），统计场景跳过而不是崩溃。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        count += countFiles(path);
      } else {
        try {
          totalSize += statSync(path).size;
        } catch {
          continue; // stat 失败的文件不计数（竞态删除/权限），不中断统计
        }
        count++;
      }
    }
    return count;
  };

  const fileCount = countFiles(skillDir);

  return { errors, warnings, info, fileCount, totalSize };
}

const args = parseCliArgs(process.argv, {
  script: 'quick-validate',
  usage: 'Usage: node quick-validate.mjs <skill-dir> [--freshness]\n'
    + 'anic_skill tool NOTE: the tool prepends the project dir as the first positional; '
    + 'pass skill-dir via args and it lands as the SECOND positional — pick args._[1] ?? args._[0] below.',
  flags: { freshness: { type: 'boolean' } },
  positionals: { min: 1, max: 2, name: 'skill-dir' },
});

// cycle-31：经 anic_skill 工具调用时 spawn 形如
//   node quick-validate.mjs <project-dir> <skill-dir>
// （工具契约：workspace 恒为第一位置参数）；直接 CLI 调用时只有 <skill-dir>。
// 取最后一个位置参数：两种形态都指向 skill-dir；项目目录不参与校验。
const skillDir = resolve(args._[args._.length - 1]);

if (!existsSync(skillDir)) {
  console.error(`Skill directory not found: ${skillDir}`);
  process.exit(1);
}

const result = validateSkillPackage(skillDir);

console.log(`=== Skill Package Validation ===`);
console.log(`Directory: ${skillDir}`);
console.log(`Total files: ${result.fileCount}`);
console.log(`Total size: ${(result.totalSize / 1024).toFixed(1)} KB`);
console.log(``);

if (result.errors.length > 0) {
  console.log(`ERRORS (${result.errors.length}):`);
  for (const e of result.errors) {
    console.log(`  [ERROR] ${e}`);
  }
  console.log(``);
}

if (result.warnings.length > 0) {
  console.log(`WARNINGS (${result.warnings.length}):`);
  for (const w of result.warnings) {
    console.log(`  [WARN] ${w}`);
  }
  console.log(``);
}

console.log(`INFO (${result.info.length}):`);
for (const i of result.info) {
  console.log(`  [OK] ${i}`);
}

// cycle-80 WS-3：freshness 段仅在 --freshness 时出现（关闭时 stdout 与旧版逐字节一致）
const freshnessItems = args.freshness ? checkFreshness(skillDir) : [];
if (args.freshness) {
  console.log(``);
  console.log(`FRESHNESS (${freshnessItems.length}):`);
  for (const it of freshnessItems) {
    console.log(`  [${it.ok ? 'OK' : 'FAIL'}] freshness: ${it.text}`);
  }
}

const freshnessFailed = freshnessItems.filter((i) => !i.ok).length;

console.log(``);
if (result.errors.length > 0 || freshnessFailed > 0) {
  // 旧文案在关闭 freshness 时逐字节保留（只在开启且有过期项时追加计数）
  const stale = args.freshness ? `, ${freshnessFailed} stale freshness item(s)` : '';
  console.error(`VALIDATION FAILED: ${result.errors.length} error(s)${stale} found.`);
  process.exit(1);
} else if (result.warnings.length > 0) {
  console.log(`VALIDATION PASSED with ${result.warnings.length} warning(s).`);
} else {
  console.log(`VALIDATION PASSED. All checks OK.`);
}