#!/usr/bin/env node
// release-check.mjs — 发布前四项卫生校验（只读、确定性、零依赖）
//
// 用法: node release-check.mjs <project-dir> [tag]
// 契约: 第一个位置参数 = 项目目录；第二个可选位置参数 = 待发布的 tag
//       （缺省用 package.json.version 推导 `v<version>`）。只读，不写盘。
//
// 校验项（对应 SKILL.md 硬规则 R03/R04/R05 + contributing 发布卫生）：
//   ① tag 与 package.json.version 完全一致（不一致直接红，不猜）
//   ② CHANGELOG.md 含 `## vX.Y.Z` 版本段
//   ③ package.json files 含发布必需项
//   ④ package.json repository 指回 GitHub 仓库（npm ↔ GitHub 关联）
//
// 退出码: 0 = 通过；1 = 存在违规；2 = 用法/输入错误。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USAGE = [
  'Usage: node release-check.mjs <project-dir> [tag]',
  'Verifies tag/version, CHANGELOG section, files manifest, repository field.',
].join('\n');

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error(`[release-check] 只接受 1..2 个位置参数，收到 ${args.length} 个`);
  console.error(USAGE);
  process.exit(2);
}

const projectDir = resolve(args[0]);
if (!existsSync(projectDir)) {
  console.error(`[release-check] 项目目录不存在: ${projectDir}`);
  process.exit(2);
}

const pkgPath = join(projectDir, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[release-check] 缺少 package.json: ${pkgPath}`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = typeof pkg.version === 'string' ? pkg.version : '';
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[release-check] package.json.version 非法: ${JSON.stringify(pkg.version)}`);
  process.exit(2);
}

const findings = [];
const expectedTag = `v${version}`;
const tag = args[1] ?? expectedTag;

// ① tag ↔ version
if (tag !== expectedTag) {
  findings.push(`tag '${tag}' 与 package.json.version '${version}' 不一致（期望 ${expectedTag}）`);
}

// ② CHANGELOG 版本段
const changelogPath = join(projectDir, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  findings.push('缺少 CHANGELOG.md');
} else {
  const changelog = readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{2,3}[ \\t]*v${escaped}([ \\t]|$)`, 'm');
  if (!re.test(changelog)) findings.push(`CHANGELOG.md 中没有 v${version} 的版本段落`);
}

// ③ files 发布清单
const requiredFiles = [
  'dist/',
  'assets/skill/',
  'assets/index/',
  'bin/',
  'locale/',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
];
const files = Array.isArray(pkg.files) ? pkg.files : [];
for (const need of requiredFiles) {
  if (!files.includes(need)) findings.push(`package.json files 缺少 '${need}'`);
}

// ④ repository 指回 GitHub
const repo = pkg.repository;
const repoUrl = typeof repo === 'string' ? repo : repo && repo.url;
if (typeof repoUrl !== 'string' || !/github\.com/.test(repoUrl)) {
  findings.push('package.json.repository 未指向 GitHub 仓库（npm ↔ GitHub 关联依赖它）');
}

if (findings.length === 0) {
  console.log(`[release-check] OK — tag=${tag} version=${version}，四项卫生全过`);
  process.exit(0);
}

console.error(`[release-check] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
