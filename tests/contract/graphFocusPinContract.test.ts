/**
 * 选区钉住契约（cycle-109 · U1）——**本文件回答**："选中能不能持续"。
 *
 * ## 被守卫的缺陷（改造前的真实可用性问题）
 *
 * 全图只有一条选区通道 `focusId`，且被**悬停**独占：`pointerout` 无条件清空。
 * 于是"点一下把它钉住、再去点工具栏"在物理上做不到——鼠标一移开，影响半径读数
 * 与"缩放到选中"的可用性一起消失（用户只有一根指针）。
 *
 * ## 五条判据（含反向自检）
 *
 * ① 纯函数表驱动：钉住优先于悬停，预览只看悬停；
 * ② `pointerover` 仍然让影响半径条出现（既有能力不退）；
 * ③ `click` 之后 `pointerout` → 读数条**仍在**且 `blast-for` 还是被点的那个（新增能力）；
 * ④ **反向自检**：钉住 a 之后悬停 b，高亮必须仍是 a（若优先级写反，这条红）；
 * ⑤ **不回退守卫**：预览卡仍随 `pointerout` 消失（钉住绝不能并进预览）——
 *    否则一张永久悬浮的卡会盖住它下面的图。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { resolveSelectionOf } from '../../src/client/features/graph/graphFocusResolve.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;
/** 两个真实节点：第一个被"钉住"，第二个被"悬停"（两者的读数必须不同源）。 */
const A = NODES[0]?.id ?? '';
const B = NODES[1]?.id ?? '';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let host: HTMLElement | undefined;
let root: Root | undefined;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // 真实装配形态：面板总是传 onNodeClick（节点才会拿到 role=button 与点击通道）。
  act(() => { root.render(createElement(GraphInteractive, { nodes: NODES, edges: EDGES, onNodeClick: () => {} })); });
}
afterEach(() => {
  if (root !== undefined) act(() => { root.unmount(); });
  if (host !== undefined) host.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

const q = (sel: string): Element | null => host?.querySelector(sel) ?? null;
const node = (id: string): Element | null => q(`[data-anic-node="${id}"]`);
const pointer = (el: Element | null, type: string): void => {
  act(() => { el?.dispatchEvent(new PointerEvent(type, { bubbles: true })); });
};
const click = (el: Element | null): void => {
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};
/** 揭示预览：组件有 120ms 防误触延迟，jsdom 不自动跑计时器（与 graphVisualUpgrade 同口径）。 */
const reveal = (): void => { act(() => { vi.advanceTimersByTime(200); }); };

describe('① 纯函数：两条通道的优先级（表驱动）', () => {
  it('钉住优先于悬停；预览只看悬停', () => {
    expect(resolveSelectionOf({ pinnedId: null, hoverId: 'a' }))
      .toEqual({ highlightFocusId: 'a', tooltipFocusId: 'a' });
    // 只有钉住：高亮有，预览**没有**（指针已不在图上）。
    expect(resolveSelectionOf({ pinnedId: 'a', hoverId: null }))
      .toEqual({ highlightFocusId: 'a', tooltipFocusId: null });
    // 两者都有：高亮归钉住，预览归悬停。
    expect(resolveSelectionOf({ pinnedId: 'a', hoverId: 'b' }))
      .toEqual({ highlightFocusId: 'a', tooltipFocusId: 'b' });
    expect(resolveSelectionOf({ pinnedId: null, hoverId: null }))
      .toEqual({ highlightFocusId: null, tooltipFocusId: null });
  });

  it('反向自检：优先级写反（hover ?? pinned）必须给出不同的答案', () => {
    // 拼接构造（扫描器看不见字面量，也不会误伤本文件自身的断言）。
    const wrong = (i: { pinnedId: string | null; hoverId: string | null }): { highlightFocusId: string | null } =>
      ({ highlightFocusId: i.hoverId ?? i.pinnedId });
    expect(wrong({ pinnedId: 'a', hoverId: 'b' }).highlightFocusId).toBe('b');
    expect(resolveSelectionOf({ pinnedId: 'a', hoverId: 'b' }).highlightFocusId).toBe('a');
  });
});

describe('② 悬停通道不退（pointerover 仍出读数条）', () => {
  it('pointerover 节点 → 影响半径条出现，且 blast-for = 该节点', () => {
    mount();
    expect(A).not.toBe('');
    pointer(node(A), 'pointerover');
    expect(q('[data-anic-graph-blast]')?.getAttribute('data-anic-graph-blast-for')).toBe(A);
  });
});

describe('③ 钉住通道（新增能力）：点击后移开指针，读数仍在', () => {
  it('click a → pointerout → 读数条仍在且 blast-for 仍是 a', () => {
    mount();
    click(node(A));
    // 钉住态进 DOM（集合级锚点在舞台里，见 graphStage 注释）。
    expect(q('[data-anic-graph-pinned]')?.getAttribute('data-anic-graph-pinned')).toBe(A);
    pointer(node(A), 'pointerout');
    const bar = q('[data-anic-graph-blast]');
    expect(bar, '点了之后移开指针，读数条消失 ⇒ 选区根本没钉住').not.toBeNull();
    expect(bar?.getAttribute('data-anic-graph-blast-for')).toBe(A);
  });

  it('Escape 撤掉钉住（读数条消失，锚点回到 none）', () => {
    mount();
    click(node(A));
    expect(q('[data-anic-graph-blast]')).not.toBeNull();
    const svg = q('svg[data-anic-graph]');
    act(() => { svg?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(q('[data-anic-graph-pinned]')?.getAttribute('data-anic-graph-pinned')).toBe('none');
    expect(q('[data-anic-graph-blast]')).toBeNull();
  });
});

describe('④ 反向自检：钉住 a 之后悬停 b，高亮必须仍是 a', () => {
  it('钉住优先（写反成 hover ?? pinned 时这条红）', () => {
    vi.useFakeTimers();
    mount();
    click(node(A));
    pointer(node(B), 'pointerover');
    reveal();
    // 两条通道此刻**各答各的**：高亮归钉住 a，预览归悬停 b。
    // 若优先级写反：读数条会变成 b —— 用户在 a 上钉住，鼠标扫过 b 就"改主意"了。
    expect(q('[data-anic-graph-blast]')?.getAttribute('data-anic-graph-blast-for')).toBe(A);
    expect(q('[data-anic-graph-tooltip]')?.getAttribute('data-anic-graph-tooltip')).toBe(B);
  });
});

describe('⑤ 不回退守卫：预览卡仍随 pointerout 消失（钉住不并进预览）', () => {
  it('钉住 a 后 pointerover a → 预览出现；pointerout → 预览消失，读数仍在', () => {
    vi.useFakeTimers();
    mount();
    click(node(A));
    pointer(node(A), 'pointerover');
    reveal();
    expect(q('[data-anic-graph-tooltip]'), '预览卡在钉住态没出现 ⇒ 悬停通道被钉住吞了').not.toBeNull();
    pointer(node(A), 'pointerout');
    expect(q('[data-anic-graph-tooltip]'), '预览跟着钉住存活 ⇒ 一张永久悬浮的卡会盖住图').toBeNull();
    // 而影响半径（回答"我在看谁"）必须还在——两条通道的分工正是本契约的全部意义。
    expect(q('[data-anic-graph-blast]')?.getAttribute('data-anic-graph-blast-for')).toBe(A);
  });
});