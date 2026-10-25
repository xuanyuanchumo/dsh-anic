#!/usr/bin/env node
// gate-ledger.mjs — 哈希链门禁账本：tamper-evident hash-chained ledger
// 用法:
//   记录: node gate-ledger.mjs <project-dir> --gate G0 --result PASS [--detail "..."]
//   验证: node gate-ledger.mjs <project-dir> --verify
//   列表: node gate-ledger.mjs <project-dir> --list
//
// 进化 iteration-1：核心实现抽到 scripts/lib/ledger.mjs（单一事实来源，供
// multi-agent-gate.mjs 的 gatekeeper 复用真实验证，修 S-5）；saveLedger 改原子写（修 S-6）；
// 未知 --gate 由"静默接受"改为响亮失败（修 S-11，原 GATE_NAMES[gate] || gate 会把
// 任意字符串写进账本并假冒 GATE_NAMES）。CLI 输出与 v1.6 逐字节一致。

import { join, resolve } from 'node:path';
import { parseCliArgs } from './lib/args.mjs';
import { appendEntry, readLedger, VALID_GATES, verifyLedger } from './lib/ledger.mjs';

const USAGE = [
  'Usage: node gate-ledger.mjs <project-dir> --gate G0|G1|G2|G3 --result PASS|FAIL [--detail "..."]',
  '       node gate-ledger.mjs <project-dir> --verify',
  '       node gate-ledger.mjs <project-dir> --list',
].join('\n');

const args = parseCliArgs(process.argv, {
  script: 'gate-ledger',
  usage: USAGE,
  flags: {
    gate: { type: 'string' },
    result: { type: 'string' },
    detail: { type: 'string', default: '' },
    verify: { type: 'boolean' },
    list: { type: 'boolean' },
  },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});

const projectDir = resolve(args._[0]);

if (args.verify) {
  const result = verifyLedger(projectDir);
  console.log(`Gate Ledger Verification`);
  // cycle-79 O-04：不可解析/形状不认识时**明确报告不可用**——旧行为在这里把坏形状
  // 输出成「Total entries: 0 / Valid: YES」（fail-open：坏账本看起来全绿）。
  if (result.unavailable) {
    console.log(`  [SKIP] ledger unavailable — ${result.issues[0]?.message ?? 'unknown reason'}`);
    console.error(`Cannot verify: ledger cannot be read. Fix ${join(projectDir, '.cycles', 'gates', 'ledger.json')} (or remove it to start a fresh ledger).`);
    process.exit(1);
  }
  console.log(`  Total entries: ${result.totalEntries}`);
  console.log(`  Valid: ${result.valid ? 'YES' : 'NO'}`);
  if (result.shape === 'array') {
    // 裸数组是合法形状（宿主侧同样接受）：链头由末条 hash 重建，如实披露归一动作
    console.log(`  Note: ledger stored as a bare array — shape normalized; chain head reconstructed from the last entry hash.`);
  }
  if (result.totalEntries === 0 && result.valid) {
    // 修 N-9（v1.8.0）：空账本曾输出裸 "Valid: YES"，无法区分"没记录过"与"未被篡改"。
    console.log(`  Note: ledger is empty — no gate results recorded yet. "Valid" only means no tampering.`);
  }
  if (result.issues.length > 0) {
    console.log(`  Issues (${result.issues.length}):`);
    for (const issue of result.issues) {
      console.log(`    [${issue.type}] ${issue.message}`);
    }
    process.exit(1);
  } else {
    console.log(`  All entries verified. Hash chain intact.`);
  }
} else if (args.list) {
  const ledger = readLedger(projectDir);
  // 同 verify：读不出来就说不可用并响亮退出，绝不打印「No gate entries recorded」
  // 让操作者以为账本是空的（这正是坏形状被静默吞掉的原症状）。
  if (!ledger.ok) {
    console.log(`[SKIP] ledger unavailable — ${ledger.reason}`);
    console.error(`Cannot list gate entries: ledger cannot be read.`);
    process.exit(1);
  }
  if (ledger.shape === 'array') {
    console.log(`Note: ledger stored as a bare array — shape normalized (entries read as-is).`);
  }
  const entries = ledger.entries;
  if (entries.length === 0) {
    console.log('No gate entries recorded.');
  } else {
    console.log(`Gate Ledger (${entries.length} entries):`);
    for (const e of entries) {
      console.log(`  [${e.timestamp}] ${e.gate} ${e.gateName} — ${e.result}`);
      console.log(`    hash: ${e.hash.substring(0, 16)}...`);
      console.log(`    detail: ${e.detail.substring(0, 80)}`);
    }
  }
} else if (args.gate && args.result) {
  if (!VALID_GATES.includes(args.gate)) {
    console.error(`Unknown gate: ${args.gate}. Valid gates: ${VALID_GATES.join(', ')}`);
    process.exit(1);
  }
  // cycle-79 O-04：账本不可读时 appendEntry 会**拒绝写入**（否则整份历史被覆盖）。
  // 这里把它变成一句点名的错误输出，而不是裸栈——写失败必须可读、且绝不静默。
  let entry;
  try {
    entry = appendEntry(projectDir, args.gate, args.result, args.detail);
  } catch (err) {
    console.error(`[gate-ledger] ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`Gate ${args.gate} ${entry.result} recorded.`);
  console.log(`  Hash: ${entry.hash.substring(0, 16)}...`);
  console.log(`  Previous: ${entry.previousHash ? entry.previousHash.substring(0, 16) + '...' : 'GENESIS'}`);
  console.log(`  Timestamp: ${entry.timestamp}`);

  if (entry.result === 'FAIL') {
    console.error(`Gate ${args.gate} FAILED. Must fix issues before proceeding.`);
  }
} else {
  console.error('Must specify --gate and --result, or --verify, or --list');
  process.exit(1);
}
