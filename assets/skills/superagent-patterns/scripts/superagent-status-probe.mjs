#!/usr/bin/env node
// superagent-status-probe.mjs — 四类退出码归一探针 + stateDir 探测（只读、确定性、零依赖）
//
// 用法: node superagent-status-probe.mjs <project-dir> [--exit <0|1|2|3>] [--state-dir <path>]
// 契约: 第一个位置参数 = 项目目录（绝对或相对）；其余位置参数拒绝。只读，不写盘、不联网。
//
// 四类退出码（研究报告 §8 L214）：
//   0 = 正常；1 = 不运行/运行两次/runtime 报错（重启可能修好）；
//   2 = 运行但某部件报错（重启修不好）；3 = 运行但等 setup。
//
// 校验项：
//   ① --exit 给定的值必须 ∈ {0,1,2,3}
//   ② --state-dir 给定的路径必须存在
//   ③ 未给定 --state-dir 时，从 *.yml/*.patch.yml 里探测 stateDir 声明并报告
//
// 退出码: 0 = 通过；1 = 违规；2 = 用法/输入错误。
//
// ⚠️ 本脚本的退出码语义**不等同于** Superagent 的 `status` 退出码——
//   它只把观测到的退出码归一为四档语义，不建立 SSH/网络连接。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USAGE = [
  'Usage: node superagent-status-probe.mjs <project-dir> [--exit <0|1|2|3>] [--state-dir <path>]',
  'Normalizes a four-tier exit code and probes the stateDir declaration.',
].join('\n');

function fail(message) {
  console.error(`[superagent-status-probe] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const TIERS = {
  0: { label: '正常', action: '静默' },
  1: { label: '不运行 / 运行两次 / runtime 报错', action: '--respect-stop restart（重启可能修好）' },
  2: { label: '运行但某部件报错', action: '只报告 errors，不重启（重启修不好）' },
  3: { label: '运行但等 setup', action: '只报告 setup，不重启' },
};

const rawArgs = process.argv.slice(2);
const positionals = [];
let exitCode = null;
let stateDir = null;

for (let i = 0; i < rawArgs.length; i += 1) {
  const tok = rawArgs[i];
  if (tok === '--exit') {
    const v = rawArgs[++i];
    if (v === undefined) fail('--exit 需要一个值');
    const n = Number(v);
    if (!Number.isInteger(n)) fail(`--exit 需要整数，收到: ${v}`);
    exitCode = n;
  } else if (tok === '--state-dir') {
    const v = rawArgs[++i];
    if (v === undefined) fail('--state-dir 需要一个值');
    stateDir = v;
  } else if (tok.startsWith('--')) {
    fail(`未知旗标: ${tok}`);
  } else {
    positionals.push(tok);
  }
}

if (positionals.length !== 1) fail(`只接受 1 个位置参数（project-dir），收到 ${positionals.length} 个`);

const projectDir = resolve(positionals[0]);
if (!existsSync(projectDir)) fail(`项目目录不存在: ${projectDir}`);

const findings = [];

// ① --exit 归一
if (exitCode !== null) {
  if (!Object.prototype.hasOwnProperty.call(TIERS, exitCode)) {
    findings.push(`退出码 ${exitCode} 不在四类语义内（0/1/2/3）`);
  } else {
    const tier = TIERS[exitCode];
    console.log(`[superagent-status-probe] exit=${exitCode} → ${tier.label}`);
    console.log(`[superagent-status-probe] 处置: ${tier.action}`);
  }
} else {
  console.log('[superagent-status-probe] 四类退出码契约:');
  for (const [code, tier] of Object.entries(TIERS)) {
    console.log(`  ${code} = ${tier.label}（${tier.action}）`);
  }
}

// ② --state-dir
if (stateDir !== null) {
  const full = resolve(stateDir);
  if (!existsSync(full)) {
    findings.push(`--state-dir 路径不存在: ${stateDir}`);
  } else {
    console.log(`[superagent-status-probe] stateDir 存在: ${stateDir}`);
  }
} else {
  // ③ 探测声明
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'artifacts', '.cycles']);
  const found = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (st.isFile() && /\.ya?ml$/i.test(entry)) {
        const text = readFileSync(full, 'utf8');
        if (/^\s*stateDir:\s*\S/m.test(text)) found.push(full);
      }
    }
  }
  walk(projectDir);

  if (found.length === 0) {
    console.log('[superagent-status-probe] 未发现 stateDir 声明（*.yml/*.patch.yml）');
  } else {
    console.log(`[superagent-status-probe] 发现 ${found.length} 处 stateDir 声明:`);
    for (const f of found) console.log(`  ${f}`);
  }
}

if (findings.length === 0) {
  console.log('[superagent-status-probe] OK — 探针通过');
  process.exit(0);
}

console.error(`[superagent-status-probe] 发现 ${findings.length} 项问题:`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
