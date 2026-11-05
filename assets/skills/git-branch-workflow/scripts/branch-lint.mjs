#!/usr/bin/env node
// branch-lint.mjs — dsh-anic git-branch-workflow 叶技能确定性守卫
//
// 契约：node branch-lint.mjs <workspace> [--limit N] [--json]
// 规则来源：docs/agents/CI-CD与发布流程.md:10-25
//   - 分支四类：master / feat/<域>-<主题> / fix/<issue>-<主题> / chore/<主题>
//   - commit：<type>(<scope>): <结论>，type ∈ feat/fix/docs/refactor/test/chore
//   - 版本收口：v0.X.Y cycle-N: ...
//
// 安全：只读，零写入；仅用 node:child_process/node:path；spawnSync argv 数组，无 shell 插值。
// 退出码：0 全过 / 1 存在违规 / 2 用法或环境错误。

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BRANCH_RE = /^(master|feat\/.+|fix\/.+|chore\/.+)$/;
const COMMIT_TYPES = new Set(['feat', 'fix', 'docs', 'refactor', 'test', 'chore']);
// 版本收口提交：type 取值含 `v<版本号>`（docs/agents/CI-CD与发布流程.md §2）。
// 真实形态 `v0.56.0 cycle-104 收口:...`——`cycle-N` 后不一定紧跟冒号（`收口` 等词在前）。
// 故只锚定 `v<semver>` 前缀；`cycle-\d+` 作为信息项另记（不强制冒号位置）。
const VERSION_RE = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/;
const CYCLE_TAG_RE = /cycle-\d+/;

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const out = { _: [], limit: 20, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]) || 20;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function classify(subject) {
  if (VERSION_RE.test(subject)) return { ok: true, kind: 'version' };
  const m = subject.match(/^([A-Za-z]+)\(([^)]*)\):\s*(.+)$/);
  if (m) {
    const type = m[1].toLowerCase();
    return { ok: COMMIT_TYPES.has(type), kind: 'conventional', type, scope: m[2] };
  }
  return { ok: false, kind: 'unknown' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node branch-lint.mjs <workspace> [--limit N] [--json]\n' +
        '  <workspace> 项目目录（第一位置参数 = 项目目录，绝不传 --project-dir 旗标）\n' +
        '  --limit N   最近检查的 commit 条数（默认 20）\n' +
        '  --json      机器可读输出\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);
  const problems = [];

  const status = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (status.error || status.status !== 0) {
    const msg = (status.stderr || status.error?.message || 'not a git repository').trim();
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, workspace, error: msg }) + '\n');
    else process.stderr.write(`branch-lint: workspace not a git repo: ${msg}\n`);
    return 2;
  }

  const branchRes = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchRes.stdout || '').trim();
  if (!BRANCH_RE.test(branch)) {
    problems.push(`branch '${branch}' does not match master|feat/<域>-<主题>|fix/<issue>-<主题>|chore/<主题>`);
  }

  const logRes = git(workspace, ['log', '-n', String(args.limit), '--pretty=format:%H%x00%s']);
  const commits = (logRes.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split('\x00');
      return { hash: (hash || '').slice(0, 10), subject: rest.join('\x00') };
    })
    .filter((c) => c.subject);

  const bad = [];
  for (const c of commits) {
    const r = classify(c.subject);
    if (!r.ok) bad.push({ hash: c.hash, subject: c.subject, reason: r.kind });
  }
  if (bad.length > 0) problems.push(`${bad.length} commit(s) not matching commit convention`);

  if (args.json) {
    process.stdout.write(
      JSON.stringify({
        ok: problems.length === 0,
        workspace,
        branch,
        branchOk: BRANCH_RE.test(branch),
        inspected: commits.length,
        violations: problems,
        commits: bad,
      }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(`branch-lint: ${workspace}\n`);
    process.stdout.write(`branch: ${branch} ${BRANCH_RE.test(branch) ? 'OK' : 'VIOLATION'}\n`);
    for (const c of commits) {
      const r = classify(c.subject);
      const tag = r.ok ? 'OK' : 'VIOLATION';
      const detail = r.kind === 'version' ? ' (版本收口)' : r.kind === 'conventional' ? ` (${r.type}(${r.scope}))` : '';
      process.stdout.write(`  ${tag} ${c.hash} ${c.subject}${detail}\n`);
    }
    if (problems.length > 0) {
      process.stdout.write('\nproblems:\n');
      for (const p of problems) process.stdout.write(`  - ${p}\n`);
    } else {
      process.stdout.write(`\nbranch-lint: PASS (${commits.length} commits inspected)\n`);
    }
  }
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
