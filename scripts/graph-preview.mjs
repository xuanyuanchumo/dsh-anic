#!/usr/bin/env node
/**
 * 图谱可视化自证工具（cycle-89 · WP-B）——把 `renderGraph` 渲染成**独立 HTML**。
 *
 * ## 为什么需要它（这是验收通道，不是玩具）
 *
 * 图区的所有既有验收都是**文本断言**：circle 数、data-* 锚点、transform 字符串。
 * 这些能证明"结构对"，但证明不了"看起来能不能读"——卡片挤在一起、标签压到隔壁
 * 列、泳道表头盖住第一张卡，全部**照常全绿**。Lead 做美学验收必须有一张真实
 * 渲染的图可看，否则"改好看了"只能靠人复述。
 *
 * 所以本脚本用**真实 react-dom**（不是 smoke 的桩）把生产渲染函数导出成 HTML，
 * 内联真实 CSS（令牌块 + 面板静态 CSS），双击即可在浏览器打开。
 *
 * ## 数据来源：嵌入快照，不读 .cycles/
 *
 * `WORKFLOW_SNAPSHOT` 是客户端 bundle 里那份**同源**数据（构建期由 .cycles/ 生成），
 * 直接 import 即可——不重新扫描工作区意味着预览与面板看到的完全一致，也不会因为
 * 别的 agent 正在写 .cycles/ 而抖动。
 *
 * ## 一个必须绕过的坑：ESM 里的 JSON import
 *
 * `src/client/i18n.ts` 里是 `import zh from '../../locale/zh.json'`（无 import
 * attributes，打包器能吞，Node 原生 ESM 会抛 ERR_IMPORT_ATTRIBUTE_MISSING）。
 * 本脚本用 `module.registerHooks` 把 .json 当**模块**加载（`export default {..}`），
 * 从而一行不改源码就跑通。这是**脚本侧**的兜底，不是给生产代码开后门。
 *
 * 用法：`node scripts/graph-preview.mjs [--out <file>]`，打印绝对路径。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ① JSON 当模块加载（见文件头第二个坑）。必须在**动态 import 之前**注册。
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: `export default ${text};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { renderGraph } = await import('../src/client/features/graph/renderGraph.ts');
const { renderGraphToolbar } = await import('../src/client/features/graph/graphToolbar.ts');
const { layoutGraph } = await import('../src/client/features/graph/graphLayout.ts');
const { countTypes, countVerdicts, EMPTY_FILTER } = await import('../src/client/features/graph/graphFilter.ts');
const { IDENTITY } = await import('../src/client/features/graph/graphViewport.ts');
const { WORKFLOW_SNAPSHOT } = await import('../src/client/workflowGraphData.ts');
const { PANEL_CSS } = await import('../src/shared/panelCss.ts');
const { tokenCssBlock, THEME_ATTRIBUTE } = await import('../src/shared/tokens.ts');

const React = await import('react');
const Server = await import('react-dom/server');
/** react-dom/server 在 ESM 下是 CJS 互操作对象，命名导出位置随版本浮动。 */
const renderToStaticMarkup = Server.renderToStaticMarkup ?? Server.default?.renderToStaticMarkup;
if (typeof renderToStaticMarkup !== 'function') {
  throw new Error('react-dom/server 未提供 renderToStaticMarkup —— 预览无法渲染（fail-closed）');
}
const { createElement } = React;

const nodes = WORKFLOW_SNAPSHOT.nodes;
const edges = WORKFLOW_SNAPSHOT.edges;
const layout = layoutGraph(nodes, edges);

/**
 * 一屏 HTML 里同时给**两个主题**：美学验收必须两个都看（暗色档曾长期失效，
 * 就是因为只截了浅色图）。同一个 renderGraph 输出挂两份，令牌块按属性切换。
 */
function panel(theme) {
  const graph = renderGraph({ nodes, edges }, undefined, undefined, { layout });
  const toolbar = renderGraphToolbar({
    filter: EMPTY_FILTER,
    typeCounts: countTypes(nodes),
    verdictCounts: countVerdicts(nodes),
    viewport: IDENTITY,
    adjacencyOn: true,
    onQuery: () => {}, onToggleType: () => {}, onToggleVerdict: () => {},
    onAdjacencyToggle: () => {}, onZoomIn: () => {}, onZoomOut: () => {},
    onFit: () => {}, onClear: () => {},
  });
  return `<section class="preview-panel" ${THEME_ATTRIBUTE}="${theme}">
  <h2 class="preview-h2">${theme === 'dark' ? '暗色' : '浅色'} · ${String(nodes.length)} 节点 / ${String(edges.length)} 边</h2>
  ${renderToStaticMarkup(toolbar)}
  ${renderToStaticMarkup(graph)}
</section>`;
}

/** 页面级样式只用令牌变量（与组件同一条颜色纪律，不新造色值）。 */
const PAGE_CSS = `
body { margin: 0; padding: 24px; background: var(--anic-surface); color: var(--anic-text);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.preview-head { margin: 0 0 18px; font-size: 13px; color: var(--anic-text-dim); }
.preview-panel { margin: 0 0 28px; padding: 14px; border: 1px solid var(--anic-border);
  border-radius: 10px; background: var(--anic-surface); overflow-x: auto; }
.preview-panel[${THEME_ATTRIBUTE}='dark'] { background: var(--anic-surface); }
.preview-h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--anic-text-strong); }
`;

const html = `<!doctype html>
<html lang="zh-CN" ${THEME_ATTRIBUTE}="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ANIC 工作流图预览 · cycle-89</title>
<style>
${tokenCssBlock()}
${PANEL_CSS}
${PAGE_CSS}
</style>
</head>
<body>
<p class="preview-head">
  数据：${WORKFLOW_SNAPSHOT.generatedAt} · autonomy ${WORKFLOW_SNAPSHOT.autonomy} ·
  折叠 ${String(WORKFLOW_SNAPSHOT.counts.windowedOut)} · 由 scripts/graph-preview.mjs 生成（真实 react-dom，非桩）
</p>
${panel('light')}
${panel('dark')}
</body>
</html>
`;

const outIdx = process.argv.indexOf('--out');
const outFile = resolve(
  outIdx !== -1 && typeof process.argv[outIdx + 1] === 'string'
    ? process.argv[outIdx + 1]
    : join(ROOT, '.preview', 'graph.html'),
);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html, 'utf8');

// 结构化摘要：Lead 不必打开 HTML 就知道规模（也是"渲染真的产出了东西"的证据）。
process.stdout.write([
  `graph-preview: ${outFile}`,
  `  nodes=${String(nodes.length)} edges=${String(edges.length)}`,
  `  lanes=${String(layout.lanes.length)} columns=${String(layout.columns)}`,
  `  bounds=${String(Math.round(layout.bounds.width))}x${String(Math.round(layout.bounds.height))}`,
  `  html=${String(html.length)} bytes`,
  '',
].join('\n'));
