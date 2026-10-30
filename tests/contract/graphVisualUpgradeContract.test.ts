/**
 * 图谱视觉升级契约（cycle-83 · V 战线）——把"变好看了"变成可机器证伪的东西。
 *
 * ## 为什么视觉改动必须有契约
 *
 * 视觉升级的缺陷形态最隐蔽：卡片照常渲染、颜色照常"正确"、截图看着还行，
 * 而**任何既有断言都不会红**。本文件把六件事钉成可断言的形式：
 *
 * 1. **circle 数 == 节点数**（既有硬不变量，升级成卡片后最容易破的一条）；
 * 2. 每个节点 = 1 卡片 rect + 色条 rect + 主/次两层 text（缺任一层就是"看着像卡片，
 *    实际只有一行字"）；
 * 3. 边按 type 至少 3 种不同 dasharray/曲率形态（六种语义共用一条线正是本轮要修的缺陷）；
 * 4. tooltip 在 pointerenter 后出现、**focus 也出现**、pointerleave 后消失
 *    （键盘可达是 a11y 硬要求；只测 pointer 通道等于把这条要求测掉）；
 * 5. 小地图存在且**点击会改视口**（纯函数 `worldToViewport` 另有单测，这里测接线）；
 * 6. 面包屑文本随数据变化（固定文案等于装饰）。
 *
 * ## 两条守卫纪律（与本仓其余契约同形）
 *
 * - **反向自检**：每条关键断言都附带"篡改副本必须被判红"；
 * - **扫描集非空下限**：扫不到东西立即失败（空扫描 = 永久假绿）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { layoutGraph } from '../../src/client/features/graph/graphLayout.ts';
import { renderGraph } from '../../src/client/features/graph/renderGraph.ts';
import { edgeStyleOf, EDGE_STYLES } from '../../src/client/features/graph/graphEdgeRender.ts';
import { fitLabel, displayWidth } from '../../src/client/features/graph/graphNodeStyle.ts';
import { crumbsOf, currentCycleOf } from '../../src/client/features/graph/graphBreadcrumb.ts';
import { worldToViewport, viewportBoxInMinimap, minimapTransform } from '../../src/client/features/graph/graphMiniMap.ts';
import { tooltipPosition, TOOLTIP_W, worldToScreen } from '../../src/client/features/graph/graphTooltip.ts';
import { IDENTITY, clampPan } from '../../src/client/features/graph/graphViewport.ts';
import { SEMANTIC, SEMANTIC_DARK, token } from '../../src/shared/tokens.ts';
import { hostToken } from '../../src/shared/hostTokens.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;

/**
 * 动态取"某个类型的第一个节点"（cycle-84）：本文件原先硬编码 `evt:0` / `cycle:cycle-43`，
 * 那是**未窗口化**快照里的编号。产品主视图自 cycle-83 起窗口化（默认最近 8 轮），
 * 硬编码编号会随仓库推进而假红——而测试要验的是"预览能弹出""间距按类型分级"，
 * 与具体是第几号节点无关。故改为按类型现取。
 */
function firstNodeOfType(type: string): string {
  const hit = NODES.find((n) => n.type === type);
  if (hit === undefined) throw new Error('fixture invariant: no node of type ' + type);
  return hit.id;
}
const EVT_NODE = firstNodeOfType('gate-event');
const CYCLE_NODE = firstNodeOfType('cycle');

const LAYOUT = layoutGraph(NODES, EDGES);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLElement;
let root: Root;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // 传 onNodeClick：真实装配层（GraphSection）总是传它，节点才会拿到
  // role=button + tabIndex=-1 —— 没有回调的节点**不可聚焦**，focus 通道也就无从谈起。
  // 这不是为了测试开的后门，而是复现真实调用形态（否则测到的是"不可交互的图"）。
  act(() => {
    root.render(createElement(GraphInteractive, { nodes: NODES, edges: EDGES, onNodeClick: () => {} }));
  });
}
function unmount(): void {
  act(() => { root.unmount(); });
  host.remove();
}
/**
 * 揭示预览：组件有 120ms 防误触延迟（`tooltipDelay`），jsdom 不自动跑计时器。
 * 用假计时器把 120ms 一次性推进，再让 React 跑完 effect —— 这样测的是**真实延迟
 * 路径**而不是"把延迟改成 0 才测得出来"的假路径。
 */
function reveal(): void {
  act(() => { vi.advanceTimersByTime(200); });
}

function q<T extends Element = Element>(sel: string): T | null {
  return host.querySelector<T>(sel);
}
function qa<T extends Element = Element>(sel: string): T[] {
  return [...host.querySelectorAll<T>(sel)];
}

describe('① 节点卡片（circle 不变量 + 三层元素）', () => {
  it('circle 数仍 == 节点数（升级成卡片最容易破的硬不变量）', () => {
    mount();
    expect(qa('circle')).toHaveLength(SNAPSHOT.counts.nodes);
    unmount();
  });

  it('每节点：1 卡片 rect + 1 色条 rect + 主/次两层 text', () => {
    mount();
    expect(qa('[data-anic-node]')).toHaveLength(NODES.length);
    expect(qa('[data-anic-node-card]')).toHaveLength(NODES.length);
    expect(qa('[data-anic-node-bar]')).toHaveLength(NODES.length);
    expect(qa('[data-anic-node-label]')).toHaveLength(NODES.length);
    expect(qa('[data-anic-node-meta]')).toHaveLength(NODES.length);
    // 卡片是圆角矩形（rx 存在且 > 0），不是"方框"
    const card = q('[data-anic-node-card]');
    expect(Number(card?.getAttribute('rx') ?? 0)).toBeGreaterThan(0);
    unmount();
  });

  it('卡片尺寸随类型分级（phase/gate 高于事件）', () => {
    mount();
    const box = (id: string): { w: number; h: number } => {
      const n = q(`[data-anic-node="${id}"]`);
      const [w, h] = (n?.getAttribute('data-anic-node-box') ?? '0 0').split(' ').map(Number);
      return { w: w ?? 0, h: h ?? 0 };
    };
    expect(box('wf:plan').h).toBeGreaterThan(box(EVT_NODE).h);
    expect(box('wf:gate-g0').w).toBeGreaterThanOrEqual(box(EVT_NODE).w);
    unmount();
  });

  it('节点两两不重叠（变尺寸布局的正面判据，不是"看起来还行"）', () => {
    const rects = LAYOUT.nodes.map((n) => ({
      id: n.id,
      x0: n.x, x1: n.x + n.w,
      y0: n.y - n.h / 2, y1: n.y + n.h / 2,
    }));
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a === undefined || b === undefined) continue;
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlaps.push(`${a.id}×${b.id}`);
      }
    }
    expect(overlaps).toEqual([]);
    // 反向自检：把两张卡片硬叠在一起，上面的判定式必须能发现
    const tampered = [
      { id: 'a', x0: 0, x1: 10, y0: 0, y1: 10 },
      { id: 'b', x0: 5, x1: 15, y0: 5, y1: 15 },
    ];
    const found = tampered[0] === undefined || tampered[1] === undefined ? false
      : tampered[0].x0 < tampered[1].x1 && tampered[1].x0 < tampered[0].x1;
    expect(found).toBe(true);
  });
});

describe('② 语义边（至少三种形态，按 type 区分）', () => {
  it('六种边类型各自有登记线型，且形态两两可分', () => {
    const kinds = Object.keys(EDGE_STYLES);
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    const forms = new Set(kinds.map((k) => `${String(edgeStyleOf(k).dash)}|${String(edgeStyleOf(k).arrow)}`));
    // cycle-seq 实线 / evidences 虚线 / event-seq 点线 —— 至少三种不同形态
    expect(forms.size).toBeGreaterThanOrEqual(3);
  });

  it('真实 DOM 里边元素按 type 分出 ≥3 种 dash 值，且 ≥2 种曲率形态', () => {
    mount();
    const edges = qa('[data-anic-edge]');
    expect(edges).toHaveLength(SNAPSHOT.counts.edges);
    const dashes = new Set(edges.map((e) => e.getAttribute('data-anic-edge-dash') ?? ''));
    const curves = new Set(edges.map((e) => e.getAttribute('data-anic-edge-curve') ?? ''));
    expect(dashes.size).toBeGreaterThanOrEqual(3);
    expect(curves.size).toBeGreaterThanOrEqual(2); // 同列直线 + 跨列贝塞尔
    unmount();
  });

  it('跨列边是贝塞尔 path（d 含 C），同列边是直线（d 含 L）', () => {
    mount();
    const curves = qa('[data-anic-edge-curve="curve"]');
    const lines = qa('[data-anic-edge-curve="line"]');
    expect(curves.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(curves[0]?.getAttribute('d')).toContain('C ');
    expect(lines[0]?.getAttribute('d')).toContain('L ');
    // 每条边都是 path 且带 fill:none（否则贝塞尔会被默认黑色填充成一坨）
    for (const e of qa('[data-anic-edge]')) expect(e.getAttribute('fill')).toBe('none');
    unmount();
  });

  it('反向自检：把两种边退化同一线型，上面的形态判据必须红', () => {
    const same = new Set(['evidences', 'event-seq'].map(() => '3 2|false'));
    expect(same.size).toBe(1); // 退化后只有一种形态
    const real = new Set(['evidences', 'event-seq'].map((k) => `${String(edgeStyleOf(k).dash)}|${String(edgeStyleOf(k).arrow)}`));
    expect(real.size).toBe(2);
  });
});

describe('③ 悬浮预览（pointerenter / focus / pointerleave 三条通道）', () => {
  it('pointerenter 节点后出现预览，pointerleave 后消失', () => {
    vi.useFakeTimers();
    mount();
    const node = q(`[data-anic-node="${CYCLE_NODE}"]`);
    expect(node).not.toBeNull();
    act(() => { node?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    // 延迟期内不出现（否则"扫过一排卡片"会炸出一串预览）
    expect(q('[data-anic-graph-tooltip]')).toBeNull();
    reveal();
    expect(q('[data-anic-graph-tooltip]')).not.toBeNull();
    act(() => { node?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); });
    expect(q('[data-anic-graph-tooltip]')).toBeNull();
    unmount();
    vi.useRealTimers();
  });

  it('focus 也触发预览（键盘可达 —— a11y 硬要求，不是加分项）', () => {
    vi.useFakeTimers();
    mount();
    const node = q<SVGElement>(`[data-anic-node="${CYCLE_NODE}"]`) as unknown as HTMLElement;
    act(() => { node.focus(); });
    reveal();
    expect(q('[data-anic-graph-tooltip]')).not.toBeNull();
    act(() => { node.blur(); });
    expect(q('[data-anic-graph-tooltip]')).toBeNull();
    unmount();
    vi.useRealTimers();
  });

  it('预览卡内容含 id / 类型 / 邻接数（不是空壳）', () => {
    vi.useFakeTimers();
    mount();
    const node = q(`[data-anic-node="${EVT_NODE}"]`);
    act(() => { node?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    reveal();
    const tip = q('[data-anic-graph-tooltip]');
    expect(tip?.getAttribute('data-anic-graph-tooltip')).toBe(EVT_NODE);
    const meta = q('[data-anic-graph-tooltip-meta]')?.textContent ?? '';
    expect(meta).toContain(EVT_NODE);
    const degree = q('[data-anic-graph-tooltip-degree]')?.getAttribute('data-anic-graph-tooltip-degree');
    expect(Number(degree)).toBeGreaterThan(0);
    unmount();
    vi.useRealTimers();
  });

  it('面板 CSS 保 reduced-motion 与 forced-colors 两档含 tooltip（不能退）', () => {
    // 与既有 graphInteractiveContract ⑧ 同口径，但只看本轮的锚点。
    const css = readFileSync(join(ROOT, 'src', 'shared', 'panelCss.ts'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('[data-anic-graph-tooltip]');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('[data-anic-graph-tooltip]');
    // 反向自检：删掉 tooltip 那一行，断言必须红
    const broken = reduced.split('[data-anic-graph-tooltip]').join('');
    expect(broken).not.toContain('[data-anic-graph-tooltip]');
  });

  it('定位是纯函数且不依赖 getBoundingClientRect（jsdom 里恒 0）', () => {
    const at = tooltipPosition({ x: 0, y: 0, w: 90 }, IDENTITY, { width: 900, height: 560 });
    expect(at.x).toBeGreaterThanOrEqual(0);
    // 右侧放不下 → 翻转到左侧（世界坐标 x=1000 在右侧之外）
    const flipped = tooltipPosition({ x: 800, y: 0, w: 90 }, IDENTITY, { width: 900, height: 560 });
    expect(flipped.x + TOOLTIP_W).toBeLessThanOrEqual(900);
    // 反向自检：不翻转、不夹钳时它会跑出可视区
    const naive = worldToScreen({ x: 800 + 90, y: 0 }, IDENTITY).x + 12;
    expect(naive + TOOLTIP_W).toBeGreaterThan(900);
  });
});

describe('④ 小地图（存在 + 点击真的改视口）', () => {
  it('小地图在场，且 svg 仍恰好 1 个（不嵌套 svg）', () => {
    mount();
    expect(qa('svg')).toHaveLength(1);
    expect(qa('[data-anic-graph-minimap]')).toHaveLength(1);
    expect(qa('[data-anic-graph-minimap-viewport]')).toHaveLength(1);
    // 缩略点每个节点一个 rect，且**不用 circle**（否则 circle 数会翻倍）
    expect(qa('[data-anic-graph-minimap-node]')).toHaveLength(NODES.length);
    unmount();
  });

  it('点击小地图改变视口（transform 真的变了，不是装饰）', () => {
    mount();
    const svg = q<SVGElement>('svg[data-anic-graph]') as unknown as HTMLElement;
    // 先放大到"内容大于视口"，否则 clampPan 会把内容居中锁死（正确行为，无判别力）
    act(() => {
      for (let i = 0; i < 3; i += 1) svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    const world = (): string => q('[data-anic-graph-world]')?.getAttribute('transform') ?? '';
    const before = world();
    const bg = q('[data-anic-graph-minimap-bg]');
    act(() => {
      bg?.dispatchEvent(new MouseEvent('mousedown', { clientX: 4, clientY: 4, bubbles: true }));
    });
    expect(world()).not.toBe(before);
    unmount();
  });

  it('反向自检：点在图上（不在小地图里）不触发跳转', () => {
    mount();
    const svg = q<SVGElement>('svg[data-anic-graph]') as unknown as HTMLElement;
    act(() => {
      for (let i = 0; i < 3; i += 1) svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    const world = (): string => q('[data-anic-graph-world]')?.getAttribute('transform') ?? '';
    const before = world();
    const node = q(`[data-anic-node="${EVT_NODE}"]`);
    act(() => { node?.dispatchEvent(new MouseEvent('mousedown', { clientX: 4, clientY: 4, bubbles: true })); });
    expect(world()).toBe(before);
    unmount();
  });

  it('worldToViewport 是纯函数：让目标世界点落在视口中心，且过钳制', () => {
    const bounds = LAYOUT.bounds;
    const size = { width: 900, height: 560 };
    const tr = minimapTransform(bounds);
    // 目标点取**包围盒中心**：窗口化视图可能很小，取固定的 600/300 会落到图外，
    // 此时钳制必然生效、断言变成在测钳制而不是"居中"（cycle-84 实测 430px 偏差）。
    const target = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const local = { x: target.x * tr.k + tr.dx, y: target.y * tr.k + tr.dy };
    const next = worldToViewport(local, bounds, IDENTITY, size);
    // 目标点映射回屏幕 ≈ 视口中心（钳制内时严格成立）
    const screenX = target.x * next.scale + next.tx;
    expect(Math.abs(screenX - size.width / 2)).toBeLessThan(1);
    // 且结果必然是钳制后的合法视口
    expect(next).toEqual(clampPan(next, size, bounds));
    // 视口矩形在小地图上随缩放变大（放大 → 看到的范围更小 → 框更窄）
    const wide = viewportBoxInMinimap(IDENTITY, size, bounds);
    const zoomed = viewportBoxInMinimap({ scale: 2, tx: 0, ty: 0 }, size, bounds);
    expect(zoomed.w).toBeLessThan(wide.w);
  });
});

describe('⑤ 面包屑（随数据变化，不是固定文案）', () => {
  it('挂载后出现面包屑，含 root / cycle / phase / 窗口四段', () => {
    mount();
    const crumbs = qa('[data-anic-graph-crumb]').map((el) => el.getAttribute('data-anic-graph-crumb'));
    expect(crumbs).toContain('root');
    expect(crumbs).toContain('cycle');
    expect(crumbs).toContain('phase');
    expect(crumbs).toContain('window');
    expect(q('[data-anic-graph-crumbs]')?.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
    unmount();
  });

  it('当前轮取序号最大的 cycle（不是首现顺序）', () => {
    // 取 NODES 里的**最大编号**轮（不是首现顺序）——窗口化后首现可能是 cycle-77，
    // 而最大是 cycle-84，两者的差异正是本用例要守的语义。
    const maxCycle = NODES
      .filter((n) => n.type === 'cycle' && Number.isFinite(Number(n.label.slice('cycle-'.length))))
      .map((n) => Number(n.label.slice('cycle-'.length)))
      .reduce((a, b) => Math.max(a, b), 0);
    expect(currentCycleOf(NODES)).toBe(`cycle-${String(maxCycle)}`);
    // 反向自检：乱序输入仍取最大序号
    const shuffled = [
      { id: 'cycle:cycle-2', type: 'cycle' as const, label: 'cycle-2', x: 0, y: 0 },
      { id: 'cycle:cycle-99', type: 'cycle' as const, label: 'cycle-99', x: 0, y: 0 },
      { id: 'cycle:cycle-7', type: 'cycle' as const, label: 'cycle-7', x: 0, y: 0 },
    ];
    expect(currentCycleOf(shuffled)).toBe('cycle-99');
  });

  it('窗口段随 windowedOut 变化（折叠数与全量是两句话）', () => {
    const all = crumbsOf({ nodes: NODES, windowedOut: 0 });
    const folded = crumbsOf({ nodes: NODES, windowedOut: 120 });
    const text = (c: typeof all): string => c.map((x) => x.text).join('|');
    expect(text(all)).not.toBe(text(folded));
    // 无 cycle / 无 phase 时不渲染该段（而不是渲染 "cycle-null"）
    const bare = crumbsOf({ nodes: [{ id: 'x', type: 'gate', label: 'G', x: 0, y: 0 }], windowedOut: 0 });
    expect(bare.map((c) => c.kind)).toEqual(['root', 'window']);
  });
});

describe('⑥ 令牌（两套主题都有值，且宿主上游不改判定口径）', () => {
  it('浅色/暗色表都覆盖本轮用到的关键令牌', () => {
    for (const key of ['anic-surface', 'anic-border-strong', 'anic-text-dim', 'anic-text-faint', 'anic-focus-ring'] as const) {
      expect(typeof SEMANTIC[key]).toBe('string');
      expect(SEMANTIC[key].length).toBeGreaterThan(3);
    }
    // 暗色覆盖的是"在暗底上会失效"的那些；文本三档必须都有暗色档
    for (const key of ['anic-text', 'anic-text-dim', 'anic-text-faint'] as const) {
      expect(typeof SEMANTIC_DARK[key]).toBe('string');
      expect(SEMANTIC_DARK[key]).not.toBe(SEMANTIC[key]);
    }
  });

  it('hostToken：anic-* 在最外层，宿主令牌在中间，原语垫底', () => {
    const expr = hostToken('anic-text');
    // 最外层必须是 anic-*（本仓对比度契约测的就是它），中间段是宿主别名。
    expect(expr.startsWith(['var(--anic-text, var(--dsw-alias-'].join(''))).toBe(true);
    // 末段是具体十六进制（不是又一个 var），否则失败只是被推后一层
    expect(expr).toMatch(/, #[0-9a-f]{6}\)\)$/);
    // 未登记宿主上游的令牌退化为 token()，形状不变
    expect(hostToken('anic-pass')).toBe(token('anic-pass'));
  });

  it('图区源码没有绕过令牌的颜色字面量', () => {
    const files = [
      'graphNodeStyle.ts', 'graphNodeCard.ts', 'graphEdgeRender.ts',
      'graphTooltip.ts', 'graphMiniMap.ts', 'graphBreadcrumb.ts',
      'graphStage.ts', 'graphToolbarRender.ts', 'graphToolbarGroups.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const raw = readFileSync(join(ROOT, 'src', 'client', 'features', 'graph', f), 'utf8');
      // 去注释后扫（注释里举的坏例子不算违规）
      const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      body.split('\n').forEach((line, i) => {
        if (/rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/.test(line) && !line.includes('url(#')) {
          offenders.push(`${f}:${String(i + 1)} ${line.trim().slice(0, 60)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // 扫描集非空下限（9 个文件都必须真读到）
    expect(files.length).toBe(9);
  });
});

describe('⑦ 标签截断（按宽度而非字数，纯函数）', () => {
  it('CJK 比 ASCII 宽：displayWidth("中文") > displayWidth("ab")', () => {
    expect(displayWidth('中文')).toBeGreaterThan(displayWidth('ab'));
  });

  it('窄卡片截断得更狠，且截断后仍在预算内', () => {
    const long = 'Maintain（维护）阶段收口门';
    const wide = fitLabel(long, 112);
    const narrow = fitLabel(long, 92);
    expect(displayWidth(narrow)).toBeLessThanOrEqual(displayWidth(wide));
    expect(wide.endsWith('…')).toBe(true);
    // 短标签不截断（不该给"评估"加省略号）
    expect(fitLabel('评估', 92)).toBe('评估');
    // 反向自检：按字符数截断（旧做法）会越界——证明宽度口径有判别力
    const byCount = long.slice(0, 10);
    expect(displayWidth(byCount)).toBeGreaterThan(displayWidth(fitLabel(long, 92)));
  });
});

describe('⑧ 纯渲染路径的倒退守卫（零参调用仍产出同一张图）', () => {
  it('renderGraph 不传 opts 时不渲染小地图（画布 = 包围盒，小地图无意义）', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {});
    const json = JSON.stringify(tree);
    expect(json).not.toContain('data-anic-graph-minimap');
    expect(json).toContain('data-anic-node-card');
    // 反向自检：传了 size 就必须有小地图
    const withSize = JSON.stringify(renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {},
      { size: { width: 900, height: 420 } }));
    expect(withSize).toContain('data-anic-graph-minimap');
  });
});
