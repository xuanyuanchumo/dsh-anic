#!/usr/bin/env node
// mirror-sync.mjs — dsh-anic gitee-mirror-sync 叶技能：GitHub → Gitee 镜像同步
//
// 契约：node mirror-sync.mjs <workspace> [--source origin] [--target gitee] [--mirror] [--prune] [--dry-run] [--json]
// 规则来源（镜像策略）：本技能 references/operations.md §1-§2
//   - 默认单向 pull-mirror：先 fetch source，再推 branches+tags
//   - --mirror 推全部 refs（含 notes/replace，有误删风险，先 --dry-run）
//   - --prune 删除 target 上已不存在的 refs
//
// 安全：只调用 git；spawnSync argv 数组无 shell 插值；不接触任何令牌（Gitee 凭据由
//       git 凭据 helper / SSH agent 提供）。默认不带 --dry-run 才会真正写远端。
// 退出码：0 成功 / 1 git 失败 / 2 用法或远端缺失。

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...opts });
}

function parseArgs(argv) {
  const out = {
    _: [],
    source: 'origin',
    target: 'gitee',
    mirror: false,
    prune: false,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--mirror') out.mirror = true;
    else if (a === '--prune') out.prune = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function remoteUrl(workspace, name) {
  const res = git(workspace, ['remote', 'get-url', name]);
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node mirror-sync.mjs <workspace> [--source origin] [--target gitee] ' +
        '[--mirror] [--prune] [--dry-run] [--json]\n' +
        '  <workspace>  项目目录（第一位置参数 = 项目目录）\n' +
        '  --dry-run     只打印将要执行的 git 命令，不执行\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);

  const repoCheck = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (repoCheck.error || repoCheck.status !== 0) {
    process.stderr.write('mirror-sync: workspace not a git repo\n');
    return 2;
  }

  const sourceUrl = remoteUrl(workspace, args.source);
  const targetUrl = remoteUrl(workspace, args.target);
  if (!sourceUrl) {
    process.stderr.write(`mirror-sync: source remote '${args.source}' not found\n`);
    return 2;
  }
  if (!targetUrl) {
    process.stderr.write(`mirror-sync: target remote '${args.target}' not found — 先 git remote add ${args.target} <url>\n`);
    return 2;
  }

  const fetchArgs = ['fetch', '--prune', args.source];
  const pushArgs = ['push'];
  if (args.prune) pushArgs.push('--prune');
  if (args.mirror) {
    pushArgs.push(args.target, '--mirror');
  } else {
    pushArgs.push(args.target, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*');
  }

  const plan = [
    { label: 'fetch', argv: ['git', ...fetchArgs], url: sourceUrl },
    { label: 'push', argv: ['git', ...pushArgs], url: targetUrl },
  ];

  if (args.dryRun) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ dryRun: true, workspace, source: { name: args.source, url: sourceUrl }, target: { name: args.target, url: targetUrl }, plan }, null, 2) + '\n');
    } else {
      process.stdout.write('mirror-sync: DRY RUN (no writes)\n');
      for (const p of plan) {
        process.stdout.write(`  ${p.label}: ${p.argv.slice(1).join(' ')}   # ${p.url}\n`);
      }
    }
    return 0;
  }

  const results = [];
  for (const p of plan) {
    const res = git(workspace, p.argv.slice(1), { stdio: 'inherit' });
    const code = res.error ? 1 : res.status ?? 1;
    results.push({ label: p.label, code, argv: p.argv.slice(1) });
    if (code !== 0) {
      if (args.json) process.stdout.write(JSON.stringify({ dryRun: false, workspace, source: args.source, target: args.target, results, failed: p.label }) + '\n');
      return code === 127 ? 2 : 1;
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ dryRun: false, workspace, source: args.source, target: args.target, results }) + '\n');
  } else {
    process.stdout.write('mirror-sync: PASS\n');
    for (const r of results) process.stdout.write(`  ok ${r.label}: ${r.argv.join(' ')}\n`);
  }
  return 0;
}

process.exitCode = main();
