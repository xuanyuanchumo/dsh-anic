#!/usr/bin/env node
// pack-stable.mjs — 稳定名 tarball 的命名规则校验器（只读、确定性、零依赖）
//
// 用法:
//   node pack-stable.mjs <project-dir> [--report]
//
// 契约:
//   * 第一个位置参数 = 项目目录（绝对或相对，脚本内 resolve()）。
//     与主干技能的跨项目调用契约一致：绝不用 --project-dir 之类旗标传目录。
//   * `--report` = 只读 JSON 输出（退出码语义不变）。
//
// 本脚本**绝不执行 `pnpm pack` / `npm pack`**——它只：
//   1. 校验命名规则：发布 tarball 的稳定名必须是 `<package.name>.tgz`
//      （如 `dsh-anic.tgz`），**不得**带版本号（如 `dsh-anic-0.56.0.tgz`）。
//      marketplace 条目的 `tarball:` URL 要求不随版本变化（见
//      docs/agents/CI-CD与发布流程.md:65-67；.github/workflows/release.yml:117-125）。
//   2. 扫描项目根与 `.pack/` 下的现有 `*.tgz`，判断稳定名是否已就位。
//   3. 打印重命名命令与 sha256 命令（不执行）。
//
// 退出码: 0 = 已稳定名 / 尚未 pack（计划模式）；1 = 只存在版本名 tarball（命名违规）；2 = 用法错误。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILL = 'npm-publish';
const SCRIPT = 'pack-stable.mjs';

const USAGE = [
  `Usage: node ${SCRIPT} <project-dir> [--report]`,
  'Validates the stable tarball name rule (<package.name>.tgz) and prints',
  'the rename + sha256 commands. Never runs pnpm/npm pack.',
].join('\n');

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const rest = argv.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--report');
const report = flags.includes('--report');

if (unknown.length > 0) {
  console.error(`[pack-stable] 未知旗标: ${unknown.join(', ')}（仅支持 --report）`);
  console.error(USAGE);
  process.exit(2);
}
if (rest.length !== 1) {
  console.error(`[pack-stable] 只接受 1 个位置参数，收到 ${rest.length} 个`);
  console.error(USAGE);
  process.exit(2);
}

const projectDir = resolve(rest[0]);
if (!existsSync(projectDir)) {
  console.error(`[pack-stable] 项目目录不存在: ${projectDir}`);
  process.exit(2);
}

const pkgPath = join(projectDir, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[pack-stable] 缺少 package.json: ${pkgPath}`);
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`[pack-stable] package.json 解析失败: ${err.message}`);
  process.exit(2);
}

const name = typeof pkg.name === 'string' ? pkg.name : '';
const version = typeof pkg.version === 'string' ? pkg.version : '';
const nameOk = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
const versionOk = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
if (!nameOk || !versionOk) {
  console.error(
    `[pack-stable] package.json name/version 非法: ${JSON.stringify({ name, version })}`,
  );
  process.exit(2);
}

const stableName = `${name}.tgz`;
const versionedName = `${name}-${version}.tgz`;
const packDir = join(projectDir, '.pack');

function listTarballs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tgz'))
    .map((e) => e.name)
    .sort();
}

const rootTgz = listTarballs(projectDir);
const packTgz = listTarballs(packDir);
const allTgz = [...rootTgz, ...packTgz.map((f) => `.pack/${f}`)];

const hasStable = allTgz.includes(stableName) || allTgz.includes(`.pack/${stableName}`);
const hasVersioned = allTgz.includes(versionedName) || allTgz.includes(`.pack/${versionedName}`);
const hasOther = allTgz.filter((f) => f !== stableName && f !== `.pack/${stableName}`);

// 命名违规判定：存在任何 tarball，但稳定名未就位。
const violation = allTgz.length > 0 && !hasStable;

const renameCmd =
  allTgz.length === 0
    ? `# pnpm pack 后执行: cp ${versionedName} ${stableName}`
    : `cp ${hasVersioned ? versionedName : allTgz[0]} ${stableName}`;

const result = {
  skill: SKILL,
  script: SCRIPT,
  projectDir,
  packageName: name,
  version,
  stableName,
  versionedName,
  tarballsFound: allTgz,
  hasStable,
  hasVersioned,
  violation,
  status: violation ? 'VIOLATION' : hasStable ? 'STABLE' : 'PLANNED',
  renameCommand: renameCmd,
  sha256Commands: [
    `sha256sum ${stableName} | tee ${stableName}.sha256`,
    `Get-FileHash -Algorithm SHA256 ${stableName}   # Windows PowerShell 等价`,
  ],
  // 供 marketplace `tarball:` 字段使用的稳定 URL 提示（不联网验证）。
  stableUrlHint: `发布附件固定名 ${stableName}，marketplace tarball URL 不应含版本号`,
};

if (report) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  console.log(`[pack-stable] package: ${name}@${version}`);
  console.log(`[pack-stable] pnpm pack 默认产物: ${versionedName}`);
  console.log(`[pack-stable] 期望稳定名: ${stableName}`);
  console.log(`[pack-stable] 状态: ${result.status}`);
  if (allTgz.length > 0) {
    console.log(`[pack-stable] 已发现 tarball: ${allTgz.join(', ')}`);
  } else {
    console.log('[pack-stable] 尚未 pack（计划模式：本脚本不执行 pnpm pack）');
  }
  console.log(`[pack-stable] 重命名命令: ${renameCmd}`);
  console.log(`[pack-stable] sha256: ${result.sha256Commands[0]}`);
  console.log(`[pack-stable]          # Windows: ${result.sha256Commands[1]}`);
  if (violation) {
    console.error(
      `[pack-stable] 命名违规：产物必须重命名为 ${stableName}（marketplace tarball URL 不随版本变化）`,
    );
  }
}

process.exit(violation ? 1 : 0);
