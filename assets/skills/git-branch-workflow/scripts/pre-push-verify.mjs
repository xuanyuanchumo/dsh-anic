#!/usr/bin/env node
// pre-push-verify.mjs — dsh-anic git-branch-workflow 叶技能：主干 push 前门禁
//
// 契约：node pre-push-verify.mjs <workspace> [--allow-master] [--run-gates] [--json]
// 规则来源：docs/agents/CI-CD与发布流程.md:16,18
//   - 主干只进验证过的提交：push 前本地 typecheck && test && build 全绿
//   - 单人仓库允许直接 push master，但 commit message 必须写清「改了什么 + 为什么」
//
// 默认模式为「只读预检」：校验 package.json 三件套脚本存在、分支守卫、工作区状态。
// 加 --run-gates 才真正跑 pnpm run typecheck && test && build（顺序即依赖，ci.yml:60-73）。
//
// 安全：不写任何文件；spawnSync argv 数组，无 shell 插值；不接触任何令牌。
// 退出码：0 过 / 1 门禁失败 / 2 用法或环境错误。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GATE_SCRIPTS = ['typecheck', 'test', 'build'];

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function parseArgs(argv) {
  const out = { _: [], allowMaster: false, runGates: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-master') out.allowMaster = true;
    else if (a === '--run-gates') out.runGates = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function runGate(workspace, script) {
  const res = spawnSync('pnpm', ['run', script], { cwd: workspace, stdio: 'inherit', windowsHide: true });
  if (res.error) {
    process.stderr.write(`pre-push-verify: pnpm unavailable for '${script}': ${res.error.message}\n`);
    return 127;
  }
  return res.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node pre-push-verify.mjs <workspace> [--allow-master] [--run-gates] [--json]\n' +
        '  <workspace>   项目目录（第一位置参数 = 项目目录）\n' +
        '  --allow-master  允许直接 push master（单人仓库，见 CD 手册:18）\n' +
        '  --run-gates     真正执行 pnpm run typecheck && test && build\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);
  const problems = [];
  const warnings = [];

  const status = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (status.error || status.status !== 0) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, workspace, error: 'not a git repository' }) + '\n');
    else process.stderr.write('pre-push-verify: workspace not a git repo\n');
    return 2;
  }

  const pkgPath = path.join(workspace, 'package.json');
  const scripts = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {} : {};
  const missingScripts = GATE_SCRIPTS.filter((s) => !scripts[s]);
  if (missingScripts.length > 0) {
    problems.push(`package.json scripts missing: ${missingScripts.join(', ')} (required gate trio)`);
  }

  const branchRes = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchRes.stdout || '').trim();
  if (branch === 'master' && !args.allowMaster) {
    problems.push('pushing master without --allow-master: R3 主干只进验证过的提交（CD 手册:16）');
  }

  const porcelain = git(workspace, ['status', '--porcelain']);
  const dirty = (porcelain.stdout || '').trim().split('\n').filter(Boolean);
  if (dirty.length > 0) warnings.push(`working tree dirty (${dirty.length} entries) — 确认是否应随本次提交`);

  const distDir = path.join(workspace, 'dist');
  if (!fs.existsSync(distDir)) warnings.push('dist/ missing — build 尚未运行（dist 在 .gitignore:2）');

  const report = {
    ok: problems.length === 0,
    workspace,
    branch,
    gatesRun: false,
    problems,
    warnings,
  };

  if (args.runGates) {
    const pnpmVersion = spawnSync('pnpm', ['--version'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    if (pnpmVersion.error || pnpmVersion.status !== 0) {
      if (args.json) process.stdout.write(JSON.stringify({ ...report, ok: false, error: 'pnpm not found' }) + '\n');
      else process.stderr.write('pre-push-verify: pnpm not found — cannot run gates\n');
      return 2;
    }
    report.gatesRun = true;
    report.pnpmVersion = (pnpmVersion.stdout || '').trim();
    let failed = null;
    for (const script of GATE_SCRIPTS) {
      process.stdout.write(`\n>>> pnpm run ${script}\n`);
      const code = runGate(workspace, script);
      if (code !== 0) {
        failed = { script, code };
        break;
      }
    }
    report.gateFailure = failed;
    if (failed) problems.push(`gate failed: pnpm run ${failed.script} exit ${failed.code}`);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`pre-push-verify: ${workspace}\n`);
    process.stdout.write(`branch: ${branch}${report.gatesRun ? ` | pnpm ${report.pnpmVersion}` : ''}\n`);
    for (const w of warnings) process.stdout.write(`  warn: ${w}\n`);
    for (const p of problems) process.stdout.write(`  FAIL: ${p}\n`);
    if (report.gateFailure) process.stdout.write(`  gate failure: ${report.gateFailure.script} exit ${report.gateFailure.code}\n`);
    process.stdout.write(problems.length === 0 ? 'pre-push-verify: PASS\n' : 'pre-push-verify: FAIL\n');
  }
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
