#!/usr/bin/env node
// admission-table-check.mjs — Superagent 准入表结构校验（只读、确定性、零依赖）
//
// 用法: node admission-table-check.mjs <project-dir> [--table <markdown-path>]
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。只读，不写盘。
//       --table 缺省时校验本技能自带的 references/operations.md。
//
// 准入表契约（研究报告 §3 L51-52）：
//   - 行 = 接收 scope；每行最多三格（在名单未点名 / 不在名单但点名 / 不在名单未点名）
//   - 默认 inferred / ignore / ignore
//   - CI 无发送者只有最后一格
//   - 未点名格只在该 scope 接收全部消息时可用
//
// 校验项：
//   ① 表头含 Scope + 在名单未点名，且为 4 列
//   ② 每个数据行恰好 4 格，scope 非空
//   ③ 单元格取值合法（inferred/ignore/explicit/not admitted，或含 — 的「无发送者」标记）
//   ④ 至少一行是默认值 inferred/ignore/ignore
//   ⑤ 含 CI 的行前两格必须是「无发送者」标记
//
// 退出码: 0 = 通过；1 = 违规；2 = 用法/输入错误。
//
// ⚠️ 本脚本校验的是 Superagent 准入表的**结构**（来自研究报告），不是 dsh-anic 本地源码。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const USAGE = [
  'Usage: node admission-table-check.mjs <project-dir> [--table <markdown-path>]',
  'Validates the Superagent admission table structure.',
].join('\n');

function fail(message) {
  console.error(`[admission-table-check] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const rawArgs = process.argv.slice(2);
const positionals = [];
let tablePath = null;

for (let i = 0; i < rawArgs.length; i += 1) {
  const tok = rawArgs[i];
  if (tok === '--table') {
    const v = rawArgs[++i];
    if (v === undefined) fail('--table 需要一个值');
    tablePath = v;
  } else if (tok.startsWith('--')) {
    fail(`未知旗标: ${tok}`);
  } else {
    positionals.push(tok);
  }
}

if (positionals.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${positionals.length} 个`);

const projectDir = resolve(positionals[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

const scriptDir = dirname(resolve(process.argv[1] ?? ''));
const target = tablePath ? resolve(tablePath) : join(scriptDir, '..', 'references', 'operations.md');
if (!existsSync(target)) fail(`准入表文件不存在: ${target}`);

const findings = [];

/** 把一行拆成单元格（去掉首尾竖线）。 */
function cellsOf(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

/** 是否是分隔行（|---|---|）。 */
function isSeparator(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

/** 解析文档里所有 markdown 表格，返回 { header, rows }。 */
function parseTables(src) {
  const tables = [];
  const lines = src.split(/\r?\n/);
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    const all = block.map(cellsOf);
    const header = all[0] ?? [];
    const rows = all.slice(1).filter((cells) => !isSeparator(cells));
    tables.push({ header, rows, raw: block });
    block = [];
  };
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      block.push(line);
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

/** 「无发送者」标记（CI 行前两格）。 */
function isNoSender(cell) {
  return /—|无发送者/.test(cell);
}

/** 单元格取值是否合法。 */
function isValidCell(cell) {
  if (isNoSender(cell)) return true;
  if (/仅此格可用/.test(cell)) return true;
  return /^(inferred|ignore|explicit|not admitted)$/i.test(cell);
}

const tables = parseTables(readFileSync(target, 'utf8'));
const admission = tables.find(
  (t) => t.header.includes('Scope') && t.header.some((c) => c.includes('在名单未点名')),
);

if (!admission) {
  findings.push(`未在 ${target} 中找到准入表（表头需含 Scope 与 在名单未点名）`);
} else {
  if (admission.header.length !== 4) {
    findings.push(`准入表表头不是 4 列（实际 ${admission.header.length} 列）`);
  }
  if (admission.rows.length === 0) {
    findings.push('准入表没有数据行');
  }
  let hasDefault = false;
  for (const row of admission.rows) {
    if (row.length !== 4) {
      findings.push(`行「${row[0] ?? '(空)'}」不是 4 格（实际 ${row.length} 格）`);
      continue;
    }
    const scope = row[0];
    if (!scope) findings.push('存在 scope 为空的行');
    for (let i = 1; i < row.length; i += 1) {
      if (!isValidCell(row[i])) {
        findings.push(`行「${scope}」第 ${i} 格取值非法: ${row[i]}`);
      }
    }
    if (/^inferred$/i.test(row[1]) && /^ignore$/i.test(row[2]) && /^ignore$/i.test(row[3])) {
      hasDefault = true;
    }
    if (/CI/i.test(scope) && (!isNoSender(row[1]) || !isNoSender(row[2]))) {
      findings.push(`CI 行「${scope}」前两格必须是「无发送者」标记（实际: ${row[1]} / ${row[2]}）`);
    }
  }
  if (!hasDefault) {
    findings.push('准入表缺少默认值行 inferred / ignore / ignore');
  }
}

if (findings.length === 0) {
  console.log(`[admission-table-check] OK — 准入表结构合规（${target}）`);
  process.exit(0);
}

console.error(`[admission-table-check] 发现 ${findings.length} 项违规:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
