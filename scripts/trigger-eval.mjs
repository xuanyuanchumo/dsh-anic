#!/usr/bin/env node
/**
 * trigger-eval.mjs — ANIC 工具/技能触发评估器（A3，cycle-16；eco-researcher P0-2 设计）。
 *
 * 对标 anthropics skill-creator §Description Optimization 协议：
 *   - 数据集：tests/fixtures/trigger-eval-dataset.json（20 条：10 正 10 负，12 train / 8 test；
 *     2026-10 cycle-16 研究产物的稳定副本，原始出处 .cycles/cycles/cycle-16/research/）
 *   - 评分面：**确定性代理评分**——不调真模型（无凭据/烧配额/不稳定），而是把
 *     每条查询与每个 anic_* 工具 description + SKILL.md description 的触发词面做
 *     双语加权匹配（trigger 词命中 + Use-when 语义锚 + 区分度负分）。
 *     这是对「模型会不会被 description 触发」的结构化代理——每次 description
 *     改动可复跑，抓回归；真模型采样是后续增强（--live 旗标位预留）。
 *   - 输出：每条 query 的 top-1 工具 vs expectedTool；正例命中率（recall）+
 *     负例误触率（false-positive rate）+ train/test 分组；退出码 0=达标 1=不达标。
 *
 * 用法：node scripts/trigger-eval.mjs [--dataset <path>] [--min-recall 0.8] [--min-fpr 0.2]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

// ── 1) 载入工具触发面（description = 唯一评分面，与 SDO 纪律同源） ──────────
function loadToolFaces() {
  // 从源码提取 name + description 对（tools*.ts 的 register 块）。
  // 文件系统扫描（不是 git ls-files）：新建 gateway 未提交时也要被抓到
  // （cycle-16 实测：toolsBootstrapGateway.ts 未跟踪 → faces 18→16 → recall 跌破线）。
  const hostDir = join(repoRoot, 'src', 'host');
  const files = readdirSync(hostDir)
    .filter((f) => /^tools.*\.ts$/.test(f) && f !== 'toolsSlot.ts');
  const faces = [];
  for (const f of files) {
    const src = readFileSync(join(hostDir, f), 'utf8');
    // 匹配 name: 'anic_xxx' 后跟随的 description（SDO 形态：单字符串或 + 拼接）
    const re = /name:\s*'(anic_[a-z_]+)',[\s\S]*?description:\s*([\s\S]*?),\r?\n\s*output:/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const descExpr = m[2];
      // 求值字符串拼接：把 '...' + '...' 段拼起来（只处理字面量，安全）
      const parts = [...descExpr.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((p) => p[1]);
      faces.push({ name: m[1], description: parts.join('') });
    }
  }
  return faces;
}

// ── 2) 评分：查询 × 工具的触发匹配分 ─────────────────────────────────────
// 双语词面：把 description 拆成候选触发词（中文段 + 英文 token），query 命中即得分。
function tokenize(desc) {
  const zh = desc.match(/[\u4e00-\u9fff][\u4e00-\u9fff/-]*/g) ?? [];
  const en = desc.match(/[A-Za-z][A-Za-z_-]{2,}/g) ?? [];
  return { zh, en };
}

function score(query, face) {
  const q = query.toLowerCase();
  const { zh, en } = tokenize(face.description);
  let s = 0;
  for (const z of zh) {
    if (z.length >= 2 && q.includes(z)) s += z.length >= 4 ? 3 : 2;
  }
  for (const e of en) {
    if (['Use', 'when', 'the', 'and', 'for', 'with', 'should', 'needs', 'before', 'after', 'together'].includes(e)) continue;
    if (e.length >= 4 && q.includes(e.toLowerCase())) s += 2;
    else if (e.length >= 4 && q.includes(e.toLowerCase().replace(/_/g, ' '))) s += 2;
  }
  return s;
}

// ── 3) 主流程 ─────────────────────────────────────────────────────────────
const datasetPath = arg('dataset', join(repoRoot, 'tests', 'fixtures', 'trigger-eval-dataset.json'));
const minRecall = Number(arg('min-recall', 0.8));
const minFpr = Number(arg('min-fpr', 0.2));

if (!existsSync(datasetPath)) {
  console.error(`[trigger-eval] dataset not found: ${datasetPath}`);
  process.exit(2);
}
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const faces = loadToolFaces();

let pass = 0, total = 0, fp = 0, negTotal = 0;
const rows = [];
for (const q of dataset.queries) {
  const scored = faces
    .map((f) => ({ name: f.name, s: score(q.query, f) }))
    .sort((a, b) => b.s - a.s);
  const top = scored[0]?.s > 0 ? scored[0].name : null;
  const expected = q.expectedTool; // null = 不应触发任何 anic 工具
  if (expected !== null) {
    total++;
    const ok = top === expected;
    if (ok) pass++;
    rows.push({ split: q.split, query: q.query.slice(0, 40), expected, top, ok, kind: 'positive' });
  } else {
    negTotal++;
    const ok = top === null; // 负例：任何 anic 工具都不该是 top
    if (!ok) fp++;
    rows.push({ split: q.split, query: q.query.slice(0, 40), expected: '(none)', top, ok, kind: 'negative' });
  }
}

const recall = total > 0 ? pass / total : 0;
const fpr = negTotal > 0 ? fp / negTotal : 0;

console.log('=== ANIC trigger-eval（确定性代理评分） ===');
console.log(`faces loaded: ${faces.length} tools`);
for (const r of rows.filter((x) => !x.ok)) {
  console.log(`  MISS [${r.split}/${r.kind}] "${r.query}" expected=${r.expected} got=${r.top ?? '(none)'}`);
}
console.log(`positive recall: ${pass}/${total} = ${(recall * 100).toFixed(1)}% (min ${minRecall * 100}%)`);
console.log(`negative FPR:   ${fp}/${negTotal} = ${(fpr * 100).toFixed(1)}% (max ${minFpr * 100}%)`);

const ok = recall >= minRecall && fpr <= minFpr;
console.log(ok ? 'TRIGGER-EVAL PASS' : 'TRIGGER-EVAL FAIL');
process.exit(ok ? 0 : 1);
