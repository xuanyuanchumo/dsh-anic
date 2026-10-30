#!/usr/bin/env node
/**
 * 布局模式**实测**探针（cycle-90）——打印两种模式的宽/高/比值/列数。
 *
 * ## 为什么需要它（不是玩具）
 *
 * cycle-89 的血泪教训：`rowsPerColumn` 与 `columnBudgetPx` 同时调小 ⇒ 宽高比
 * 从 2.00 冲到 6.21 ⇒ 两条契约同时红。而那次之所以**没被立刻发现**，是因为
 * 改参数的人只看"图变矮了"，没看"宽高比爆了"。
 *
 * 本探针把两个模式在同一份真实数据（249 节点全量投影）上的几何**打印出来**，
 * 让人在提交前就能看到比值。判据仍是 `LAYOUT_ASPECT_BOUNDS`（唯一来源）。
 *
 * 用法：`node scripts/graph-preview-layout.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ① JSON 当模块加载（与 graph-preview.mjs 同一手法：Node 原生 ESM 需要 import attributes）。
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: `export default ${text};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { layoutGraph, legacyBounds, LAYOUT_ASPECT_BOUNDS } = await import(
  '../src/client/features/graph/graphLayout.ts'
);
const { buildWorkflowSnapshot } = await import('../src/shared/snapshotCore.ts');

const FULL = buildWorkflowSnapshot(join(ROOT, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 'full' });
const legacy = legacyBounds(FULL.nodes);
const rows = [];

for (const mode of ['lane', 'compact']) {
  const l = layoutGraph(FULL.nodes, FULL.edges, { mode });
  const w = Math.round(l.bounds.width);
  const h = Math.round(l.bounds.height);
  const aspect = l.bounds.width / l.bounds.height;
  const heightRatio = l.bounds.height / legacy.height;
  // 单列最大行数（判据三）
  const perCol = new Map();
  for (const n of l.nodes) {
    const list = perCol.get(n.column) ?? [];
    list.push(n);
    perCol.set(n.column, list);
  }
  const maxRows = Math.max(...[...perCol.values()].map((v) => v.length));
  // 表头带 vs 卡片：表头带 [y, y+h] 必须落在该列**所有卡片**的上方或下方，
  // 不能压住任何一张卡片（压住 = "看不清是卡片还是表头"）。
  const headers = l.laneHeaders;
  const headerOverlaps = [];
  for (const h of headers) {
    for (const n of l.nodes) {
      if (n.column !== h.column) continue;
      const nTop = n.y - n.h / 2;
      const nBot = n.y + n.h / 2;
      if (h.y < nBot && nTop < h.y + h.h) headerOverlaps.push(`${h.type}@${h.column}×${n.id}`);
    }
  }
  const ok =
    heightRatio <= 0.6 &&
    aspect >= LAYOUT_ASPECT_BOUNDS.min && aspect <= LAYOUT_ASPECT_BOUNDS.max &&
    maxRows <= 30 &&
    headerOverlaps.length === 0;
  rows.push([
    mode.padEnd(8),
    `w=${String(w).padStart(5)}`,
    `h=${String(h).padStart(5)}`,
    `aspect=${aspect.toFixed(3).padStart(6)}`,
    `cols=${String(l.columns).padStart(3)}`,
    `maxRows=${String(maxRows).padStart(3)}`,
    `h/legacy=${heightRatio.toFixed(4)}`,
    `headers=${String(headers.length).padStart(3)}`,
    `hdrOverlap=${String(headerOverlaps.length).padStart(2)}`,
    ok ? 'PASS' : 'FAIL',
  ].join('  '));
  if (headerOverlaps.length > 0) rows.push(`    !! ${headerOverlaps.slice(0, 5).join(', ')}`);
}

process.stdout.write([
  `nodes=${String(FULL.nodes.length)} edges=${String(FULL.edges.length)} legacyH=${String(Math.round(legacy.height))}`,
  `bounds=aspect∈[${String(LAYOUT_ASPECT_BOUNDS.min)}, ${String(LAYOUT_ASPECT_BOUNDS.max)}]`,
  '',
  ...rows.map((r) => `  ${r}`),
  '',
].join('\n'));
