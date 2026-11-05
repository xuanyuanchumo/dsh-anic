#!/usr/bin/env node
// layer-order-check.mjs — DSH 层加载顺序与 patch 结构校验（只读、确定性、零依赖）
//
// 用法: node layer-order-check.mjs <project-dir>
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。只读，不写盘。
//
// 官方层顺序（kb/site/develop/basic/publish.md:123-137）：
//   1. profile 的 dsh.profile.bundles 列表所列各 bundle patch（按列表顺序）
//   2. profile 自己的 cordis.patch.yml
//   3. home 级 $DSH_HOME/cordis.patch.yml
//   4. 每个 --patch <path> overlay（按 argv 顺序）
//
// 校验项（对应 SKILL.md 硬规则 R02/R05）：
//   ① package.json 的 dsh.bundle.patch 指向存在的 .yml
//   ② 发现的每个 patch 文件顶层是 `- ` 条目数组、insert 行有 id + name
//   ③ 跨 patch 文件不重复声明同一 (kind, id, name) 行（层间冲突风险）
//   ④ 打印规范化的层顺序与各文件归属（信息性）
//
// 退出码: 0 = 通过；1 = 违规；2 = 用法/输入错误。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const USAGE = [
  'Usage: node layer-order-check.mjs <project-dir>',
  'Validates patch file structure and the declared layer-loading order.',
].join('\n');

function fail(message) {
  console.error(`[layer-order-check] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${args.length} 个`);

const projectDir = resolve(args[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

const CANONICAL_ORDER = [
  '1. profile bundles（dsh.profile.bundles 列表顺序）',
  '2. profile 自己的 cordis.patch.yml',
  '3. home 级 $DSH_HOME/cordis.patch.yml',
  '4. 每个 --patch <path> overlay（argv 顺序）',
];

const findings = [];

/** 提取 patch 文件里所有 (kind, id, name) 行。 */
function extractRows(text) {
  const rows = [];
  let currentKind = '?';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const insertMatch = /^-\s*(insert|override|group|isolate):\s*$/.exec(t);
    if (insertMatch) {
      currentKind = insertMatch[1];
      continue;
    }
    const idMatch = /^\s+-\s+id:\s*(.+)$/.exec(line) ?? /^\s+id:\s*(.+)$/.exec(line);
    const nameMatch = /^\s+-\s+name:\s*(.+)$/.exec(line) ?? /^\s+name:\s*(.+)$/.exec(line);
    const id = idMatch ? idMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
    const name = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
    if (id || name) rows.push({ kind: currentKind, id, name });
  }
  return rows;
}

/** 结构校验：顶层是 `- ` 条目数组，且至少有一个 id 行。 */
function checkStructure(text) {
  const problems = [];
  const meaningful = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (meaningful.length === 0) return ['patch 文件为空'];
  if (!meaningful[0].trimStart().startsWith('- ')) problems.push('patch 顶层不是 `- ` 条目数组');
  if (!/^\s+-\s+id:\s*\S/m.test(text) && !/^\s+id:\s*\S/m.test(text)) {
    problems.push('patch 中没有 id 行');
  }
  return problems;
}

// ① 发现 patch 文件（排除 node_modules/dist/.git 等）
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'artifacts', '.cycles', 'coverage']);
const patchFiles = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (st.isFile() && (entry === 'cordis.patch.yml' || /(^|\.)patch\.ya?ml$/i.test(entry))) {
      patchFiles.push(full);
    }
  }
}
walk(projectDir);

// ③ 跨文件重复行
const seenRows = new Map();
for (const file of patchFiles) {
  const text = readFileSync(file, 'utf8');
  for (const problem of checkStructure(text)) {
    findings.push(`${rel(projectDir, file)}: ${problem}`);
  }
  for (const row of extractRows(text)) {
    const key = `${row.kind}|${row.id ?? ''}|${row.name ?? ''}`;
    if (seenRows.has(key)) {
      findings.push(`重复的 patch 行 ${key}（${rel(projectDir, file)} 与 ${rel(projectDir, seenRows.get(key))}）`);
    } else {
      seenRows.set(key, file);
    }
  }
}

// ① bundle.patch 解析
const pkgPath = join(projectDir, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (patch === undefined) {
    findings.push('package.json 未声明 dsh.bundle.patch（第 1 层缺失）');
  } else {
    for (const p of Array.isArray(patch) ? patch : [patch]) {
      if (!existsSync(join(projectDir, p))) {
        findings.push(`dsh.bundle.patch 引用的文件不存在: ${p}`);
      }
    }
  }
}

function rel(root, file) {
  return relative(root, file).split(sep).join('/');
}

// ④ 打印规范化层顺序
console.log('[layer-order-check] 规范化层顺序:');
for (const layer of CANONICAL_ORDER) console.log(`  ${layer}`);
console.log(`[layer-order-check] 发现 ${patchFiles.length} 个 patch 文件:`);
for (const file of patchFiles) console.log(`  ${rel(projectDir, file)}`);

if (findings.length === 0) {
  console.log('[layer-order-check] OK — patch 结构合规，无跨层重复行');
  process.exit(0);
}

console.error(`[layer-order-check] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
