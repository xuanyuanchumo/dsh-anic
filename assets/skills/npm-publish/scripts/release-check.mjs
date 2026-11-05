#!/usr/bin/env node
// release-check.mjs — npm 发布前发布卫生校验（只读、确定性、零依赖）
//
// 用法:
//   node release-check.mjs <project-dir> [tag] [--report]
//
// 契约:
//   * 第一个位置参数 = 项目目录（绝对或相对，脚本内 resolve()）。
//     与主干技能的跨项目调用契约一致：绝不用 --project-dir 之类旗标传目录。
//   * 第二个可选位置参数 = 待发布 tag（缺省由 package.json.version 推导 `v<version>`）。
//   * `--report` = 只读 JSON 输出（退出码语义不变）。
//
// 校验项（对应 SKILL.md 硬规则 R01-R04/R09-R11）：
//   C1 version ⇄ CHANGELOG：CHANGELOG.md 必须含 `## vX.Y.Z` 版本段
//   C2 tag ⇄ version：tag 与 package.json.version 完全一致（不一致直接红，不猜）
//   C3 files 完整性：files 字段覆盖发布必需项（含 assets/skills/）
//   C4 .npmrc-publish 未提交：必须被 gitignore，且 git 跟踪列表里没有它
//   C5 repository 指回 GitHub（npm ↔ GitHub 关联，发布卫生）
//   C6 engines.node 存在（发布卫生）
//
// 退出码: 0 = 通过；1 = 存在违规；2 = 用法/输入错误。
// 安全: 只用 node:fs/child_process/path/crypto；spawnSync 全程 argv 数组，
//       无 shell 插值；不打印任何令牌；绝不创建/修改 .npmrc-publish。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SKILL = 'npm-publish';
const SCRIPT = 'release-check.mjs';

const USAGE = [
  `Usage: node ${SCRIPT} <project-dir> [tag] [--report]`,
  'Verifies CHANGELOG version sync, tag/version match, files manifest,',
  '.npmrc-publish not committed (plus repository/engines hygiene).',
].join('\n');

const REQUIRED_FILES = [
  'dist/',
  'assets/skill/',
  'assets/skills/',
  'assets/index/',
  'bin/',
  'locale/',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
];

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const rest = argv.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--report');
const report = flags.includes('--report');

if (unknown.length > 0) {
  console.error(`[release-check] 未知旗标: ${unknown.join(', ')}（仅支持 --report）`);
  console.error(USAGE);
  process.exit(2);
}
if (rest.length < 1 || rest.length > 2) {
  console.error(`[release-check] 只接受 1..2 个位置参数，收到 ${rest.length} 个`);
  console.error(USAGE);
  process.exit(2);
}

const projectDir = resolve(rest[0]);
if (!existsSync(projectDir)) {
  console.error(`[release-check] 项目目录不存在: ${projectDir}`);
  process.exit(2);
}

const pkgPath = join(projectDir, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[release-check] 缺少 package.json: ${pkgPath}`);
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`[release-check] package.json 解析失败: ${err.message}`);
  process.exit(2);
}

const version = typeof pkg.version === 'string' ? pkg.version : '';
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[release-check] package.json.version 非法: ${JSON.stringify(pkg.version)}`);
  process.exit(2);
}

const expectedTag = `v${version}`;
const tag = rest[1] ?? expectedTag;

const checks = [];
const warnings = [];
const findings = [];
function record(id, ok, detail) {
  checks.push({ id, ok, detail });
  if (!ok) findings.push(detail);
}

// C1 version ⇄ CHANGELOG（R01/R02）
const changelogPath = join(projectDir, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  record('changelog-version', false, '缺少 CHANGELOG.md');
} else {
  const changelog = readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{2,3}[ \\t]*v${escaped}([ \\t]|$)`, 'm');
  record(
    'changelog-version',
    re.test(changelog),
    `CHANGELOG.md 含 ${expectedTag} 段`,
  );
}

// C2 tag ⇄ version（R03）
record(
  'tag-version',
  tag === expectedTag,
  tag === expectedTag
    ? `tag '${tag}' 与 package.json.version '${version}' 一致`
    : `tag '${tag}' 与 package.json.version '${version}' 不一致（期望 ${expectedTag}）`,
);

// C3 files 完整性（R09）
const files = Array.isArray(pkg.files) ? pkg.files : [];
const missingFiles = REQUIRED_FILES.filter((need) => !files.includes(need));
record(
  'files-manifest',
  missingFiles.length === 0,
  missingFiles.length === 0
    ? `files 覆盖全部 ${REQUIRED_FILES.length} 个发布必需项`
    : `files 缺少: ${missingFiles.join(', ')}`,
);

// C4 .npmrc-publish 未提交（R10/R11）
//  仅检查 git 跟踪面；绝不创建/修改该文件。
const gitignorePath = join(projectDir, '.gitignore');
let gitignoreHasEntry = false;
if (existsSync(gitignorePath)) {
  gitignoreHasEntry = /^\s*\/?\.npmrc-publish\s*$/m.test(
    readFileSync(gitignorePath, 'utf8'),
  );
}
if (!gitignoreHasEntry) {
  warnings.push('.gitignore 未显式忽略 .npmrc-publish（建议补一行）');
}

const git = spawnSync('git', ['ls-files', '--', '.npmrc-publish'], {
  cwd: projectDir,
  encoding: 'utf8',
});
let npmrcCommitted = false;
let gitError = null;
if (git.error) {
  gitError = git.error.message;
} else if (git.status === 0) {
  npmrcCommitted = git.stdout.trim().length > 0;
} else {
  gitError = `git ls-files 退出 ${git.status}`;
}
if (npmrcCommitted) {
  record(
    'npmrc-publish-committed',
    false,
    '.npmrc-publish 已被 git 跟踪（含 ${NPM_TOKEN} 占位符，绝不可提交）',
  );
} else if (gitError) {
  warnings.push(`git 检查跳过（${gitError}）；未能证明 .npmrc-publish 未提交`);
  record('npmrc-publish-committed', true, `.npmrc-publish 未在 git 跟踪列表（git 跳过：${gitError}）`);
} else {
  record('npmrc-publish-committed', true, '.npmrc-publish 未在 git 跟踪列表');
}

// C5 repository 指回 GitHub（R09）
const repo = pkg.repository;
const repoUrl = typeof repo === 'string' ? repo : repo && repo.url;
record(
  'repository-github',
  typeof repoUrl === 'string' && /github\.com/.test(repoUrl),
  'package.json.repository 指向 GitHub 仓库',
);

// C6 engines.node 存在（R09）
const engines = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {};
record(
  'engines-node',
  typeof engines.node === 'string' && engines.node.length > 0,
  `engines.node = ${JSON.stringify(engines.node)}`,
);

const passed = findings.length === 0;
const reportBody = {
  skill: SKILL,
  script: SCRIPT,
  projectDir,
  version,
  tag,
  expectedTag,
  report,
  passed,
  counts: {
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
  },
  checks,
  warnings,
  findings,
};
reportBody.reportHash = createHash('sha256')
  .update(JSON.stringify(reportBody))
  .digest('hex');

if (report) {
  process.stdout.write(JSON.stringify(reportBody, null, 2) + '\n');
} else if (passed) {
  console.log(
    `[release-check] OK — tag=${tag} version=${version}，${checks.length} 项卫生全过` +
      (warnings.length > 0 ? `（${warnings.length} 条提醒）` : ''),
  );
  for (const w of warnings) console.log(`  ! ${w}`);
} else {
  console.error(`[release-check] 发现 ${findings.length} 项违规:`);
  for (const f of findings) console.error(`  - ${f}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
}

process.exit(passed ? 0 : 1);
