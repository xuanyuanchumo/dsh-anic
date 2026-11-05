#!/usr/bin/env node
// ssh-selfcheck.mjs — SSH remote 形态与敏感文件保护自检（只读、确定性、零依赖）
//
// 用法: node ssh-selfcheck.mjs <project-dir>
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。
//       只读，不写盘，不改动 git 配置；git 查询用 spawnSync + argv 数组，绝不拼 shell 字符串。
//
// 校验项（对应 SKILL.md 硬规则 R06/R07）：
//   ① origin 的 URL 是 SSH 形态（git@github.com:… 或 ssh://git@github.com/…）
//   ② .gitignore 覆盖 .npmrc-publish（含 token 占位符）
//   ③ .gitignore 覆盖 .env
//
// 退出码: 0 = 通过；1 = 违规；2 = 用法/输入错误。
//
// 说明：本脚本只做**静态形态**检查，不建立 SSH 连接；SSH 可达性用
//   `ssh -T git@github.com`（期望 `Hi <user>!`）单独自检（见 references/operations.md §3）。

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const USAGE = [
  'Usage: node ssh-selfcheck.mjs <project-dir>',
  'Checks that origin is an SSH-form GitHub remote and that sensitive files are gitignored.',
].join('\n');

function fail(message) {
  console.error(`[ssh-selfcheck] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${args.length} 个`);

const projectDir = resolve(args[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

/** 以 argv 数组方式调用 git（无 shell 注入面）。 */
function git(args2, cwd) {
  const res = spawnSync('git', args2, { cwd, encoding: 'utf8' });
  if (res.error) return { ok: false, stdout: '' };
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() };
}

const findings = [];

// ① origin remote 形态
const remote = git(['remote', '-v'], projectDir);
if (!remote.ok) {
  findings.push('无法执行 git remote -v（可能不是 git 仓库，或 git 不在 PATH）');
} else {
  const originLines = remote.stdout.split(/\r?\n/).filter((l) => l.startsWith('origin'));
  if (originLines.length === 0) {
    findings.push('未配置 origin remote');
  } else {
    const url = originLines[0].split(/\s+/)[1] ?? '';
    const isSsh = /^(git@github\.com:|ssh:\/\/git@github\.com\/)/.test(url);
    if (!isSsh) {
      findings.push(`origin 不是 SSH 形态: ${url}（期望 git@github.com:xuanyuanchumo/dsh-anic.git）`);
    } else {
      console.log(`[ssh-selfcheck] origin = ${url}（SSH 形态 OK）`);
    }
  }
}

// ②③ .gitignore 覆盖
const gitignorePath = join(projectDir, '.gitignore');
const hardChecks = { '.npmrc-publish': 'R07（token 占位符，值经 vault_run 注入）' };
const softChecks = { '.env': '建议覆盖（环境变量，本仓当前未显式忽略）' };
const warnings = [];
if (!existsSync(gitignorePath)) {
  findings.push('缺少 .gitignore');
} else {
  const gi = readFileSync(gitignorePath, 'utf8');
  for (const [file, rule] of Object.entries(hardChecks)) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\s*$`, 'm');
    if (!re.test(gi)) findings.push(`.gitignore 未覆盖 '${file}'（${rule}）`);
  }
  for (const [file, rule] of Object.entries(softChecks)) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\s*$`, 'm');
    if (!re.test(gi)) warnings.push(`.gitignore 未覆盖 '${file}'（${rule}）`);
  }
}

if (findings.length === 0) {
  console.log('[ssh-selfcheck] OK — SSH remote 形态正确，敏感文件已忽略');
  if (warnings.length > 0) {
    console.log(`[ssh-selfcheck] 建议（不影响退出码）:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log('[ssh-selfcheck] 提示: SSH 可达性仍需 `ssh -T git@github.com` 单独自检（本脚本不联网）');
  process.exit(0);
}

console.error(`[ssh-selfcheck] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
