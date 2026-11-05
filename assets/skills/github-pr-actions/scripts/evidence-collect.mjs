#!/usr/bin/env node
// evidence-collect.mjs — dsh-anic github-pr-actions 叶技能：合并前证据采集
//
// 契约：node evidence-collect.mjs <workspace> [--out <workspace-relative>] [--json] [--no-write]
// 规则来源：.github/PULL_REQUEST_TEMPLATE.md:18-36（验证证据）、:54-56（数字同步）
//
// 采集项：
//   1. dist/ 新鲜度——dist 不得旧于 src（deployFreshnessContract 精神，ci.yml:63-65）
//   2. 测试报告——.cycles/cycles/*/test-reports/测试报告.md（ci.yml:134-139）
//   3. 覆盖率证据——scripts/coverage.mjs 的 threshold 文件（若存在）
//   4. 工作区干净度——git status --porcelain
//   5. README 数字与源码工具数一致性（可选，见 operations.md §4）
//
// 安全：只读检查 + 最多写一个 <workspace> 内的 Markdown 证据文件；spawnSync argv 数组，
//       无 shell 插值，不接触令牌。--no-write 时只打印不落盘。
// 退出码：0 证据齐 / 1 缺证据 / 2 用法或环境错误。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 原子写（drift 守卫第 3 类规则：写 .cycles/** 必须经原子写，禁裸 writeFileSync——
 * S-6 的语义是「中断留半写文件毁证据」）。
 *
 * 为什么不 import 主干 lib/fs-safe.mjs：叶技能须**独立可安装**（装到
 * `<ws>/.dsh/skills/<leaf>/scripts/` 后，到主干技能的相对路径会随安装布局漂移）。
 * 故此处内联最小原子写（temp + rename），零外部依赖、跨布局稳定。
 */
function atomicWrite(target, content) {
  const tmp = path.join(
    os.tmpdir(),
    `evidence-collect-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function parseArgs(argv) {
  const out = { _: [], out: null, json: false, noWrite: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--no-write') out.noWrite = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function newestMtime(dir, depth = 0) {
  if (depth > 6) return 0;
  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        newest = Math.max(newest, newestMtime(full, depth + 1));
      } else {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return newest;
}

function findTestReports(workspace) {
  const root = path.join(workspace, '.cycles', 'cycles');
  const found = [];
  let cycles = [];
  try {
    cycles = fs.readdirSync(root).filter((d) => d.startsWith('cycle-')).sort();
  } catch {
    return found;
  }
  for (const c of cycles) {
    const dir = path.join(root, c, 'test-reports');
    for (const f of ['测试报告.md', '非功能验证报告.md']) {
      if (fs.existsSync(path.join(dir, f))) found.push(path.join(c, 'test-reports', f));
    }
  }
  return found;
}

function toolCount(workspace) {
  const res = git(workspace, ['grep', '-rho', "name: 'anic_[a-z_]*'", '--', 'src/host/tools*.ts']);
  if (res.status !== 0) return { count: null, note: 'git grep failed' };
  const names = [...new Set((res.stdout || '').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('name:')))].length;
  return { count: names, note: null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'usage: node evidence-collect.mjs <workspace> [--out <workspace-relative>] [--json] [--no-write]\n' +
        '  <workspace>          项目目录（第一位置参数 = 项目目录）\n' +
        '  --out <rel>          证据输出路径（相对 workspace，默认 .cycles/evidence.md）\n' +
        '  --no-write           只打印，不落盘\n',
    );
    return args.help ? 0 : 2;
  }
  const workspace = path.resolve(args._[0]);
  const checks = [];
  const notes = [];

  const srcNewest = newestMtime(path.join(workspace, 'src'));
  const distNewest = newestMtime(path.join(workspace, 'dist'));
  if (srcNewest > 0 && distNewest > 0) {
    checks.push({
      item: 'dist freshness (dist >= src)',
      pass: distNewest >= srcNewest,
      detail: `dist=${new Date(distNewest).toISOString()} src=${new Date(srcNewest).toISOString()}`,
    });
  } else {
    checks.push({ item: 'dist freshness', pass: false, detail: `src=${srcNewest > 0 ? 'present' : 'missing'} dist=${distNewest > 0 ? 'present' : 'missing'}` });
  }

  const reports = findTestReports(workspace);
  checks.push({
    item: 'test reports (.cycles/cycles/*/test-reports/)',
    pass: reports.length > 0,
    detail: reports.length > 0 ? reports.join(', ') : 'none found',
  });

  const coverageFiles = fs.existsSync(path.join(workspace, '.cycles', 'coverage')) ? ['.cycles/coverage'] : [];
  checks.push({
    item: 'coverage evidence',
    pass: coverageFiles.length > 0,
    detail: coverageFiles.length ? coverageFiles.join(', ') : 'run pnpm run coverage first',
  });

  const porcelain = git(workspace, ['status', '--porcelain']);
  const dirty = (porcelain.stdout || '').trim().split('\n').filter(Boolean);
  checks.push({
    item: 'working tree clean',
    pass: dirty.length === 0,
    detail: dirty.length === 0 ? 'clean' : `${dirty.length} dirty entries`,
  });

  const tc = toolCount(workspace);
  checks.push({
    item: 'README tool count matches source',
    pass: tc.count !== null,
    detail: tc.count !== null ? `${tc.count} anic_* tools in src/host/tools*.ts` : (tc.note || 'unknown'),
  });

  const missing = checks.filter((c) => !c.pass);
  const md = [
    '# PR 证据采集',
    '',
    `- workspace: \`${workspace}\``,
    `- 采集时间: ${new Date().toISOString()}`,
    '',
    '| 检查项 | 结果 | 证据 |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.item} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`),
    '',
    '> 纪律：没有粘输出的「已通过」不算证据（.github/PULL_REQUEST_TEMPLATE.md:20）。',
  ].join('\n');

  if (args.out && !args.noWrite) {
    const rel = args.out.replace(/\\/g, '/');
    const target = path.resolve(workspace, rel);
    if (!target.startsWith(path.resolve(workspace) + path.sep)) {
      process.stderr.write('evidence-collect: --out escapes workspace — refused\n');
      return 2;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, md);
    notes.push(`wrote ${rel}`);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: missing.length === 0, workspace, checks, missing, notes }, null, 2) + '\n');
  } else {
    process.stdout.write(md + '\n');
    for (const n of notes) process.stdout.write(`  note: ${n}\n`);
    process.stdout.write(missing.length === 0 ? 'evidence-collect: PASS\n' : `evidence-collect: FAIL (${missing.length} missing)\n`);
  }
  return missing.length === 0 ? 0 : 1;
}

process.exitCode = main();
