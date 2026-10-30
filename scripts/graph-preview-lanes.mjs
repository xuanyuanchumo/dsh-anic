#!/usr/bin/env node
/**
 * 泳道表头重叠**自检**（cycle-90）——用**窗口化**快照（产品主视图的真实数据）
 * 检查表头带是否压住卡片。
 *
 * ## 为什么单独一个脚本
 *
 * `scripts/graph-preview-layout.mjs` 验的是**全量**投影（249 节点）。但产品主视图
 * 是**窗口化**的（默认 8 轮 ⇒ 35 节点），两者的 lane 分布完全不同 ——
 * 而"表头压卡片"恰恰是**分布相关**的缺陷：全量下每列有好几段，窗口化下
 * 某些列只有一段，表头的相对位置就变了。
 *
 * 所以两条数据都要验：这个脚本跑**窗口化**（读 artifacts/workflow-snapshot.json）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: `export default ${text};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { layoutGraph } = await import('../src/client/features/graph/graphLayout.ts');

const snap = JSON.parse(readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'));
const nodes = snap.nodes;
const edges = snap.edges;

for (const mode of ['lane', 'compact']) {
  const l = layoutGraph(nodes, edges, { mode });
  const overlaps = [];
  for (const h of l.laneHeaders) {
    for (const n of l.nodes) {
      if (n.column !== h.column) continue;
      const nTop = n.y - n.h / 2;
      const nBot = n.y + n.h / 2;
      if (h.y < nBot && nTop < h.y + h.h) overlaps.push(`${h.type}@c${h.column}[y=${h.y}]×${n.id}[y=${n.y}]`);
    }
  }
  process.stdout.write([
    `mode=${mode} nodes=${nodes.length} cols=${l.columns} headers=${l.laneHeaders.length}`,
    `  overlaps=${overlaps.length}`,
    ...overlaps.slice(0, 6).map((o) => `    ${o}`),
    '',
  ].join('\n'));
}
