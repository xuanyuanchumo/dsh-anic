/**
 * 路径模式用户体验契约（cycle-109 · U4）——**本文件回答**："在模式里能不能退、反向通了怎么说"。
 *
 * ## 被守卫的四个缺陷
 *
 * ① `Escape` 退不出路径模式（`clearFilter` 只退时间轴与筛选）⇒ 用户被困在模式里，
 *    而且按 Esc 还顺手清掉了筛选（副作用）——同一键位两个动作只做了一个；
 * ② 正向不通就报"不可达"，而**反向其实通**（因为因果方向反了）⇒ 结论错；
 * ③ 只给一条最短路径，等价路径无从比较；
 * ④ 词表里承诺了"输入两个节点"的文本框（`pathFindPlaceholder`），那个控件不存在。
 *
 * ## 判据（含反向自检）
 *
 * - DOM：进模式 → Esc → 模式 off + 状态条消失 + **筛选同时被清**（两条一起断言，
 *   否则"只清了筛选"的实现也能让其中一条绿）；
 * - 纯函数：`reverseOnly` 与 `unreachable` 两态可分（反向自检：正向单查的实现必红）；
 * - 纯函数：`findPathCandidates` ≤3 条、全部 ≤6 跳、互不相同、`k=1` 与 `findPath` 相等；
 * - 渲染：候选列表只在 ≥2 条时出现（零占位）；反向结果带 `direction=reverse` 锚点；
 * - 词表：`pathFindPlaceholder` 已删、`pathReverseOnly` 两面俱在、`pathFindHint` 被消费。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { buildTraceAdjacency } from '../../src/client/features/graph/graphTrace.ts';
import { pathModelOf, type PathModel } from '../../src/client/features/graph/graphPathMode.ts';
import { findPath, findPathCandidates, MAX_PATH_HOPS, type PathResult } from '../../src/client/features/graph/graphPathFind.ts';
import { pathStatusTextOf, renderPathBar } from '../../src/client/features/graph/graphPathBar.ts';
import { t } from '../../src/client/i18n.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;

/** 一条 3 跳链 a→b→c→d + 孤立节点 z（"两向都不通"的夹具）。 */
const CHAIN = buildTraceAdjacency([
  { from: 'a', to: 'b', type: 'flow' }, { from: 'b', to: 'c', type: 'flow' },
  { from: 'c', to: 'd', type: 'flow' },
] as never);

/** 菱形：A→B→D 与 A→C→D 是两条等价路径（候选列表的夹具）。 */
const DIAMOND = buildTraceAdjacency([
  { from: 'A', to: 'B', type: 'flow' }, { from: 'B', to: 'D', type: 'flow' },
  { from: 'A', to: 'C', type: 'flow' }, { from: 'C', to: 'D', type: 'flow' },
] as never);

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

describe('① DOM：Escape 退得出模式，且既有"清筛选"语义不丢', () => {
  it('进模式 + 勾一个类型 chip → Escape → 模式 off、状态条消失、筛选被清', () => {
    mount();
    const btn = (): Element | null => host?.querySelector('[data-anic-graph-path-mode]') ?? null;
    act(() => { (btn() as HTMLElement | null)?.click(); });
    expect(btn()?.getAttribute('data-anic-graph-path-mode')).toBe('on');
    expect(host?.querySelector('[data-anic-graph-path-bar]')).not.toBeNull();
    // 让筛选处于激活态：否则"筛选被清"这条断言在空筛选上是恒真的。
    act(() => { host?.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]')?.click(); });
    expect(host?.querySelectorAll('[data-anic-graph-chip][data-anic-graph-chip-checked="true"]').length).toBe(1);
    const svg = host?.querySelector('svg[data-anic-graph]') ?? null;
    act(() => { svg?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // 新增能力：模式退出（此前 Esc 只清筛选，用户被困在"点节点=设端点"的语义里）。
    expect(btn()?.getAttribute('data-anic-graph-path-mode')).toBe('off');
    expect(host?.querySelector('[data-anic-graph-path-bar]')).toBeNull();
    // 既有语义不退：同一次 Esc 仍然清筛选（两条一起断言才不互相踩）。
    expect(host?.querySelectorAll('[data-anic-graph-chip][data-anic-graph-chip-checked="true"]').length).toBe(0);
  });
});

describe('② 纯函数：reverseOnly 与 unreachable 两态可分', () => {
  it('正向不通/反向可达 → reverseOnly（路径按用户选的方向给出）', () => {
    const model = pathModelOf({ active: true, from: 'd', to: 'a' }, CHAIN);
    expect(model.status).toBe('reverseOnly');
    expect(model.result?.path).toEqual(['d', 'c', 'b', 'a']);
    expect(model.length).toBe(3);
    expect(model.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('两向都不通 → unreachable（不是 reverseOnly）', () => {
    expect(pathModelOf({ active: true, from: 'z', to: 'a' }, CHAIN).status).toBe('unreachable');
    expect(pathModelOf({ active: true, from: 'a', to: 'z' }, CHAIN).status).toBe('unreachable');
  });

  it('两种状态的**文案**也不同（否则用户读到的还是同一句话）', () => {
    const reverse = pathModelOf({ active: true, from: 'd', to: 'a' }, CHAIN);
    const dead = pathModelOf({ active: true, from: 'a', to: 'z' }, CHAIN);
    expect(pathStatusTextOf(reverse)).not.toBe(pathStatusTextOf(dead));
  });

  it('反向自检：只查正向的实现，会把"反向可达"误报成 unreachable', () => {
    const forwardOnlyStatus = (from: string, to: string): string =>
      (findPath(CHAIN, from, to).found ? 'found' : 'unreachable');
    expect(forwardOnlyStatus('d', 'a')).toBe('unreachable'); // 变异实现给出的错误答案
    expect(pathModelOf({ active: true, from: 'd', to: 'a' }, CHAIN).status).toBe('reverseOnly');
  });
});

describe('③ 纯函数：候选路径', () => {
  it('菱形图给出 2 条互不相同的路径，全部 ≤6 跳', () => {
    const many = findPathCandidates(DIAMOND, 'A', 'D');
    expect(many.length).toBe(2);
    expect(many.length).toBeLessThanOrEqual(3);
    for (const r of many) {
      expect(r.found).toBe(true);
      expect(r.length).toBeLessThanOrEqual(MAX_PATH_HOPS);
      expect(r.path[0]).toBe('A');
      expect(r.path[r.path.length - 1]).toBe('D');
    }
    // 互不相同：不能为了凑条数返回同一条（那正是"只给一条"的假多解）。
    const keys = many.map((r) => r.path.join('>'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('k=1 时与 findPath 逐字段相等（同一条实现，不是第二份 BFS）', () => {
    const one = findPathCandidates(DIAMOND, 'A', 'D', 1);
    expect(one).toEqual([findPath(DIAMOND, 'A', 'D')]);
  });

  it('不可达 → 空数组（不是"一条 found:false"）', () => {
    expect(findPathCandidates(CHAIN, 'z', 'a')).toEqual([]);
  });
});

describe('④ 渲染：候选列表零占位 + 反向结果带方向锚点', () => {
  const result = (path: string[]): PathResult => ({ found: true, path, length: path.length - 1 });
  const modelWith = (candidates: PathResult[], status: PathModel['status']): PathModel => ({
    active: true, from: 'A', to: 'D', status, highlight: new Set(['A', 'B', 'D']),
    length: 2, blast: null, result: candidates[0] ?? null, candidates,
  });

  it('3 条候选 → 只列出 2 条"备选"（首条已在状态文字里逐跳写出）', () => {
    const html = renderToStaticMarkup(renderPathBar({
      model: modelWith([result(['A', 'B', 'D']), result(['A', 'C', 'D']), result(['A', 'E', 'D'])], 'found'),
      onExit: () => { /* noop */ },
    }));
    expect(html).toContain('data-anic-graph-path-candidates="true"');
    expect((html.match(/data-anic-graph-path-candidate="/g) ?? []).length).toBe(2);
  });

  it('只有 1 条候选 → 容器不渲染（零占位）', () => {
    const html = renderToStaticMarkup(renderPathBar({
      model: modelWith([result(['A', 'B', 'D'])], 'found'), onExit: () => { /* noop */ },
    }));
    expect(html).not.toContain('data-anic-graph-path-candidates');
    // 既有锚点一个不丢（契约在用，见 graphPathBar 头注）。
    for (const anchor of ['data-anic-graph-path-bar', 'data-anic-graph-path-status',
      'data-anic-graph-path-from', 'data-anic-graph-path-to', 'data-anic-graph-path-length',
      'data-anic-graph-path-exit']) {
      expect(html).toContain(anchor);
    }
  });

  it('反向结果带 direction=reverse 锚点（机器可读的"方向反了"）', () => {
    const reverse = renderToStaticMarkup(renderPathBar({
      model: pathModelOf({ active: true, from: 'd', to: 'a' }, CHAIN), onExit: () => { /* noop */ },
    }));
    expect(reverse).toContain('data-anic-graph-path-direction="reverse"');
    const forward = renderToStaticMarkup(renderPathBar({
      model: pathModelOf({ active: true, from: 'a', to: 'd' }, CHAIN), onExit: () => { /* noop */ },
    }));
    expect(forward).toContain('data-anic-graph-path-direction="forward"');
  });
});

describe('⑤ 词表：死键已删、新键两面俱在、hint 被消费', () => {
  const readLocale = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(ROOT, 'locale', name), 'utf8')) as Record<string, unknown>;
  const graphOf = (name: string): Record<string, string> =>
    (readLocale(name).graph ?? {}) as Record<string, string>;

  it('pathFindPlaceholder 已从两份 locale 删除（它承诺的控件不存在）', () => {
    for (const name of ['zh.json', 'en.json']) {
      expect(Object.prototype.hasOwnProperty.call(graphOf(name), 'pathFindPlaceholder')).toBe(false);
    }
    // 源码侧也不许再**声明**它（注释里提到"已删"不算——扫描前先剥注释，
    // 否则判据会把"解释自己删了什么"的注释也当成残留）。
    const raw = readFileSync(join(ROOT, 'src/client/features/graph/graphText.ts'), 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped.includes(['pathFind', 'Placeholder'].join(''))).toBe(false);
  });

  it('pathReverseOnly 在 zh/en 都存在且非空（两态要有两句人话）', () => {
    for (const name of ['zh.json', 'en.json']) {
      expect((graphOf(name).pathReverseOnly ?? '').length).toBeGreaterThan(0);
    }
  });

  it('pathFindHint 真的被消费：路径开关的 title 等于该键', () => {
    mount();
    const btn = host?.querySelector('[data-anic-graph-path-mode]') ?? null;
    expect(btn?.getAttribute('title')).toBe(t('graph.pathFindHint'));
  });
});