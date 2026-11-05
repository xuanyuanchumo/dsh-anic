#!/usr/bin/env node
// workflow-lint.mjs — GitHub Actions 工作流结构校验（只读、确定性、零依赖）
//
// 用法: node workflow-lint.mjs <project-dir>
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。
//       只读，不写盘，不联网；不解析 YAML，只做行级结构检查。
//
// 校验项（对应 SKILL.md 硬规则 R01/R07/R08/R10）：
//   CI     ① on: 触发面含 push + pull_request
//         ② permissions: contents: read
//         ③ 步骤顺序 Build → Typecheck → Lint → Test
//         ④ pnpm install 带 --frozen-lockfile
//         ⑤ 不出现 --live（显式跳过并说明，不是假绿）
//         ⑥ job 级 ANIC_SELF_AUDIT: '0'
//   Release ⑦ 触发面含 v* tag 或 workflow_dispatch
//         ⑧ 有 tag↔version 校验步、CHANGELOG 校验步
//         ⑨ 有 pnpm pack + dsh-anic.tgz 稳定名
//
// 退出码: 0 = 通过 / 无工作流可查；1 = 存在违规；2 = 用法错误。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USAGE = [
  'Usage: node workflow-lint.mjs <project-dir>',
  'Validates .github/workflows/*.yml structure (read-only).',
].join('\n');

function fail(message) {
  console.error(`[workflow-lint] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${args.length} 个`);

const projectDir = resolve(args[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

const workflowsDir = join(projectDir, '.github', 'workflows');
if (!existsSync(workflowsDir)) {
  console.log('[workflow-lint] 未找到 .github/workflows/ —— 无工作流可校验，退出 0');
  process.exit(0);
}

/** 提取所有「步骤名」行（缩进 ≥4 空格的 `- name:`）。 */
function stepNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {4,}-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function findIndex(names, re) {
  return names.findIndex((n) => re.test(n));
}

function checkOrder(names, findings, label) {
  const order = [
    ['build', /build/i],
    ['typecheck', /typecheck/i],
    ['lint', /lint/i],
    ['test', /test/i],
  ];
  const idx = order.map(([, re]) => findIndex(names, re));
  const missing = order.filter(([name], i) => idx[i] === -1).map(([name]) => name);
  if (missing.length > 0) {
    findings.push(`${label}: 缺少步骤 ${missing.join(' / ')}`);
    return;
  }
  for (let i = 1; i < idx.length; i += 1) {
    if (idx[i] < idx[i - 1]) {
      findings.push(`${label}: 步骤顺序错误（${order[i - 1][0]} 应在 ${order[i][0]} 之前）`);
    }
  }
}

const findings = [];
const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/i.test(f));

if (files.length === 0) {
  console.log('[workflow-lint] .github/workflows/ 下无 .yml/.yaml 文件，退出 0');
  process.exit(0);
}

for (const file of files) {
  const text = readFileSync(join(workflowsDir, file), 'utf8');
  const rel = `.github/workflows/${file}`;

  if (/^\s*name:\s*CI\s*$/m.test(text)) {
    if (!/^\s*push:\s*$/m.test(text)) findings.push(`${rel}: 缺少 push 触发面`);
    if (!/pull_request:/.test(text)) findings.push(`${rel}: 缺少 pull_request 触发面`);
    if (!/permissions:\s*$/m.test(text) || !/contents:\s*read/.test(text)) {
      findings.push(`${rel}: 缺少 permissions: contents: read`);
    }
    const names = stepNames(text);
    if (names.length > 0) checkOrder(names, findings, rel);
    if (!/--frozen-lockfile/.test(text)) findings.push(`${rel}: pnpm install 缺少 --frozen-lockfile`);
    // 只扫 run 命令行；注释里讨论 --live 是文档而非执行。
    for (const line of text.split(/\r?\n/)) {
      if (/--live\b/.test(line) && !/^\s*#/.test(line)) {
        findings.push(`${rel}: run 命令出现 --live（CI 应显式跳过真实宿主层）`);
        break;
      }
    }
    if (!/ANIC_SELF_AUDIT:\s*'0'/.test(text)) findings.push(`${rel}: 缺少 job 级 ANIC_SELF_AUDIT: '0'`);
  }

  if (/^\s*name:\s*Release\s*$/m.test(text)) {
    if (!/tags:\s*\[[^\]]*v\*/.test(text) && !/workflow_dispatch/.test(text)) {
      findings.push(`${rel}: Release 缺少 v* tag 触发或 workflow_dispatch`);
    }
    if (!/package\.json/.test(text) || !/version/.test(text)) {
      findings.push(`${rel}: Release 缺少 tag↔package.json.version 校验`);
    }
    if (!/CHANGELOG\.md/.test(text)) findings.push(`${rel}: Release 缺少 CHANGELOG 版本段校验`);
    if (!/pnpm pack/.test(text)) findings.push(`${rel}: Release 缺少 pnpm pack`);
    if (!/dsh-anic\.tgz/.test(text)) findings.push(`${rel}: Release 缺少稳定名 dsh-anic.tgz`);
  }
}

if (findings.length === 0) {
  console.log(`[workflow-lint] OK — 校验 ${files.length} 个工作流，无结构违规`);
  process.exit(0);
}

console.error(`[workflow-lint] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
