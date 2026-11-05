#!/usr/bin/env node
// pr-check.mjs — dsh-anic github-pr-actions 叶技能：PR 模板必填项 + gh 可用性守卫
//
// 契约：node pr-check.mjs <workspace> [--pr N] [--offline] [--json]
// 规则来源：.github/PULL_REQUEST_TEMPLATE.md:1-82
//   - 模板必填小节：变更摘要 / 关联循环 / 变更类型 / 验证证据 / 门禁状态 / 变更范围 /
//     破坏性变更 / 自查清单 / 人类判断门
//   - PR 必须 CI 全绿方可合并（PULL_REQUEST_TEMPLATE.md:82）
//
// 安全：只读；spawnSync argv 数组无 shell 插值；不接触任何令牌（gh 认证由 gh auth 或
//       DSH 凭证库负责）。--offline 时不调用 gh。
// 退出码：0 通过 / 1 缺失或 CI 非绿 / 2 用法或环境错误。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_SECTIONS = [
  '变更摘要',
  '关联循环',
  '变更类型',
  '验证证据',
  '门禁状态',
  '变更范围',
  '破坏性变更',
  '自查清单',
  '人类判断门',
];

function gh(args, cwd) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function parseArgs(argv) {
  const out = { _: [], pr: null, offline: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pr') out.pr = Number(argv[++i]) || null;
    else if (a === '--offline') out.offline = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node pr-check.mjs <workspace> [--pr N] [--offline] [--json]\n' +
        '  <workspace>  项目目录（第一位置参数 = 项目目录）\n' +
        '  --pr N       读取 PR 状态（需要 gh 认证）\n' +
        '  --offline    不调用 gh，只做模板检查\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);
  const problems = [];
  const notes = [];

  const tmplPath = path.join(workspace, '.github', 'PULL_REQUEST_TEMPLATE.md');
  let template = '';
  if (fs.existsSync(tmplPath)) {
    template = fs.readFileSync(tmplPath, 'utf8');
  } else {
    problems.push('.github/PULL_REQUEST_TEMPLATE.md missing');
  }

  const missing = REQUIRED_SECTIONS.filter((s) => !template.includes(s));
  if (missing.length > 0) problems.push(`PR template missing sections: ${missing.join(', ')}`);

  // gh 可用性（可选）。
  let ghAvailable = false;
  let ghError = null;
  if (!args.offline) {
    const v = gh(['--version'], workspace);
    ghAvailable = !v.error && v.status === 0;
    if (!ghAvailable) {
      ghError = (v.stderr || v.error?.message || 'gh not available').trim();
      notes.push(`gh unavailable (${ghError}) — 模板检查已完成，PR 状态用 --offline 跳过`);
    } else if (args.pr != null) {
      const res = gh(['pr', 'view', String(args.pr), '--json', 'number,title,state,mergeable'], workspace);
      if (res.error || res.status !== 0) {
        problems.push(`gh pr view ${args.pr} failed: ${(res.stderr || res.error?.message || 'unknown').trim()}`);
      } else {
        try {
          const pr = JSON.parse(res.stdout || '{}');
          if (pr.state && pr.state !== 'OPEN') problems.push(`PR ${args.pr} state=${pr.state} (not OPEN)`);
          if (pr.mergeable === 'MERGEABLE' && pr.state === 'OPEN') notes.push('PR reports MERGEABLE');
          if (pr.mergeable && pr.mergeable !== 'MERGEABLE' && pr.mergeable !== 'CONFLICTING') {
            notes.push(`PR mergeable=${pr.mergeable}`);
          }
        } catch (e) {
          problems.push(`gh pr view ${args.pr} returned non-JSON: ${e.message}`);
        }
      }
    }
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: problems.length === 0,
          workspace,
          templateFound: fs.existsSync(tmplPath),
          ghAvailable,
          ghError,
          missingSections: missing,
          problems,
          notes,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(`pr-check: ${workspace}\n`);
    process.stdout.write(`template: ${fs.existsSync(tmplPath) ? 'found' : 'MISSING'}${missing.length ? ` (missing ${missing.join(', ')})` : ''}\n`);
    process.stdout.write(`gh: ${ghAvailable ? 'available' : (args.offline ? 'skipped (--offline)' : 'UNAVAILABLE')}\n`);
    for (const n of notes) process.stdout.write(`  note: ${n}\n`);
    for (const p of problems) process.stdout.write(`  FAIL: ${p}\n`);
    process.stdout.write(problems.length === 0 ? 'pr-check: PASS\n' : 'pr-check: FAIL\n');
  }
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
