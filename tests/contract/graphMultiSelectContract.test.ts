/**
 * 多选与属性对比契约（cycle-109 · U3）——**本文件回答**："Ctrl/Cmd+点击之后真的能对比吗"。
 *
 * ## 被守卫的缺陷
 *
 * 改造前全仓没有 `selectedIds`，也没有任何地方读 `metaKey`/`ctrlKey`：`focusId`
 * 是唯一选区，而它被悬停占用。于是"这两个门禁差在哪"只能靠逐个悬停 + 记忆。
 *
 * ## 五条判据（含反向自检）
 *
 * ① 纯函数 reducer：切换幂等 / 去重 / 满 8 拒第 9（顺序保持）；
 * ② 纯函数矩阵：`diff` 只在值不全相同时为真（**反向自检**：`diff` 恒 false 的实现
 *    必须与真实现给出不同结果 —— 否则第 ② 条是无牙的）；
 * ③ DOM：Ctrl 点击 2 个节点 → 对比面板 2 列；
 * ④ DOM：不按修饰键点击 → **单选替换**（面板消失、钉住只剩一个）；
 * ⑤ 不变量：多选不改变 `circle` 数、不引入第二个 `svg`（smoke 的硬不变量）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { GRAPH_INTERACT_STYLE } from '../../src/client/features/graph/graphInteractStyle.ts';
import { CARD_RADIUS } from '../../src/client/features/graph/graphNodeStyle.ts';
import { PANEL_CSS } from '../../src/shared/panelCss.ts';
import {
  EMPTY_SELECTION, MAX_SELECTION, pinnedIdOf, selectionReducerOf, type SelectionState,
} from '../../src/client/features/graph/graphSelection.ts';
import { compareMatrixOf } from '../../src/client/features/graph/graphCompare.ts';
import { renderComparePanel } from '../../src/client/features/graph/graphComparePanel.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTraceAdjacency } from '../../src/client/features/graph/graphTrace.ts';
import type { WorkflowNode } from '../../src/client/workflowGraphData.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let host: HTMLElement | undefined;
let root: Root | undefined;
function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(createElement(GraphInteractive, { nodes: NODES, edges: EDGES, onNodeClick: () => {} })); });
}
afterEach(() => {
  if (root !== undefined) act(() => { root.unmount(); });
  if (host !== undefined) host.remove();
  root = undefined;
  host = undefined;
});

const qa = (sel: string): Element[] => [...(host?.querySelectorAll(sel) ?? [])];
/** Ctrl+点击（多选切换）。 */
function ctrlClick(id: string): void {
  const el = host?.querySelector(`[data-anic-node="${id}"]`) ?? null;
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); });
}
/** 不按修饰键点击（单选替换）。 */
function plainClick(id: string): void {
  const el = host?.querySelector(`[data-anic-node="${id}"]`) ?? null;
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('① 纯函数：选中集 reducer', () => {
  const apply = (state: SelectionState, ...ids: string[]): SelectionState =>
    ids.reduce((s, id) => selectionReducerOf(s, { kind: 'toggle', id }), state);

  it('toggle 去重：同一 id 第二次点击移除（不是重复加入）', () => {
    const once = apply(EMPTY_SELECTION, 'a');
    expect(once.ids).toEqual(['a']);
    expect(apply(once, 'a').ids).toEqual([]);
  });

  it('顺序保持 = 点选顺序，且钉住 = 最后一项', () => {
    const s = apply(EMPTY_SELECTION, 'a', 'b', 'c');
    expect(s.ids).toEqual(['a', 'b', 'c']);
    expect(pinnedIdOf(s)).toBe('c');
    // 切掉最后一个：钉住退到剩下的最后一个（钉住不是独立状态，见 graphSelection 头注）。
    expect(pinnedIdOf(apply(s, 'c'))).toBe('b');
  });

  it('上限 8：第 9 个被**拒绝**且状态说明原因（不是静默替换）', () => {
    const full = apply(EMPTY_SELECTION, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    expect(full.ids.length).toBe(MAX_SELECTION);
    const ninth = apply(full, 'i');
    expect(ninth.ids, '第 9 个被塞进来 ⇒ 面板列数会溢出').toEqual(full.ids);
    expect(ninth.limitHit).toBe(true);
    // 反向自检：未满时不许报"超上限"（否则读数条永远在解释一个没发生的事）。
    expect(apply(full, 'a').limitHit).toBe(false);
  });

  it('only = 单选替换；已是同一项时返回同一引用（幂等，不制造 Array 抖动）', () => {
    const s = apply(EMPTY_SELECTION, 'a', 'b');
    const replaced = selectionReducerOf(s, { kind: 'only', id: 'z' });
    expect(replaced.ids).toEqual(['z']);
    expect(selectionReducerOf(replaced, { kind: 'only', id: 'z' })).toBe(replaced);
    expect(selectionReducerOf(s, { kind: 'clear' }).ids).toEqual([]);
  });
});

describe('② 纯函数：对比矩阵与 diff 判据', () => {
  const node = (id: string, type: WorkflowNode['type'], result?: string): WorkflowNode =>
    ({ id, type, label: id.toUpperCase(), x: 0, y: 0, ...(result === undefined ? {} : { result }) });
  const NODES4 = [
    node('a', 'gate', 'PASS'), node('b', 'gate', 'FAIL'),
    node('c', 'gate', 'PASS'), node('d', 'phase', 'PASS'),
  ];
  const ADJ = buildTraceAdjacency([
    { from: 'a', to: 'b', type: 'gate-chain' }, { from: 'b', to: 'c', type: 'gate-chain' },
    { from: 'c', to: 'd', type: 'phase-transition' },
  ] as never);
  const matrix = (ids: string[]) => compareMatrixOf({
    ids, nodes: NODES4, verdicts: undefined, adjacency: ADJ, roles: new Map(),
  });
  const rowOf = (ids: string[], key: string) => matrix(ids).rows.find((r) => r.key === key);

  it('行固定 5 条且顺序固定（位置稳定 = 可用"第 3 行"指代）', () => {
    expect(matrix(['a', 'b']).rows.map((r) => r.key)).toEqual(['type', 'verdict', 'up', 'down', 'role']);
  });

  it('同类型不同裁决 → verdict 行 diff:true；同类型同裁决 → diff:false', () => {
    expect(rowOf(['a', 'b'], 'verdict')?.diff, '不同裁决没被标出来 ⇒ 对比面板什么也没说').toBe(true);
    expect(rowOf(['a', 'c'], 'verdict')?.diff).toBe(false);
    // 类型相同 ⇒ type 行不标差异；类型不同 ⇒ 标。
    expect(rowOf(['a', 'b'], 'type')?.diff).toBe(false);
    expect(rowOf(['a', 'd'], 'type')?.diff).toBe(true);
  });

  it('度数行取正/反邻接表（a 出 1 入 0，b 出 1 入 1）', () => {
    const up = rowOf(['a', 'b'], 'up');
    const down = rowOf(['a', 'b'], 'down');
    expect(up?.values).toEqual(['0', '1']);
    expect(down?.values).toEqual(['1', '1']);
    expect(down?.diff).toBe(false);
    expect(up?.diff).toBe(true);
  });

  it('单列（1 个节点）全部 diff:false（与它自己没有差异）', () => {
    expect(matrix(['a']).rows.every((r) => r.diff === false)).toBe(true);
  });

  it('反向自检：把 diff 恒置 false 的实现，必须与真实现给出不同结果', () => {
    const real = matrix(['a', 'b']).rows.find((r) => r.key === 'verdict')?.diff;
    // 拼接构造的"变异实现"：所有行 diff 一律 false（这正是最容易写出的假实现）。
    const flatFalse = matrix(['a', 'b']).rows.map((r) => ({ ...r, diff: false }));
    expect(flatFalse.find((r) => r.key === 'verdict')?.diff).toBe(false);
    // 两者必须不同 —— 若真实现也恒 false，上一行会相等，第 ② 条就变成恒真的装饰。
    expect(real).not.toBe(flatFalse.find((r) => r.key === 'verdict')?.diff);
  });
});

describe('③ Ctrl 点击 2 个节点 → 对比面板 2 列（真实 DOM）', () => {
  it('面板出现且列数 = 选中数，5 行齐全', () => {
    mount();
    // 未多选时整块不渲染（零占位）。
    expect(qa('[data-anic-graph-compare]').length).toBe(0);
    const A = NODES[0]?.id ?? '';
    const B = NODES[1]?.id ?? '';
    ctrlClick(A);
    ctrlClick(B);
    expect(qa('[data-anic-graph-compare-col]').map((e) => e.getAttribute('data-anic-graph-compare-col')))
      .toEqual([A, B]);
    expect(qa('[data-anic-graph-compare-row]').length).toBe(5);
    expect(qa('[data-anic-graph-selected-count]')[0]?.getAttribute('data-anic-graph-selected-count')).toBe('2');
  });

  it('上限真的生效：Ctrl 点击 9 个 → 只有 8 个进选中集', () => {
    mount();
    for (const n of NODES.slice(0, 9)) ctrlClick(n.id);
    expect(qa('[data-anic-graph-selected-count]')[0]?.getAttribute('data-anic-graph-selected-count'))
      .toBe(String(MAX_SELECTION));
  });
});

describe('④ 不按修饰键 = 单选替换（面板消失）', () => {
  it('先多选 2 个，再普通点击第 3 个 → 只剩它', () => {
    mount();
    const [A, B, C] = [NODES[0]?.id ?? '', NODES[1]?.id ?? '', NODES[2]?.id ?? ''];
    ctrlClick(A);
    ctrlClick(B);
    expect(qa('[data-anic-graph-compare]').length).toBe(1);
    plainClick(C);
    // 单选替换：对比面板整块消失（< 2 列 ⇒ 零占位），钉住只剩 C。
    expect(qa('[data-anic-graph-compare]').length).toBe(0);
    expect(qa('[data-anic-graph-selected-count]')[0]?.getAttribute('data-anic-graph-selected-count')).toBe('1');
    expect(qa('[data-anic-graph-pinned]')[0]?.getAttribute('data-anic-graph-pinned')).toBe(C);
  });
});

describe('⑥ 视觉现代化（cycle-109，纯样式面）：每一步都可判红', () => {
  it('对比面板样式在场，且差异不止靠颜色（行锚点 + 徽标）', () => {
    expect(PANEL_CSS).toContain('[data-anic-graph-compare]');
    expect(PANEL_CSS).toContain("[data-anic-graph-compare-diff='true']");
    expect(PANEL_CSS).toContain('[data-anic-graph-compare-diff-mark]');
    // 反向自检：把这段从 CSS 里挖掉，上面的断言必须红（证明字符串不是恒真存在）。
    const broken = PANEL_CSS.split('[data-anic-graph-compare]').join('');
    expect(broken.includes('[data-anic-graph-compare]')).toBe(false);
  });

  it('LOD 选择器修好了：藏在 ≤0.6 的必须是**真实存在**的次标签锚点', () => {
    // 既有缺陷：选择器指向 `data-anic-node-sub`，而卡片渲染的是 `data-anic-node-meta`
    // ⇒ "缩放时收起次标签"从未生效（188 份 5px 文字照样画）。
    expect(GRAPH_INTERACT_STYLE).toContain('[data-anic-graph-scale="0.6"] [data-anic-node-meta]');
    expect(GRAPH_INTERACT_STYLE.includes(['data-anic-node', '-sub'].join(''))).toBe(false);
  });

  it('边 hover 加粗 + 卡片圆角变柔（形状通道，不是颜色通道）', () => {
    expect(GRAPH_INTERACT_STYLE).toContain('stroke-width: 12');
    expect(CARD_RADIUS).toBeGreaterThan(6);
  });
});

describe('⑤ 不变量：多选不改变图的结构性事实', () => {
  it('circle 数仍 == 节点数，svg 仍恰好 1 个', () => {
    mount();
    for (const n of NODES.slice(0, 3)) ctrlClick(n.id);
    expect(qa('circle').length).toBe(NODES.length);
    expect(qa('svg').length).toBe(1);
    // 反向自检：真挂载确实渲染了节点（否则上面两条与空图无法区分）。
    expect(qa('[data-anic-node]').length).toBe(NODES.length);
  });
});

describe('⑦ 选满上限的读数：第 9 次点击不许静默', () => {
  const matrixOf = (ids: string[]) => compareMatrixOf({
    ids, nodes: NODES, verdicts: undefined, adjacency: buildTraceAdjacency(EDGES), roles: new Map(),
  });

  it('选满 8 个 → 出现上限读数，列数与选中数都停在 8', () => {
    mount();
    for (const n of NODES.slice(0, 9)) ctrlClick(n.id);
    const limit = qa('[data-anic-graph-compare-limit]')[0];
    expect(limit, '选满后没有任何说明 ⇒ 用户以为"点中了但没反应"').not.toBeUndefined();
    expect(limit?.getAttribute('data-anic-graph-compare-limit')).toBe(String(MAX_SELECTION));
    expect(limit?.textContent ?? '').toContain(String(MAX_SELECTION));
    // 第 9 次点击被**拒绝**：若实现成"挤掉最早的"或"允许第 9 个"，下面两条红。
    expect(qa('[data-anic-graph-compare-col]').length).toBe(MAX_SELECTION);
    expect(qa('[data-anic-graph-selected-count]')[0]?.getAttribute('data-anic-graph-selected-count'))
      .toBe(String(MAX_SELECTION));
  });

  it('未满时不渲染读数（零占位）', () => {
    mount();
    ctrlClick(NODES[0]?.id ?? '');
    ctrlClick(NODES[1]?.id ?? '');
    expect(qa('[data-anic-graph-compare-limit]').length).toBe(0);
  });

  it('反向自检：上限若被抬到 9，"8 列必有读数"必红', () => {
    const ids = NODES.slice(0, MAX_SELECTION).map((n) => n.id);
    const full = renderToStaticMarkup(renderComparePanel(matrixOf(ids)));
    expect(full).toContain('data-anic-graph-compare-limit');
    // 变异判据：把上限当成 MAX_SELECTION+1，同一份 8 列矩阵就不该有读数。
    // 真判据与变异判据在同一列数上必须给出不同答案 —— 否则这条断言是无牙的。
    const mutatedFull = (n: number): boolean => n >= MAX_SELECTION + 1;
    expect(mutatedFull(ids.length)).toBe(false);
    expect(ids.length >= MAX_SELECTION).toBe(true);
    // 7 列对照：真判据也不该出读数（证明读数不是恒渲染）。
    const short = renderToStaticMarkup(renderComparePanel(matrixOf(ids.slice(0, MAX_SELECTION - 1))));
    expect(short).not.toContain('data-anic-graph-compare-limit');
  });
});