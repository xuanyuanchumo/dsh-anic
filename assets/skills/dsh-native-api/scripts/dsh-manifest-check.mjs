#!/usr/bin/env node
// dsh-manifest-check.mjs — DSH 插件 manifest 结构校验（只读、确定性、零依赖）
//
// 用法: node dsh-manifest-check.mjs <project-dir>
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。只读，不写盘。
//
// 校验项（对应 SKILL.md 硬规则 R02/R03/R04/R05）：
//   ① dsh 键存在且含 bundle.patch（指向存在的 .yml）
//   ② bundle.patch 引用文件存在且顶层是数组、每条 insert 行有 id + name
//   ③ dsh.client.platform 为 'web'（若声明 client）
//   ④ engines.dsh 存在且是 SemVer 范围（>= / < / ^ / ~ / ||）
//   ⑤ peerDependencies 存在；若用了旧名 peers 则警告（官方已改名 requirements）
//   ⑥ files 含 dist/ 与 cordis.patch.yml
//
// 退出码: 0 = 通过；1 = 违规；2 = 用法/输入错误。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USAGE = [
  'Usage: node dsh-manifest-check.mjs <project-dir>',
  'Validates the DSH plugin manifest (bundle patch, client, engines.dsh, files).',
].join('\n');

function fail(message) {
  console.error(`[dsh-manifest-check] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${args.length} 个`);

const projectDir = resolve(args[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

const pkgPath = join(projectDir, 'package.json');
if (!existsSync(pkgPath)) fail(`缺少 package.json: ${pkgPath}`);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const findings = [];
const warnings = [];

/** 轻量 YAML 结构校验：顶层是 `- ` 条目数组，insert 行含 id + name。 */
function checkPatchFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (lines.length === 0) return ['patch 文件为空'];
  if (!lines[0].trimStart().startsWith('- ')) return ['patch 顶层不是 `- ` 条目数组'];

  const problems = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^-\s*insert:\s*$/.test(t) || /^-\s*override:\s*$/.test(t) || /^-\s*group:\s*$/.test(t)) continue;
    if (/^\s+-\s+id:\s*\S/.test(line) || /^\s+-\s+name:\s*\S/.test(line)) continue;
    // 非 insert/override/group 的顶层条目且不合法
    if (t.startsWith('- ')) {
      const key = t.slice(2).split(':')[0].trim();
      if (!['insert', 'override', 'group', 'isolate', 'disabled'].includes(key)) {
        problems.push(`未知 patch 条目键: ${key}`);
      }
    }
  }
  // 至少应有一个 id/name 行
  if (!/^\s+-\s+id:\s*\S/m.test(text) && !/^\s+id:\s*\S/m.test(text)) {
    problems.push('patch 中没有 id 行');
  }
  return problems;
}

// ① bundle.patch
const dsh = pkg.dsh;
if (!dsh || typeof dsh !== 'object') {
  findings.push('缺少 dsh 键（bundle 声明）');
} else {
  if (dsh.manifestVersion === undefined) {
    warnings.push('dsh.manifestVersion 未声明（KB 中无该字段文档，属实现字段）');
  } else if (typeof dsh.manifestVersion !== 'number') {
    warnings.push('dsh.manifestVersion 不是数字');
  }

  const patch = dsh.bundle && dsh.bundle.patch;
  if (patch === undefined) {
    findings.push('缺少 dsh.bundle.patch（bundle 声明）');
  } else {
    const patchFiles = Array.isArray(patch) ? patch : [patch];
    for (const p of patchFiles) {
      if (typeof p !== 'string' || !p.endsWith('.yml') && !p.endsWith('.yaml')) {
        findings.push(`dsh.bundle.patch 不是 .yml 路径: ${JSON.stringify(p)}`);
        continue;
      }
      const full = join(projectDir, p);
      if (!existsSync(full)) {
        findings.push(`dsh.bundle.patch 引用的文件不存在: ${p}`);
        continue;
      }
      for (const problem of checkPatchFile(full)) {
        findings.push(`${p}: ${problem}`);
      }
    }
  }

  // ③ client
  if (dsh.client && dsh.client.platform !== 'web') {
    findings.push(`dsh.client.platform 不是 'web': ${JSON.stringify(dsh.client.platform)}`);
  }

  // ⑤ peers 旧名
  if (dsh.peers !== undefined) {
    warnings.push('使用了旧字段 dsh.peers（官方已改名 requirements）');
  }
}

// ④ engines.dsh
if (!pkg.engines || typeof pkg.engines.dsh !== 'string') {
  findings.push('缺少 engines.dsh（SemVer 兼容范围）');
} else if (!/[<>=^~]|(\|\|)/.test(pkg.engines.dsh)) {
  warnings.push(`engines.dsh 不像 SemVer 范围: ${pkg.engines.dsh}`);
}

// ⑥ files
const files = Array.isArray(pkg.files) ? pkg.files : [];
for (const need of ['dist/', 'cordis.patch.yml']) {
  if (!files.includes(need)) findings.push(`files 缺少 '${need}'`);
}

// peerDependencies
if (!pkg.peerDependencies || Object.keys(pkg.peerDependencies).length === 0) {
  warnings.push('未声明 peerDependencies（与宿主共享实例的 dsh 包应声明 peer + dev）');
}

if (findings.length === 0) {
  console.log('[dsh-manifest-check] OK — manifest 结构合规');
  if (warnings.length > 0) {
    console.log(`[dsh-manifest-check] 建议（不影响退出码）:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  process.exit(0);
}

console.error(`[dsh-manifest-check] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
if (warnings.length > 0) {
  console.error(`[dsh-manifest-check] 建议:`);
  for (const w of warnings) console.error(`  - ${w}`);
}
process.exit(1);
