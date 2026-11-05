#!/usr/bin/env node
// drift-check.mjs — dsh-anic gitee-mirror-sync 叶技能：GitHub↔Gitee 镜像漂移检测
//
// 契约：node drift-check.mjs <workspace> [--source origin] [--target gitee] [--json]
// 规则来源：本技能 references/operations.md §4（漂移即证据）
//   - shared-diverged：同名分支 SHA 不同
//   - source-only：GitHub 有、Gitee 无
//   - target-only：Gitee 有、GitHub 无
//
// 安全：只读（git ls-remote）；spawnSync argv 数组无 shell 插值；不接触令牌。
// 退出码：0 一致 / 1 漂移 / 2 用法或远端缺失。

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function parseArgs(argv) {
  const out = { _: [], source: 'origin', target: 'gitee', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function listHeads(workspace, remote) {
  const res = git(workspace, ['ls-remote', '--heads', remote]);
  if (res.error) return { ok: false, error: res.error.message, heads: new Map() };
  if (res.status !== 0) return { ok: false, error: (res.stderr || 'ls-remote failed').trim(), heads: new Map() };
  const heads = new Map();
  for (const line of (res.stdout || '').split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);
    if (m) heads.set(m[2], m[1]);
  }
  return { ok: true, error: null, heads };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node drift-check.mjs <workspace> [--source origin] [--target gitee] [--json]\n' +
        '  <workspace>  项目目录（第一位置参数 = 项目目录）\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);

  const repoCheck = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (repoCheck.error || repoCheck.status !== 0) {
    process.stderr.write('drift-check: workspace not a git repo\n');
    return 2;
  }

  const src = listHeads(workspace, args.source);
  const tgt = listHeads(workspace, args.target);
  if (!src.ok) {
    process.stderr.write(`drift-check: source '${args.source}' ls-remote failed: ${src.error}\n`);
    return 2;
  }
  if (!tgt.ok) {
    process.stderr.write(`drift-check: target '${args.target}' ls-remote failed: ${tgt.error}\n`);
    return 2;
  }

  const diverged = [];
  const sourceOnly = [];
  const targetOnly = [];
  for (const [name, sha] of src.heads) {
    if (!tgt.heads.has(name)) sourceOnly.push(name);
    else if (tgt.heads.get(name) !== sha) diverged.push({ branch: name, source: sha, target: tgt.heads.get(name) });
  }
  for (const name of tgt.heads.keys()) {
    if (!src.heads.has(name)) targetOnly.push(name);
  }

  const drift = diverged.length + sourceOnly.length + targetOnly.length;
  const report = {
    ok: drift === 0,
    workspace,
    source: args.source,
    target: args.target,
    sourceBranches: src.heads.size,
    targetBranches: tgt.heads.size,
    diverged,
    sourceOnly,
    targetOnly,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`drift-check: ${workspace}\n`);
    process.stdout.write(`  ${args.source}: ${src.heads.size} branches | ${args.target}: ${tgt.heads.size} branches\n`);
    for (const d of diverged) {
      process.stdout.write(`  DIVERGED ${d.branch}: ${d.source.slice(0, 10)}..${d.target.slice(0, 10)}\n`);
    }
    for (const n of sourceOnly) process.stdout.write(`  SOURCE-ONLY ${n}\n`);
    for (const n of targetOnly) process.stdout.write(`  TARGET-ONLY ${n}\n`);
    process.stdout.write(drift === 0 ? 'drift-check: IN SYNC\n' : `drift-check: DRIFT (${drift})\n`);
  }
  return drift === 0 ? 0 : 1;
}

process.exitCode = main();
