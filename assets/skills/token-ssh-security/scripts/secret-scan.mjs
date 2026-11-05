#!/usr/bin/env node
// secret-scan.mjs — 硬编码令牌/私钥扫描（只读、确定性、零依赖）
//
// 用法: node secret-scan.mjs <project-dir> [--rules <comma,list>]
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。
//       只读，不写盘，不联网，不执行任何命令。
//
// 安全承诺：命中只输出「文件:行号 + 规则名」，**绝不输出令牌值**。
//   因此本脚本可以安全地贴进 CI 日志或 PR，不会二次泄露。
//
// 退出码: 0 = 无命中；1 = 有命中；2 = 用法/输入错误。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const USAGE = [
  'Usage: node secret-scan.mjs <project-dir> [--rules <comma,list>]',
  'Scans for hardcoded tokens / private keys. Reports location only, never the value.',
].join('\n');

function fail(message) {
  console.error(`[secret-scan] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const rawArgs = process.argv.slice(2);
const rulesFlagIdx = rawArgs.indexOf('--rules');
let rulesValue = '';
if (rulesFlagIdx !== -1) {
  if (rulesFlagIdx === rawArgs.length - 1) fail('--rules 需要一个值');
  rulesValue = rawArgs[rulesFlagIdx + 1];
  rawArgs.splice(rulesFlagIdx, 2);
}
if (rawArgs.some((a) => a.startsWith('--'))) fail(`未知旗标: ${rawArgs.filter((a) => a.startsWith('--')).join(' ')}`);
if (rawArgs.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${rawArgs.length} 个`);

const projectDir = resolve(rawArgs[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

/** 规则表：name → 正则。命中只报 name，不报匹配文本。 */
const RULES = [
  ['github-pat-classic', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['github-pat-fine', /github_pat_[A-Za-z0-9_]{22,}/],
  ['npm-token', /npm_[A-Za-z0-9]{36,}/],
  ['gitlab-token', /glpat-[A-Za-z0-9_-]{20,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['private-key-header', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
];

const selected = new Set(
  rulesValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const rules = selected.size > 0 ? RULES.filter((r) => selected.has(r[0])) : RULES;
if (rules.length === 0) fail(`--rules 未匹配任何规则，可选: ${RULES.map((r) => r[0]).join(', ')}`);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'artifacts', '.cycles', '.dsh', '.agents',
  'coverage', 'test-results', '.preview', '.codegraph-visualizer',
]);
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml',
  '.md', '.txt', '.sh', '.ps1', '.cmd', '.bat', '.env',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const hits = [];

function scanFile(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return; // 二进制 / 权限问题：跳过，不猜
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 明显是文档说明的行跳过（减少误报）
    if (/(token|secret|password|凭据|令牌|密钥)\s*[:=]\s*['"]?\s*(x+|•+|<|\$\{|placeholder|example)/i.test(line)) {
      continue;
    }
    for (const [name, re] of rules) {
      if (re.test(line)) {
        hits.push({ file, line: i + 1, rule: name });
        break; // 每行只报一条，避免刷屏
      }
    }
  }
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.github') continue; // .github 需要扫描模板
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      walk(full);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
    if (!SCAN_EXT.has(ext)) continue;
    scanFile(full);
  }
}

walk(projectDir);

if (hits.length === 0) {
  console.log(`[secret-scan] OK — 扫描 ${relative(process.cwd(), projectDir) || '.'} 无命中（${rules.length} 条规则）`);
  process.exit(0);
}

console.error(`[secret-scan] 发现 ${hits.length} 处疑似敏感信息（只报位置，不报值）:`);
for (const hit of hits) {
  const rel = relative(projectDir, hit.file).split(sep).join('/');
  console.error(`  ${rel}:${hit.line}  [${hit.rule}]`);
}
console.error('处置：吊销/轮换真实凭据 → 删除该行 → 重跑扫描；误报则在本行标注 false-positive。');
process.exit(1);
