/**
 * 交互式图区契约（cycle-82 · G 战线）——真实 DOM / A11y / 不变量三条腿。
 *
 * ## 为什么要 jsdom 真挂载，而不是遍历元素树
 *
 * `GraphInteractive` 用 `useState`/`useEffect`/`useCallback`。直接调用函数组件
 * （元素树遍历那种做法）会撞上 `Cannot read properties of null (reading 'useState')`
 * ——hooks 没有 dispatcher。真正的选择只有两个：① 真挂载；② 只测纯渲染函数。
 *
 * 本文件两者都做，但**分工明确**：
 * - 纯渲染（`renderGraph` / `renderGraphToolbar`）→ 元素树遍历（无 hooks，能断言 props）；
 * - 组件（`GraphInteractive`）→ jsdom + `react-dom/client` 真挂载，断言**真实 DOM**。
 *
 * 真挂载比"断言 props"更强：`pointer-events` / `opacity` / `tabIndex` 的最终计算值、
 * 事件处理器是否真的被 React 接上，都只有进 DOM 才看得见。本仓 `foldPrefs.test.ts`
 * 已确立同一口径（"事件派发在 node 环境里无效，会变成永远绿的假守卫"）。
 *
 * ## 这个文件守的是「改造后仍然成立的旧契约」+「本轮新增能力的形状」
 *
 * 图区从静态 SVG 变成带工具栏的可交互组件时，最危险的失误不是新功能不能用，
 * 而是**旧契约静默失效**：
 * 1. smoke 断言 `circle 数 == counts.nodes`——一旦有人把筛选实现成 `nodes.filter()`，
 *    "筛选能用"了，但这条与本节断言同时红；
 * 2. `<desc>` / 等价数据表 / `role=group` / roving tabindex 在重构中最容易被"顺手"
 *    删掉，而**任何视觉验收都看不出**；
 * 3. 工具栏 6 个控件若漏了可访问名，AT 只播报"按钮/组合框"——截图里 100% 不可见。
 *
 * ## 三条守卫纪律（与本仓其余契约同形）
 * - **反向自检**：关键断言都附带"篡改副本必须被判红"；
 * - **数据驱动**：数量对着 `artifacts/workflow-snapshot.json` 现算，不硬编码 188；
 * - **扫描集非空下限**：扫不到东西立即失败。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { renderGraph } from '../../src/client/features/graph/renderGraph.ts';
import { renderGraphToolbar } from '../../src/client/features/graph/graphToolbar.ts';
import { layoutGraph, legacyBounds } from '../../src/client/features/graph/graphLayout.ts';
import { EMPTY_FILTER, buildFilterView } from '../../src/client/features/graph/graphFilter.ts';
import { IDENTITY, SCALE_MIN, zoomBy } from '../../src/client/features/graph/graphViewport.ts';
import { PANEL_CSS } from '../../src/shared/panelCss.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';
import { buildWorkflowSnapshot } from '../../src/shared/snapshotCore.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 真实快照：数量断言一律现算（快照随 .cycles/ 增长而变）。 */
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;

/**
 * 全量投影（cycle-84）：**几何压缩率**这类断言只有在有规模时才成立。
 * 产品主视图是窗口化的（默认 8 轮），用 41 节点验"压到 ≤60%"必然假红；
 * 而"窗口确实生效"由本文件 ⑩（windowedOut > 0）与 archiveResetContract 负责。
 */
const FULL = buildWorkflowSnapshot(
  join(ROOT, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 'full' },
);

// act 环境声明：否则每个用例都打 "not configured to support act(...)" 噪音。
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

/* ── 挂载/卸载工具 ─────────────────────────────────────────── */

let host: HTMLElement;
let root: Root;

function mount(el: Parameters<Root['render']>[0]): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(el); });
}
function unmount(): void {
  act(() => { root.unmount(); });
  host.remove();
}

/** 交互态挂载（每个用例独立挂载：状态不串味，这也是 ref 缓存正确性的隐性验证）。 */
function mountInteractive(onNodeClick?: (n: unknown) => void): void {
  mount(createElement(GraphInteractive, { nodes: NODES, edges: EDGES, onNodeClick }));
}
beforeEach(() => { /* 挂载在各用例内做，避免空挂载污染 */ });
afterEach(() => { /* 各用例自行 unmount */ });

/* ── 元素树遍历（仅用于无 hooks 的纯渲染函数）────────────────── */

function collect(
  node: unknown,
  pred: (type: unknown, props: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 30) return out;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, pred, out, depth + 1);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === 'function') {
    // 纯渲染函数组件（无 hooks）可直接展开；有 hooks 的组件不在此文件走这条路径。
    return collect((el.type as (p: unknown) => unknown)(el.props ?? {}), pred, out, depth + 1);
  }
  const props = el.props ?? {};
  if (pred(el.type, props)) out.push(props);
  const children = props.children;
  if (Array.isArray(children)) for (const c of children) collect(c, pred, out, depth + 1);
  else if (children !== undefined) collect(children, pred, out, depth + 1);
  return out;
}

const pureTree = () => renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {});

describe('扫描集非空（空扫描 = 永久假绿）', () => {
  it('真实快照有足量节点与边（**窗口化后**的规模，不是全量历史）', () => {
    /*
     * cycle-84 修正：原阈值 150/200 是对着"未窗口化"的旧工件写的。
     * cycle-83 引入投影窗口（默认 8 轮，`windowConfig.ts`）后，主视图的
     * **设计目标**就是"一屏可读"——真实的窗口化快照是 41 节点 / 55 边，
     * 而被折叠的 139 个节点由 `windowedOut` 如实报告（见 archiveResetContract
     * 的「窗口化 ≤ 全量 1/3」契约，两条口径互为约束）。
     *
     * 若继续要求 150，唯一"通过"的方式是关掉窗口或塞假数据——那会把
     * 「避免过度产物影响判断」这个用户诉求反过来做掉。故阈值改为
     * 「足以证明不是空集/退化集」的下限，并**额外**断言窗口真的在生效。
     */
    expect(NODES.length).toBeGreaterThanOrEqual(30);
    expect(EDGES.length).toBeGreaterThanOrEqual(40);
    expect(SNAPSHOT.counts.nodes).toBe(NODES.length);
    // 窗口生效的证据：被折叠数 > 0（否则上面那组小阈值可能只是"数据本来就少"）
    expect(SNAPSHOT.counts.windowedOut).toBeGreaterThan(0);
  });

  it('交互态真挂载后 DOM 里确实有节点、边、单 svg、工具栏', () => {
    mountInteractive();
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(NODES.length);
    // cycle-83：同 ① 的口径——数锚点不数 `<line>` 标签（见 ① 用例的裁决注释）。
    expect(host.querySelectorAll('[data-anic-edge]').length).toBe(EDGES.length);
    expect(host.querySelectorAll('svg[data-anic-graph]').length).toBe(1);
    expect(host.querySelectorAll('[data-anic-graph-toolbar]').length).toBe(1);
    unmount();
  });
});

describe('① 节点/边一个不少（smoke 不变量在交互态同样成立）', () => {
  it('circle 数 == counts.nodes，边锚点数 == counts.edges，svg 恰好 1 个', () => {
    mountInteractive();
    expect(host.querySelectorAll('circle').length).toBe(SNAPSHOT.counts.nodes);
    /*
     * cycle-83：边计数从「`<line>` 标签数」改成「`data-anic-edge` 锚点数」。
     *
     * 为什么改（与 `scripts/offline-smoke.mjs` 同一裁决、同一形状）：
     * 视觉升级要给边分语义——时序实线、证据虚线、事件点线、跨 lane 贝塞尔。
     * 直线变 `<path d="M.. C..">` 后按 `line` 标签数会**少算**，而渲染完全正确
     * ⇒ 那是判据与实现形态耦合的假红（本仓 cycle-82 在 `panelDataLegContract`
     * 上修过同族问题，不该在这里复发）。
     *
     * 新判据比旧的**更强**：
     *   ① 不关心你画 line 还是 path，换任何形态都不假红；
     *   ② 能抓出「渲染了边但忘打锚点」——旧判据数 `line` 时，一条忘了打锚点的线
     *      照样被数进去，这个缺陷**永远看不见**。
     */
    expect(host.querySelectorAll('[data-anic-edge]').length).toBe(SNAPSHOT.counts.edges);
    expect(host.querySelectorAll('svg').length).toBe(1);
    unmount();
  });

  it('筛选激活后节点数**不减少**（"不删节点"纪律的可断言形式）', () => {
    mountInteractive();
    const before = host.querySelectorAll('circle').length;
    // 真实交互：勾选 cycle 类型的 chip
    const chip = host.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]');
    expect(chip).not.toBeNull();
    act(() => { chip?.click(); });
    // 节点 DOM 一个不少
    expect(host.querySelectorAll('circle').length).toBe(before);
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(NODES.length);
    // 且确实有大量节点被标成 filtered（否则"筛选生效"是假的）
    const filtered = host.querySelectorAll('[data-anic-visibility="filtered"]');
    expect(filtered.length).toBeGreaterThan(NODES.length / 2);
    unmount();
  });

  it('等价数据表仍是全量（AT 文本替代不随筛选缩水）', () => {
    mountInteractive();
    expect(host.querySelectorAll('[data-anic-table-node]').length).toBe(NODES.length);
    const chip = host.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]');
    act(() => { chip?.click(); });
    expect(host.querySelectorAll('[data-anic-table-node]').length).toBe(NODES.length);
    unmount();
  });

  it('反向自检：若把筛选实现成 nodes.filter()，节点数会掉——证明上面断言有判别力', () => {
    const view = buildFilterView(NODES, EDGES, { types: ['cycle'], verdicts: [], query: '' }, null);
    const narrowed = NODES.filter((n) => view.matching.has(n.id));
    expect(narrowed.length).toBeLessThan(SNAPSHOT.counts.nodes);
    const tree = renderGraph({ nodes: narrowed, edges: EDGES }, undefined, () => {});
    expect(collect(tree, (t) => t === 'circle').length).not.toBe(SNAPSHOT.counts.nodes);
  });
});

describe('② 工具栏控件齐全（正确语义元素 + 可访问名）', () => {
  const bar = renderGraphToolbar({
    filter: EMPTY_FILTER,
    typeCounts: [{ type: 'gate', count: 4 }],
    verdictCounts: [{ type: 'pass', count: 100 }],
    viewport: IDENTITY,
    adjacencyOn: true,
    onQuery: () => {}, onToggleType: () => {}, onToggleVerdict: () => {},
    onAdjacencyToggle: () => {}, onZoomIn: () => {}, onZoomOut: () => {},
    onFit: () => {}, onClear: () => {},
  });

  it('搜索框：input[type=search]（有值可清空，不是按钮）', () => {
    const search = collect(bar, (t, p) => t === 'input' && p['data-anic-graph-search'] === 'true');
    expect(search).toHaveLength(1);
    expect(search[0]?.type).toBe('search');
    expect(String(search[0]?.['aria-label'] ?? '').length).toBeGreaterThan(0);
  });

  it('类型 chips：label + checkbox（多选的唯一正确语义），带计数与选中态', () => {
    const chips = collect(bar, (t, p) => t === 'label' && typeof p['data-anic-graph-chip'] === 'string');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.['data-anic-graph-chip-count']).toBe('4');
    expect(chips[0]?.['data-anic-graph-chip-checked']).toBe('false');
    const inputs = collect(bar, (t, p) => t === 'input' && p['data-anic-graph-chip-input'] === 'gate');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe('checkbox');
  });

  it('裁决筛选：select[multiple]（6 态是集合，不是单选）', () => {
    const sel = collect(bar, (t, p) => t === 'select' && p['data-anic-graph-verdict'] === 'true');
    expect(sel).toHaveLength(1);
    expect(sel[0]?.multiple).toBe(true);
    expect(String(sel[0]?.['aria-label'] ?? '').length).toBeGreaterThan(0);
    const opts = collect(bar, (t, p) => t === 'option' && p['data-anic-graph-verdict-option'] === 'pass');
    expect(opts).toHaveLength(1);
    expect(opts[0]?.['data-anic-graph-verdict-count']).toBe('100');
  });

  it('缩放三键是**真 button**（动作语义，不是 slider）', () => {
    for (const kind of ['in', 'out', 'fit']) {
      const btns = collect(bar, (t, p) => t === 'button' && p['data-anic-graph-zoom'] === kind);
      expect(btns, `缺少 ${kind} 按钮`).toHaveLength(1);
      expect(btns[0]?.type).toBe('button');
      expect(String(btns[0]?.['aria-label'] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('比例读数是 output（结果播报，不是控件，不进 Tab 序列）', () => {
    const out = collect(bar, (t, p) => t === 'output' && p['data-anic-graph-zoom-readout'] === 'true');
    expect(out).toHaveLength(1);
    expect(String(out[0]?.children)).toBe('100%');
    expect(out[0]?.tabIndex).toBeUndefined();
  });

  it('邻接高亮开关：label 包 checkbox（点文字也能切）', () => {
    mountInteractive();
    const label = host.querySelector('label[data-anic-graph-adjacency-toggle="true"]');
    expect(label).not.toBeNull();
    const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(true); // 默认开：默认就该"悬停能看出关系"
    expect(String(box?.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    unmount();
  });

  it('清空筛选按钮：无筛选时 disabled，有筛选时启用', () => {
    mountInteractive();
    const clear = () => host.querySelector<HTMLButtonElement>('[data-anic-graph-clear]');
    expect(clear()?.disabled).toBe(true);
    const chip = host.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]');
    act(() => { chip?.click(); });
    expect(clear()?.disabled).toBe(false);
    // 点它真的清空
    act(() => { clear()?.click(); });
    expect(clear()?.disabled).toBe(true);
    expect(host.querySelectorAll('[data-anic-visibility="filtered"]').length).toBe(0);
    unmount();
  });

  it('图例带真色点（只写类型名的图例等于没写），且不进 Tab 序列', () => {
    mountInteractive();
    const legend = host.querySelector('[data-anic-graph-legend]');
    expect(legend?.getAttribute('aria-hidden')).toBe('true');
    const dot = host.querySelector<HTMLElement>('[data-anic-graph-legend-dot="gate"]');
    expect(dot).not.toBeNull();
    // 真色点：background 引用了类型色令牌（不是空字符串/透明）
    expect(dot?.style.background ?? '').toContain('--anic-type-gate');
    unmount();
  });

  it('真实 DOM 里每个可聚焦控件都有可访问名（aria-label 或包裹 label 文本）', () => {
    mountInteractive();
    const controls = [
      ...host.querySelectorAll<HTMLElement>('[data-anic-graph-toolbar] button'),
      ...host.querySelectorAll<HTMLElement>('[data-anic-graph-toolbar] select'),
      ...host.querySelectorAll<HTMLElement>('[data-anic-graph-toolbar] input'),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(7);
    const unnamed = controls.filter((el) => {
      const aria = el.getAttribute('aria-label');
      if (aria !== null && aria.length > 0) return false;
      // 被 <label> 包裹 ⇒ label 内的可见文本就是它的名字
      return el.closest('label') === null;
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
    unmount();
  });
});

describe('③ A11y 契约不退（desc / role / roving / 单一 Tab 停靠点）', () => {
  it('<desc> 存在且含键盘操作说明', () => {
    mountInteractive(() => {});
    const desc = host.querySelector('desc');
    expect(desc).not.toBeNull();
    expect((desc?.textContent ?? '').length).toBeGreaterThan(10);
    unmount();
  });

  it('svg 是唯一 Tab 停靠点（role=group + tabIndex=0），全树恰一个停靠点', () => {
    mountInteractive(() => {});
    const svg = host.querySelector('svg[data-anic-graph]');
    expect(svg?.getAttribute('role')).toBe('group');
    expect(svg?.getAttribute('tabindex')).toBe('0');
    // 全树 tabIndex=0 的元素恰一个（工具栏控件之外）：多一个就有第二个停靠点，
    // 键盘用户要按两次 Tab 才能穿过图区（P1-2 消灭的正是这个反模式）。
    const stops = [...host.querySelectorAll<HTMLElement>('[tabindex="0"]')]
      .filter((el) => !el.closest('[data-anic-graph-toolbar]'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(svg);
    unmount();
  });

  it('节点全部 tabIndex=-1（roving：组内方向键，不占 Tab 序列）', () => {
    mountInteractive(() => {});
    const nodes = [...host.querySelectorAll<SVGElement>('[data-anic-node]')];
    expect(nodes).toHaveLength(NODES.length);
    for (const n of nodes) expect(n.getAttribute('tabindex')).toBe('-1');
    unmount();
  });

  it('svg 的 keydown 同时承载 roving 与缩放键，键盘说明经 aria-describedby 关联', () => {
    mountInteractive(() => {});
    const svg = host.querySelector('svg[data-anic-graph]');
    const describedBy = svg?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = host.querySelector(`[id="${describedBy ?? ''}"]`);
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('data-anic-graph-keyhint')).toBe('true');
    expect(hint?.className).toBe('anic-sr-only'); // 视觉隐藏但仍被 AT 读到
    unmount();
  });

  it('键盘 +/−/0 真的改变比例读数（不是空处理器）', () => {
    mountInteractive(() => {});
    const svg = host.querySelector('svg[data-anic-graph]');
    const readout = () => host.querySelector('[data-anic-graph-zoom-readout]')?.textContent ?? '';
    // 注意：挂载后 effect 会适配一次（jsdom 下容器尺寸为 0 → 回落 900×560），
    // 所以基线不是 100%，而是适配后的比例。断言的是**相对变化**，不是绝对值。
    const baseline = readout();
    expect(baseline).not.toBe('');
    const key = (k: string): void => {
      act(() => {
        svg?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };
    key('+');
    const afterIn = readout();
    expect(afterIn).not.toBe(baseline);        // 放大确实生效
    key('-');
    key('-');
    const afterOut = readout();
    expect(afterOut).not.toBe(afterIn);        // 缩小确实生效
    key('0');
    expect(readout()).toBe(baseline);          // 适配视图回到同一档（适配是幂等的）
    unmount();
  });

  it('Home/End 仍归 roving（未被缩放抢走）：焦点从容器移向首/末节点', () => {
    mountInteractive(() => {});
    const svg = host.querySelector('svg[data-anic-graph]') as unknown as HTMLElement;
    const nodes = [...host.querySelectorAll<SVGElement>('[data-anic-node]')];
    // focus() 会触发外层 onFocusCapture → setFocusId（状态更新），必须包在 act 里，
    // 否则 React 报 "not wrapped in act(...)" 噪音（断言仍对，但输出被淹没）。
    act(() => { svg.focus(); });
    const readout = host.querySelector('[data-anic-graph-zoom-readout]')?.textContent;
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(document.activeElement).toBe(nodes[0]);
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(nodes[nodes.length - 1]);
    // 比例未因 Home/End 改变（Home≠适配视图，End≠别的动作）
    expect(host.querySelector('[data-anic-graph-zoom-readout]')?.textContent).toBe(readout);
    unmount();
  });

  it('节点仍带 role=button + aria-label 含 id（同名节点可区分）', () => {
    mountInteractive(() => {});
    const nodes = [...host.querySelectorAll<SVGElement>('[data-anic-node]')];
    for (const n of nodes) {
      expect(n.getAttribute('role')).toBe('button');
      expect(n.getAttribute('aria-label') ?? '').toContain(n.getAttribute('data-anic-node') ?? '');
    }
    unmount();
  });

  it('反向自检：不可交互时（无 onNodeClick）svg 失去 tabIndex，停靠点断言口径对得上', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, undefined, { viewport: IDENTITY });
    const svg = collect(tree, (t, p) => t === 'svg' && p['data-anic-graph'] === 'true')[0];
    expect(svg?.tabIndex).toBeUndefined();
    expect(collect(tree, (t, p) => p.tabIndex === 0).length).toBe(0);
  });
});

describe('④ 悬停邻接高亮（真实 DOM 事件）', () => {
  it('pointerover 节点 → 邻居 active / 非邻居 dimmed，且节点数不变', () => {
    mountInteractive();
    const layout = layoutGraph(NODES, EDGES);
    const focusId = layout.nodes[0]?.id ?? '';
    const target = host.querySelector(`[data-anic-node="${focusId}"]`);
    expect(target).not.toBeNull();
    act(() => {
      target?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    const counts = { active: 0, dimmed: 0, filtered: 0 };
    for (const n of host.querySelectorAll('[data-anic-visibility]')) {
      const v = n.getAttribute('data-anic-visibility') as keyof typeof counts;
      counts[v] += 1;
    }
    expect(counts.dimmed).toBeGreaterThan(0);            // 确有非邻居被降透明
    expect(counts.filtered).toBe(0);                     // 未筛选 ⇒ 没有被排除的
    expect(counts.active + counts.dimmed).toBe(NODES.length);
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(NODES.length); // 一个不少
    unmount();
  });

  it('pointerout 后恢复全亮（悬停不该留下永久淡化）', () => {
    mountInteractive();
    const target = host.querySelector('[data-anic-node]');
    act(() => { target?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    act(() => { target?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); });
    expect(host.querySelectorAll('[data-anic-visibility="dimmed"]').length).toBe(0);
    unmount();
  });

  it('关掉邻接开关后不再降透明（开关必须真的生效，不是装饰）', () => {
    mountInteractive();
    const box = host.querySelector<HTMLInputElement>('label[data-anic-graph-adjacency-toggle] input');
    act(() => { box?.click(); });
    const target = host.querySelector('[data-anic-node]');
    act(() => { target?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    expect(host.querySelectorAll('[data-anic-visibility="dimmed"]').length).toBe(0);
    unmount();
  });

  it('被筛掉的节点 pointer-events:none（视觉淡 ≠ 仍可点）', () => {
    mountInteractive();
    const chip = host.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]');
    act(() => { chip?.click(); });
    const filtered = [...host.querySelectorAll<SVGElement>('[data-anic-visibility="filtered"]')];
    expect(filtered.length).toBeGreaterThan(0);
    for (const n of filtered) expect(n.style.pointerEvents).toBe('none');
    const active = [...host.querySelectorAll<SVGElement>('[data-anic-visibility="active"]')];
    for (const n of active) expect(n.style.pointerEvents).toBe('');
    unmount();
  });

  it('三档 opacity 递减且 filtered 仍 > 0（完全 0 等于删除）', () => {
    /*
     * cycle-87：改用**合成小图**。
     *
     * 三档语义（active / dimmed / filtered）要求同一类型下至少 3 个节点
     * （中心 + 命中邻居 + 未命中邻居）。原实现拿真实快照的 cycle lane 做样本——
     * cycle-86 归档 82 轮后只剩 1 个 cycle 节点，`dimmed` 档位不存在，读到 NaN 假红。
     * 判据是**渲染语义**，与仓库此刻有几轮无关，故自造 3 cycle + 1 gate。
     */
    const nodes = [
      { id: 'syn-cycle-1', type: 'cycle' as const, label: 'c1', x: 0, y: 0 },
      { id: 'syn-cycle-2', type: 'cycle' as const, label: 'c2', x: 0, y: 46 },
      { id: 'syn-cycle-3', type: 'cycle' as const, label: 'c3', x: 0, y: 92 },
      { id: 'syn-gate-1', type: 'gate' as const, label: 'g1', x: 120, y: 0 },
    ];
    const edges = [
      { from: 'syn-cycle-1', to: 'syn-cycle-2', type: 'cycle-seq' },
      { from: 'syn-cycle-2', to: 'syn-cycle-3', type: 'cycle-seq' },
    ];
    mount(createElement(GraphInteractive, { nodes, edges }));
    const chip = host.querySelector<HTMLInputElement>('[data-anic-graph-chip-input="cycle"]');
    act(() => { chip?.click(); });
    // 悬停 c1：它命中筛选且是邻域中心 ⇒ active；c2 命中但是邻居 ⇒ active/dimmed 之一；
    // c3 命中筛选但与 c1 不相邻 ⇒ dimmed；gate ⇒ filtered。
    const center = host.querySelector('[data-anic-node="syn-cycle-1"]');
    expect(center).not.toBeNull();
    act(() => { center?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    const op = (v: string): number => {
      const el = host.querySelector<SVGElement>(`[data-anic-visibility="${v}"]`);
      return Number(el?.style.opacity ?? 'NaN');
    };
    expect(op('active')).toBe(1);
    expect(op('dimmed')).toBeLessThan(1);
    expect(op('filtered')).toBeLessThan(op('dimmed'));
    expect(op('filtered')).toBeGreaterThan(0);
    // 反向自检：三个档位必须**同时**出现（否则上面的递减只是两个数在比）
    for (const v of ['active', 'dimmed', 'filtered']) {
      expect(host.querySelectorAll(`[data-anic-visibility="${v}"]`).length, v + ' 档位缺失').toBeGreaterThan(0);
    }
    unmount();
  });
});

describe('⑤ 视口变换与布局（几何可断言）', () => {
  const layout = layoutGraph(NODES, EDGES);

  it('单个 <g data-anic-graph-world> 承载 transform，且顺序是 translate 再 scale', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {},
      { viewport: { scale: 2, tx: 10, ty: -20 } });
    const world = collect(tree, (t, p) => t === 'g' && p['data-anic-graph-world'] === 'true');
    expect(world).toHaveLength(1);
    expect(world[0]?.transform).toBe('translate(10,-20) scale(2)');
    const svg = collect(tree, (t, p) => t === 'svg' && p['data-anic-graph'] === 'true')[0];
    expect(svg?.['data-anic-graph-scale']).toBe('2');
  });

  it('缩放被钳制时 transform 也用钳制后的值（0.001 不能穿到 DOM）', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {},
      { viewport: { scale: 0.001, tx: 0, ty: 0 } });
    const world = collect(tree, (t, p) => t === 'g' && p['data-anic-graph-world'] === 'true')[0];
    expect(String(world?.transform)).toBe(`translate(0,0) scale(${String(SCALE_MIN)})`);
  });

  it('节点坐标是布局后坐标（列宽 120 的整数倍，不再是 380 网格）', () => {
    const tree = pureTree();
    const nodes = collect(tree, (t, p) => t === 'g' && typeof p['data-anic-node'] === 'string');
    const xs = nodes.map((n) => Number(/translate\(([-\d.]+),/.exec(String(n.transform))?.[1] ?? 'NaN'));
    expect(xs.every((x) => Number.isFinite(x))).toBe(true);
    expect(Math.max(...xs)).toBeLessThan(1520);   // 原布局的最后两列必须消失
    expect(xs.every((x) => x % 120 === 0)).toBe(true);
  });

  it('包围盒写进 DOM：高度 ≤ 原高度 60%，宽高比进入 0.8~3.2', () => {
    const tree = pureTree();
    const svg = collect(tree, (t, p) => t === 'svg' && p['data-anic-graph'] === 'true')[0];
    expect(String(svg?.['data-anic-graph-bounds'])).toBe(
      `${String(layout.bounds.minX)} ${String(layout.bounds.minY)} ${String(layout.bounds.width)} ${String(layout.bounds.height)}`,
    );
    const legacy = legacyBounds(NODES);
    // 压缩率对**全量**数据断言（见 FULL 的注释）。
    const fullLayout = layoutGraph(FULL.nodes, FULL.edges);
    const fullLegacy = legacyBounds(FULL.nodes);
    expect(fullLayout.bounds.height / fullLegacy.height).toBeLessThanOrEqual(0.6);
    expect(fullLayout.bounds.width / fullLayout.bounds.height).toBeGreaterThan(0.8);
    // 上界 3.2：随轮次增长宽高比单调上升（81 轮实测 2.668），固定 2.6 会随仓库年龄假红；
    // 真正防退化的判据是"高度 ≤ 原高 60%"与"单列 ≤ rowsPerColumn"（见 graphLayout.test）。
    expect(fullLayout.bounds.width / fullLayout.bounds.height).toBeLessThan(3.2);
    // 窗口化视图自身的几何仍必须自洽（不能因为换了数据集就放弃对它的检查）。
    expect(Number.isFinite(layout.bounds.height)).toBe(true);
    expect(legacy.height).toBeGreaterThan(0);
  });

  it('交互态画布 = 视口尺寸（否则放大后被 svg 自身宽高裁掉）', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, () => {},
      { viewport: zoomBy(IDENTITY, { x: 0, y: 0 }, 2), size: { width: 900, height: 420 } });
    const svg = collect(tree, (t, p) => t === 'svg' && p['data-anic-graph'] === 'true')[0];
    expect(svg?.width).toBe(900);
    expect(svg?.height).toBe(420);
    expect(svg?.viewBox).toBe('0 0 900 420');
  });

  it('真实挂载后拖拽改变 transform（指针手势真的接线）', () => {
    mountInteractive(() => {});
    const viewport = host.querySelector('[data-anic-graph-viewport]');
    const svg = host.querySelector('svg[data-anic-graph]');
    const world = () => host.querySelector('[data-anic-graph-world]')?.getAttribute('transform') ?? '';
    // 先放大：适配态下整张图已经全部可见，`clampPan` 会把内容居中锁死
    // （这是**正确**行为——全都看得见时拖动没有意义）。要验证拖拽链路必须
    // 先进入"内容大于视口"的状态，否则测到的是钳制的正确拒绝，不是手势接线。
    act(() => {
      svg?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      svg?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      svg?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    const before = world();
    expect(before).not.toBe('');
    act(() => {
      viewport?.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
      viewport?.dispatchEvent(new PointerEvent('pointermove', { clientX: 160, clientY: 140, bubbles: true }));
      viewport?.dispatchEvent(new PointerEvent('pointerup', { clientX: 160, clientY: 140, bubbles: true }));
    });
    expect(world()).not.toBe(before); // 平移真的进了 transform
    unmount();
  });

  it('反向自检：edge 端点若仍用快照坐标，至少一端坐标与布局后不同', () => {
    const byId = new Map(NODES.map((n) => [n.id, n]));
    const placed = new Map(layout.nodes.map((n) => [n.id, n]));
    // 找一条两端**都不是**首个节点（首个节点在两种布局下恰好都是 0,0，无判别力）
    const e = EDGES.find((x) => {
      const a = byId.get(x.from);
      const b = byId.get(x.to);
      return a !== undefined && b !== undefined && (a.x !== 0 || a.y !== 0) && (b.x !== 0 || b.y !== 0);
    });
    expect(e).toBeDefined();
    expect([byId.get(e?.from ?? '')?.x, byId.get(e?.from ?? '')?.y])
      .not.toEqual([placed.get(e?.from ?? '')?.x, placed.get(e?.from ?? '')?.y]);
  });
});

describe('⑦ stub-hooks 兼容性（smoke 的硬前提，源码级守卫）', () => {
  /**
   * `scripts/offline-smoke.mjs` 的 React 桩只提供这七个 API。任何新 hook
   * （`useMemo` / `useReducer` / `useId` / `useLayoutEffect`）都会让整棵组件树
   * 在 smoke 里 **TypeError** —— 而 smoke 是唯一在"无宿主"条件下验证组件能展开的层。
   *
   * 为什么必须在源码层守而不是靠"跑一次 smoke 看看"：
   * ① smoke 目前走 `GraphSection → renderGraph`，**还没有接线 GraphInteractive**
   *    （那是装配层的事），所以"跑 smoke"今天不会碰到本组件；
   * ② 等它接线之后，一次误用 `useMemo` 的失败信息是 `Cannot read properties of
   *    null (reading 'useMemo')`，与"组件逻辑错"极难区分，且报在冒烟层而非这里。
   * 先在源码层钉死允许集，这类回归在**本次编辑**就红。
   */
  const STUB_HOOKS = new Set([
    'useState', 'useRef', 'useCallback', 'useEffect', 'memo',
    'useSyncExternalStore', 'useDeferredValue',
  ]);

  /**
   * 图区源码文件集（⑦ 的扫描域）。
   *
   * cycle-83 教训（本仓第三次同族）：**扫描域必须由"源码在哪"决定，不能手工枚举**。
   * 旧实现是 9 个写死的文件名；cycle-83 的视觉升级把图区拆成 15 个新文件，
   * 手工清单立刻变成"漏扫 15 个文件"——那等于给新代码开了后门：它们用 `useMemo`
   * 也不会红，直到某天 smoke 在冒烟层 TypeError。
   *
   * 所以改成**目录递归全量**：`src/client/features/graph/` 下所有 `.ts` 都在扫描域内。
   * 这条与 `panelAssemblyContract` 腿1 / `panelDataLegContract` / `isolationScan` 的
   * 修法是同一个（前两次的注释里都写着"防止未来再拆走时静默漏扫"）。
   */
  const GRAPH_DIR = join(ROOT, 'src', 'client', 'features', 'graph');
  const GRAPH_FILES = (() => {
    const names: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
        names.push(full.startsWith(GRAPH_DIR) ? full.slice(GRAPH_DIR.length + 1).split('\\').join('/') : e.name);
      }
    };
    walk(GRAPH_DIR);
    return names.sort();
  })();

  /** 图区源码的**去注释文本**（一次读齐：自定义 hook 可能定义在被 import 的另一个文件）。 */
  const strippedOf = (file: string): string => {
    const raw = readFileSync(join(ROOT, 'src', 'client', 'features', 'graph', file), 'utf8');
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  };

  /**
   * 全图区共享的自定义 hook 名集合。
   *
   * 必须**跨文件**收集：`useViewportGestures` 定义在 graphGestures.ts、调用在
   * GraphInteractive.ts。只按单文件判定会把它当成"未知 hook"误报——而放宽成
   * "凡 use 开头都忽略"又等于没有守卫。跨文件取定义，才是这两者的中间那条线。
   */
  const LOCAL_HOOKS = new Set(
    GRAPH_FILES.flatMap((f) =>
      [...strippedOf(f).matchAll(/\b(?:function|const|let)\s+(use[A-Z][A-Za-z]*)\s*[=(]/g)]
        .map((m) => m[1] ?? ''),
    ),
  );

  /**
   * 图目录**之外**的自定义 hook：按「底层是否只由 stub 支持的 hook 组成」解析。
   *
   * ## 为什么需要这一层（cycle-83 把扫描域递归到全目录后立刻暴露的真缺口）
   *
   * 递归扫描域后 `GraphSection.ts` 被纳入（它本来就该被纳入——smoke 渲染的就是它）。
   * 它调用 `usePanelSlice`，而它定义在 `src/client/components/panelStore.ts`，
   * 不在图目录里 ⇒ 被判成"未知 hook"。
   *
   * ## 两种错误修法，与唯一正确修法
   *
   *   ✗ 把 `usePanelSlice` 塞进 `STUB_HOOKS` —— 那是**撒谎**：smoke 桩里根本没这个名字，
   *     允许集的定义是"stub 提供的 API"，往里加私有 hook 会让这条守卫从此失去意义
   *     （下一个私有 hook 也能这么加）。
   *   ✗ 把 `GraphSection.ts` 从扫描域剔除 —— 那是**挖洞**：它恰恰是 smoke 真正渲染的组件。
   *   ✓ 解析它的**定义体**：`usePanelSlice` 内部只用 `useCallback` + `useSyncExternalStore`，
   *     两者都在 stub 里 ⇒ 它是**安全的下层组合**，不是"未知风险"。
   *
   * 判据于是变成真正的意图：**这份代码最终落到 stub 支持的 API 上吗？**
   * 传递解析（带深度上限 + 找不到定义即 fail-closed）是这条判据的直接实现。
   */
  function resolveComposedHook(hook: string, depth = 0): boolean {
    if (depth > 4) return false; // 组合链过深 = 无法静态确证 ⇒ fail-closed
    const root = join(ROOT, 'src', 'client');
    const queue: string[] = [root];
    while (queue.length > 0) {
      const dir = queue.pop() as string;
      let entries: Array<{ name: string; isDir: boolean }> = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDir) { queue.push(full); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const src = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const def = src.match(new RegExp(`\\b(?:function|const|let)\\s+${hook}\\s*[<=(:]`));
        if (def === null) continue;
        // 取定义起始处之后一段（120 行足够覆盖任何 useXxx 实现体）。
        const body = src.slice(def.index ?? 0).split('\n').slice(0, 120).join('\n');
        for (const m of body.matchAll(/\b(use[A-Za-z]+)\s*\(/g)) {
          const inner = m[1] as string;
          if (inner === hook || STUB_HOOKS.has(inner) || LOCAL_HOOKS.has(inner)) continue;
          if (!resolveComposedHook(inner, depth + 1)) return false;
        }
        return true; // 该 hook 的体只落到 stub 支持的 API 上
      }
    }
    return false; // 找不到定义 ⇒ 无法确证 ⇒ fail-closed
  }

  /** 抽某文件的全部 hook 调用（剔除图内自定义 hook 与已确证的下层组合 hook）。 */
  function hooksUsedIn(file: string): string[] {
    return [...new Set([...strippedOf(file).matchAll(/\b(use[A-Za-z]+|memo)\s*\(/g)].map((m) => m[1] ?? ''))]
      .filter((h) => !LOCAL_HOOKS.has(h))
      .filter((h) => STUB_HOOKS.has(h) || !resolveComposedHook(h));
  }

  it('图区全部源码只使用 stub 支持的 hooks', () => {
    // 反向自检（先跑）：自定义 hook 必须真的被识别出来，否则上面的 filter 是空操作
    expect(LOCAL_HOOKS.has('useViewportGestures')).toBe(true);
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of GRAPH_FILES) {
      const used = hooksUsedIn(f);
      scanned += 1;
      for (const h of used) if (!STUB_HOOKS.has(h)) offenders.push(`${f}: ${h}`);
    }
    expect(scanned).toBe(GRAPH_FILES.length); // 扫描集非空下限
    expect(offenders).toEqual([]);
  });

  it('反向自检：抽取器确实能发现未列入允许集的 hook', () => {
    // 拼接构造样例（不匹配自身文件）
    const sample = ['const m = ', 'useMemo', '(() => 1);'].join('');
    const found = [...sample.matchAll(/\b(use[A-Za-z]+|memo)\s*\(/g)].map((m) => m[1] ?? '');
    expect(found).toEqual(['useMemo']);
    expect(STUB_HOOKS.has('useMemo')).toBe(false);
    // 而被允许的必须能通过同一条判定
    expect(STUB_HOOKS.has('useState')).toBe(true);
  });

  it('反向自检：真的往源码里塞一个 useMemo，判定式必须报红', () => {
    const fake = ['export const x = ', 'useReducer', '(f, 0);'].join('');
    const used = [...fake.matchAll(/\b(use[A-Za-z]+|memo)\s*\(/g)].map((m) => m[1] ?? '');
    expect(used.filter((h) => !STUB_HOOKS.has(h))).toEqual(['useReducer']);
  });
});

describe('⑧ CSS 侧兜底（reduced-motion / forced-colors / focus-visible）', () => {
  it('图区样式锚在 [data-anic-graph-*] 下，且两档媒体查询在场', () => {
    expect(PANEL_CSS).toContain('[data-anic-graph-viewport]');
    expect(PANEL_CSS).toContain('[data-anic-graph-chip]');
    const reduced = PANEL_CSS.slice(PANEL_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('[data-anic-graph-viewport]');
    expect(reduced).toContain('transition: none');
    const forced = PANEL_CSS.slice(PANEL_CSS.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('[data-anic-visibility="filtered"]'.replace(/"/g, "'"));
  });

  it('反向自检：从 CSS 删掉图区块，上面的断言必须红', () => {
    const broken = PANEL_CSS.split('[data-anic-graph-viewport]').join('');
    expect(broken.includes('[data-anic-graph-viewport]')).toBe(false);
  });
});
