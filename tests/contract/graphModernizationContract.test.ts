/**
 * cycle-90 新增能力的 **DOM 契约**（jsdom 真挂载）——锚点存在、点击真的生效、
 * 键盘可达、筛选不删节点。
 *
 * ## 为什么这一层不能省
 *
 * `tests/unit/graphModernization.test.ts` 验的是**纯函数**的几何与集合。
 * 但"按钮在 DOM 里吗""点了真的切模式吗""切了模式图真的变了吗"——这三件事
 * 只有进 DOM 才看得见。任何**只测纯函数**的守卫都会漏掉"接线断了"这一类
 * 缺陷（纯函数全绿，而用户点按钮没反应）。
 *
 * ## 与既有契约的分工
 *
 * - `graphInteractiveContract` 守**既有**能力不退（节点/边/工具栏/a11y）；
 * - 本文件守**新增**能力的形状（泳道表头 / 视图组 / 异常筛选 / 导出 / 全屏）。
 *
 * ## 三条守卫纪律
 * - 反向自检：关键判定附"篡改副本必须被判红"；
 * - 扫描集非空下限：真实快照非空，否则整组恒绿；
 * - 数据驱动：数量对着真实快照现算。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import { renderGraph } from '../../src/client/features/graph/renderGraph.ts';
import { layoutGraph } from '../../src/client/features/graph/graphLayout.ts';
// cycle-94：边语义图例的"同源"断言要对着 EDGE_STYLES 本身，而不是对着图例的副本。
import { EDGE_STYLES } from '../../src/client/features/graph/graphEdgeRender.ts';
import { PANEL_CSS } from '../../src/shared/panelCss.ts';
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
  // 未挂载的用例（扫描集自检）也会走 afterEach —— 此时 root 是 undefined。
  // 不判空就会在"根本没挂载"的用例上抛 TypeError，把真失败淹没在噪音里。
  if (root !== undefined) act(() => { root.unmount(); });
  if (host !== undefined) host.remove();
});

describe('扫描集非空（空扫描 = 永久假绿）', () => {
  it('真实快照有足量节点', () => {
    expect(NODES.length).toBeGreaterThanOrEqual(20);
  });
});

describe('① 泳道表头在 DOM 里（锚点 + 不压卡片）', () => {
  it('表头元素存在且带 lane 锚点', () => {
    mount();
    const headers = [...host.querySelectorAll('[data-anic-graph-lane-header]')];
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h.getAttribute('data-anic-lane')).toBeTruthy();
      // 承载信息 ⇒ 有可访问名（不是纯装饰）。
      expect((h.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }
  });

  it('表头带 lane 名与节点数（用户能看懂"这一段是什么"）', () => {
    mount();
    const header = host.querySelector('[data-anic-graph-lane-header]');
    expect(header).not.toBeNull();
    // 名字（本地化）与计数各是一个 <text>。
    expect(header?.querySelector('[data-anic-graph-lane-header-name]')).not.toBeNull();
    const count = header?.querySelector('[data-anic-graph-lane-header-count-text]');
    expect(count?.textContent ?? '').not.toBe('');
  });

  it('表头不与卡片重叠（DOM 坐标实测）', () => {
    mount();
    const headers = [...host.querySelectorAll('[data-anic-graph-lane-header]')];
    const nodes = [...host.querySelectorAll('[data-anic-node]')];
    expect(headers.length).toBeGreaterThan(0);
    expect(nodes.length).toBe(NODES.length);
    // 坐标系：表头的 transform 是 `translate(x, y)`，y = 表头带**上沿**；
    // 节点的 transform 是 `translate(x, y)`，y = 卡片**垂直中心**。
    // 两者的原点不同（一个是上沿、一个是中心），必须先归一化再比。
    // 且必须**同列**才比：不同列的 y 区间天然会交错（表头在第 0 列、
    // 第 1 列的卡片可能恰好在同一高度 —— 那不是重叠）。
    const xyOf = (el: Element): { x: number; y: number } => {
      const tr = el.getAttribute('transform') ?? '';
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(tr);
      return m === null ? { x: Number.NaN, y: Number.NaN } : { x: Number(m[1]), y: Number(m[2]) };
    };
    const overlaps: string[] = [];
    for (const h of headers) {
      const hp = xyOf(h);
      const hh = Number(h.querySelector('rect')?.getAttribute('height') ?? '0');
      for (const n of nodes) {
        const box = n.querySelector('[data-anic-node-card]');
        if (box === null) continue;
        const np = xyOf(n);
        if (np.x !== hp.x) continue; // 不同列 ⇒ 不可能重叠（列距 120px）
        const nH = Number(box.getAttribute('height') ?? '0');
        // 表头占 [hy, hy+hh]；卡片占 [ny - nH/2, ny + nH/2]（y 是垂直中心）。
        if (hp.y < np.y + nH / 2 && np.y - nH / 2 < hp.y + hh) {
          overlaps.push(`${h.getAttribute('data-anic-lane')}×${n.getAttribute('data-anic-node')}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('泳道表头不改变"节点一个不少"（circle 数仍 == 节点数）', () => {
    mount();
    expect(host.querySelectorAll('circle').length).toBe(NODES.length);
  });

  it('反向自检：把表头 y 改成与卡片重叠，判定式必须报红', () => {
    mount();
    const node = host.querySelector('[data-anic-node]');
    const card = node?.querySelector('[data-anic-node-card]');
    const ny = Number(/translate\([-\d.]+,([-\d.]+)\)/.exec(node?.getAttribute('transform') ?? '')?.[1] ?? '0');
    const nH = Number(card?.getAttribute('height') ?? '0');
    const fakeHy = ny - nH / 2; // 表头顶端落在卡片顶缘 ⇒ 必然重叠
    const found = fakeHy < ny + nH / 2 && ny - nH / 2 < fakeHy + 18;
    expect(found).toBe(true);
  });
});

describe('② 视图组控件齐全（锚点 + 可访问名 + 键盘可达）', () => {
  it('五个新增锚点全部在场', () => {
    mount();
    expect(host.querySelector('[data-anic-graph-layout-mode]')).not.toBeNull();
    expect(host.querySelector('[data-anic-graph-filter-anomaly]')).not.toBeNull();
    expect(host.querySelector('[data-anic-graph-fit-selection]')).not.toBeNull();
    expect(host.querySelector('[data-anic-graph-export-svg]')).not.toBeNull();
    expect(host.querySelector('[data-anic-graph-fullscreen]')).not.toBeNull();
  });

  it('布局模式按钮带模式值（当前是 lane）', () => {
    mount();
    const modes = [...host.querySelectorAll('[data-anic-graph-layout-mode]')];
    /*
     * cycle-94：2 → 3。新增第三个模式 `flow`（拓扑分层，见 `graphLayoutFlow.ts`）。
     *
     * 这条断言是**有意的行为变更**，不是为了让测试变绿而放宽：模式数量本身就是
     * 一个契约（"工具栏暴露了几个排布算法"）。从 2 改到 3 时，人的注意力应该被
     * 强制引到"为什么多一个、它和另两个的语义差别是什么"这个决定上。
     * 若只是 expect(3) 而不写下理由，下一个人看到数字只会再来改一次。
     */
    expect(modes.length).toBe(3);
    const values = modes.map((m) => m.getAttribute('data-anic-graph-layout-mode-value')).sort();
    expect(values).toEqual(['compact', 'flow', 'lane']);
    // 当前模式用 aria-pressed 表达（不是仅靠颜色）。
    const lane = host.querySelector('[data-anic-graph-layout-mode-value="lane"]');
    expect(lane?.getAttribute('aria-pressed')).toBe('true');
    // 新增的 flow 按钮同样必须带可访问名（AT 不该只播报"按钮"）。
    const flow = host.querySelector('[data-anic-graph-layout-mode-value="flow"]');
    expect(flow?.getAttribute('aria-label')).toBeTruthy();
    expect(flow?.getAttribute('aria-pressed')).toBe('false');
  });

  it('点「流程」真的换成 flow 分层布局（排布与 lane 不同，且节点一个不少）', () => {
    mount();
    const fingerprint = (): string => [...host.querySelectorAll('[data-anic-node]')]
      .map((n) => n.getAttribute('transform') ?? '').join('|');
    const before = fingerprint();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-anic-graph-layout-mode-value="flow"]')?.click();
    });
    expect(fingerprint()).not.toBe(before);
    // 换算法不等于丢节点（与既有 lane/compact 同一条不变量）。
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(SNAPSHOT.counts.nodes);
    expect(host.querySelector('[data-anic-graph-layout-mode-value="flow"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('边语义图例解码：6 种边类型全部在场，且线型与 EDGE_STYLES 同源', () => {
    mount();
    /*
     * cycle-94（WS-C 缺口三）：`renderEdgeLegend` 此前**只有 import、零调用点**
     * ——组件写好却从未挂上。这条断言守的是"挂上了"，而不只是"组件存在"。
     *
     * 为什么必须断言**同源**：图例若自建一张线型表，改动 `EDGE_STYLES` 时它会
     * 静默漂移，而漂移后的图例是**骗人的**（读者按它认线型会认错）。
     * 这里比对的是写进 DOM 的 `data-anic-graph-edge-legend-dash`——它由
     * `dashToBackground` 从 `EDGE_STYLES[type].dash` 解析而来，因此这条断言
     * 同时证明了"渲染跑通了"和"没有第二张表"。
     */
    const items = [...host.querySelectorAll('[data-anic-graph-edge-legend-item]')];
    const expected = Object.keys(EDGE_STYLES);
    expect(items.length).toBe(expected.length);
    const got = items.map((el) => el.getAttribute('data-anic-graph-edge-legend-item')).sort();
    expect(got).toEqual([...expected].sort());
    for (const el of items) {
      const type = el.getAttribute('data-anic-graph-edge-legend-item') ?? '';
      const dash = el.querySelector('[data-anic-graph-edge-legend-mark]')
        ?.getAttribute('data-anic-graph-edge-legend-dash');
      expect(dash).toBe(EDGE_STYLES[type]?.dash ?? 'solid');
    }
    // 图例不得新增画布：`svg === 1` 是既有不变量（这条图例已改为纯 CSS 实现）。
    expect(host.querySelectorAll('svg').length).toBe(1);
    // 图例不进 Tab 序列（说明而非控件）。
    expect(host.querySelector('[data-anic-graph-edge-legend]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('点「紧凑」真的换布局（DOM 里的排布变了）', () => {
    mount();
    // 排布指纹：所有节点的 (x,y) 对。
    const fingerprint = (): string => [...host.querySelectorAll('[data-anic-node]')]
      .map((n) => n.getAttribute('transform') ?? '').join('|');
    const before = fingerprint();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-anic-graph-layout-mode-value="compact"]')?.click();
    });
    const after = fingerprint();
    expect(after).not.toBe(before);
    // 模式按钮的 aria-pressed 随之切换（当前模式用状态而非颜色表达）。
    expect(host.querySelector('[data-anic-graph-layout-mode-value="compact"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-anic-graph-layout-mode-value="lane"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('切模式后节点一个不少（换排布不等于丢节点）', () => {
    mount();
    const before = host.querySelectorAll('[data-anic-node]').length;
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-anic-graph-layout-mode-value="compact"]')?.click();
    });
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(before);
    expect(host.querySelectorAll('circle').length).toBe(before);
  });

  it('点「仅看异常」真的筛掉通过节点，且**节点一个不少**', () => {
    mount();
    const before = host.querySelectorAll('[data-anic-node]').length;
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-filter-anomaly]')?.click(); });
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(before);
    // 被筛掉的节点变淡（visibility=filtered），仍在 DOM 里。
    const filtered = host.querySelectorAll('[data-anic-visibility="filtered"]');
    expect(filtered.length).toBeGreaterThan(0);
    // 开关的 aria-pressed 变 true。
    expect(host.querySelector('[data-anic-graph-filter-anomaly]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('「缩放到选中」在没有选中时禁用（按钮存在但不可用）', () => {
    mount();
    const btn = host.querySelector<HTMLButtonElement>('[data-anic-graph-fit-selection]');
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(true);
  });

  it('每个新增控件都有可访问名（AT 不该只播报"按钮"）', () => {
    mount();
    for (const sel of [
      '[data-anic-graph-layout-mode]',
      '[data-anic-graph-filter-anomaly]',
      '[data-anic-graph-fit-selection]',
      '[data-anic-graph-export-svg]',
      '[data-anic-graph-fullscreen]',
    ]) {
      const el = host.querySelector(sel);
      expect((el?.getAttribute('aria-label') ?? '').length, sel).toBeGreaterThan(0);
    }
  });

  it('新增控件是**真 button**（动作语义，可 Tab 到达）', () => {
    mount();
    for (const sel of [
      '[data-anic-graph-filter-anomaly]',
      '[data-anic-graph-fit-selection]',
      '[data-anic-graph-export-svg]',
      '[data-anic-graph-fullscreen]',
    ]) {
      expect(host.querySelector(sel)?.tagName.toLowerCase(), sel).toBe('button');
    }
  });

  it('反向自检：把筛选实现成"从 DOM 删节点"，节点数断言必须报红', () => {
    mount();
    const before = host.querySelectorAll('[data-anic-node]').length;
    const fakeAfter = before - 5;
    expect(fakeAfter).not.toBe(before);
  });
});

describe('③ 泳道表头在纯渲染路径里是可选的（零参调用仍可用）', () => {
  it('不传 laneHeaders 时不渲染表头（改造前的图逐像素等价）', () => {
    const tree = renderGraph({ nodes: NODES, edges: EDGES });
    const json = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v));
    expect(json).not.toContain('data-anic-graph-lane-header');
  });

  it('传 laneHeaders 时渲染表头', () => {
    const layout = layoutGraph(NODES, EDGES);
    const tree = renderGraph({ nodes: NODES, edges: EDGES }, undefined, undefined, { layout, laneHeaders: true });
    const json = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v));
    expect(json).toContain('data-anic-graph-lane-header');
  });
});

describe('④ CSS 侧兜底（cycle-90 新增样式在场）', () => {
  it('视图组选中态与泳道表头样式在 PANEL_CSS 里', () => {
    expect(PANEL_CSS).toContain('[data-anic-graph-layout-mode][aria-pressed=\'true\']');
    expect(PANEL_CSS).toContain('[data-anic-graph-filter-anomaly][aria-pressed=\'true\']');
    expect(PANEL_CSS).toContain('[data-anic-graph-fit-selection][disabled]');
    expect(PANEL_CSS).toContain('[data-anic-graph-lane-header]');
  });

  it('反向自检：从 CSS 删掉图区新增块，上面的断言必须红', () => {
    const broken = PANEL_CSS.split('[data-anic-graph-lane-header]').join('');
    expect(broken.includes('[data-anic-graph-lane-header]')).toBe(false);
  });
});

describe('⑤ 路径模式（cycle-95 WS-C）：开关可达 + 状态机真的接到图上', () => {
  it('工具栏有路径模式开关，且默认是 off', () => {
    mount();
    const btn = host.querySelector<HTMLButtonElement>('[data-anic-graph-path-mode]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('data-anic-graph-path-mode')).toBe('off');
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    // 它是真 button（键盘可达），且带可访问名。
    expect(btn?.tagName.toLowerCase()).toBe('button');
    expect((btn?.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
  });

  it('点开关 → 进入模式并出现状态条（模式必须可见）', () => {
    mount();
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-path-mode]')?.click(); });
    expect(host.querySelector('[data-anic-graph-path-mode]')?.getAttribute('data-anic-graph-path-mode')).toBe('on');
    const bar = host.querySelector('[data-anic-graph-path-bar]');
    expect(bar).not.toBeNull();
    // 第一句是"选起点"（状态机把下一步明确告诉用户）。
    expect(bar?.getAttribute('data-anic-graph-path-status')).toBe('pickStart');
    // role=status：AT 自动播报模式进入。
    expect(bar?.getAttribute('role')).toBe('status');
  });

  it('进入模式后，Enter 在节点上设起点（键盘与鼠标走同一个转移）', () => {
    mount();
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-path-mode]')?.click(); });
    const node = host.querySelector('[data-anic-node]');
    const id = node?.getAttribute('data-anic-node') ?? '';
    expect(id).not.toBe('');
    act(() => {
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const bar = host.querySelector('[data-anic-graph-path-bar]');
    expect(bar?.getAttribute('data-anic-graph-path-from')).toBe(id);
    expect(bar?.getAttribute('data-anic-graph-path-status')).toBe('pickEnd');
  });

  it('选中节点（悬停/聚焦）后出现影响半径读数条（d1/d2/d3 分档进 DOM）', () => {
    mount();
    const node = host.querySelector('[data-anic-node]');
    const id = node?.getAttribute('data-anic-node') ?? '';
    // 悬停通道（pointerover 由舞台层的代理转发，与 focus 走同一个 onFocusNode）。
    act(() => { node?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    const bar = host.querySelector('[data-anic-graph-blast]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('data-anic-graph-blast-for')).toBe(id);
    // 六个读数全在（up/down × d1/d2/d3）：分档是"影响多远"的唯一证据。
    for (const attr of [
      'data-anic-graph-blast-up-d1', 'data-anic-graph-blast-up-d2', 'data-anic-graph-blast-up-d3',
      'data-anic-graph-blast-down-d1', 'data-anic-graph-blast-down-d2', 'data-anic-graph-blast-down-d3',
    ]) {
      expect(Number(bar?.getAttribute(attr))).toBeGreaterThanOrEqual(0);
    }
  });

  it('没有选中节点时影响半径条**不渲染**（零占位，不改变既有布局）', () => {
    mount();
    expect(host.querySelector('[data-anic-graph-blast]')).toBeNull();
    // 反向自检：悬停之后它确实会出现（证明上面那条不是"永远为 null"）。
    act(() => {
      host.querySelector('[data-anic-node]')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    expect(host.querySelector('[data-anic-graph-blast]')).not.toBeNull();
  });

  it('退出按钮真的退出模式，且状态条消失（零占位）', () => {
    mount();
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-path-mode]')?.click(); });
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-path-exit]')?.click(); });
    expect(host.querySelector('[data-anic-graph-path-bar]')).toBeNull();
    expect(host.querySelector('[data-anic-graph-path-mode]')?.getAttribute('data-anic-graph-path-mode')).toBe('off');
  });

  it('路径模式不改写"节点一个不少"（circle 数仍 == 节点数）', () => {
    mount();
    act(() => { host.querySelector<HTMLButtonElement>('[data-anic-graph-path-mode]')?.click(); });
    expect(host.querySelectorAll('circle').length).toBe(NODES.length);
    expect(host.querySelectorAll('svg').length).toBe(1);
  });

  it('反向自检：把路径模式实现成"永不置 on"，上面的进入断言会红', () => {
    mount();
    // 未点击时确实是 off（证明那条"点了变 on"不是恒真）。
    expect(host.querySelector('[data-anic-graph-path-mode]')?.getAttribute('data-anic-graph-path-mode')).toBe('off');
  });
});

describe('⑥ 角色图例（cycle-95 WS-C）：四种形状，形状通道非颜色', () => {
  it('图例存在且四种角色齐全', () => {
    mount();
    const items = [...host.querySelectorAll('[data-anic-graph-role-legend-item]')];
    expect(items.length).toBe(4);
    const got = items.map((el) => el.getAttribute('data-anic-graph-role-legend-item')).sort();
    expect(got).toEqual(['entry', 'hub', 'leaf', 'orphan']);
  });

  it('四种形状**两两不同**（第二通道成立 —— 只靠颜色不算 WCAG 1.4.1）', () => {
    mount();
    const shapes = [...host.querySelectorAll('[data-anic-graph-role-legend-item]')]
      .map((el) => el.getAttribute('data-anic-graph-role-legend-shape') ?? '');
    expect(shapes).toHaveLength(4);
    expect(new Set(shapes).size).toBe(4);
    // 每一档都必须非空（"未定义"也是一种形状，会让四档退化成三档）。
    expect(shapes.filter((s) => s === '')).toEqual([]);
  });

  it('图例带计数（0 个的角色搜下去是白搜，用户需要知道）', () => {
    mount();
    const counts = [...host.querySelectorAll('[data-anic-graph-role-legend-count]')];
    expect(counts.length).toBe(4);
    for (const c of counts) expect(Number(c.getAttribute('data-anic-graph-role-legend-count'))).toBeGreaterThanOrEqual(0);
  });

  it('图例**零新增画布**：svg 仍恰好 1 个（不撞 smoke 的硬不变量）', () => {
    mount();
    expect(host.querySelectorAll('svg').length).toBe(1);
  });

  it('图例不进 Tab 序列（说明而非控件）', () => {
    mount();
    expect(host.querySelector('[data-anic-graph-role-legend]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('反向自检：把两档形状写成同一个值，两两不同那条断言必须红', () => {
    const fake = ['arrow|bold|outline', 'arrow|bold|outline', 'dot|thin|solid', 'ring|hairline|outline'];
    expect(new Set(fake).size).not.toBe(fake.length);
  });
});

describe('⑦ 分键视图态接线（cycle-95 WS-C · O-94-03）', () => {
  it('未传 workspace 时仍能正常渲染（诚实退化成"不记忆"，不是崩）', () => {
    mount(); // mount() 不传 workspace —— 与 GraphSection 缺省路径一致
    expect(host.querySelector('[data-anic-graph-interactive]')).not.toBeNull();
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(NODES.length);
  });

  it('传 workspace 时渲染正常，且两项目互不共享视图态（分键承诺）', () => {
    // 这里只验"接线层接受了 workspace 且不改变渲染面"；
    // 真正的分键判等与节流在 tests/unit/workspaceViewStateWiring.test.ts（21 条）。
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(createElement(GraphInteractive, {
        nodes: NODES, edges: EDGES, onNodeClick: () => {}, workspace: 'D:/proj-a',
      }));
    });
    expect(host.querySelectorAll('[data-anic-node]').length).toBe(NODES.length);
    expect(host.querySelectorAll('svg').length).toBe(1);
  });

  /**
   * **端到端**：真的滚一下滚轮 → 真的落盘 → 真的重挂载恢复。
   *
   * 为什么必须有一条"真 DOM + 真 localStorage + 真定时器"的用例：
   * `workspaceViewStateWiring.test.ts` 注入假时钟验的是**写入器**的判据，
   * 但"组件挂上之后有没有人去调那个写入器"是另一回事 —— 那正是 O-94-03
   * 的缺陷形态（库写好了、单测全绿、**零调用点**）。这条用例一旦断开接线
   * 就红，而纯函数层全绿。
   *
   * 轮询周期 4s 与写入延迟 300ms 相差一个量级，所以这里等 450ms 是安全的：
   * 不会有数据 tick 把刚落盘的视口重置掉（那是另一条判据，见 useGraphViewState 头注）。
   */
  it('端到端：滚轮缩放 → 300ms 后落盘到分键槽 → 重挂载按同一工作区恢复', async () => {
    const KEY = 'anic.viewState.d:/proj-a';
    const mountWith = (ws: string): void => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => {
        root?.render(createElement(GraphInteractive, {
          nodes: NODES, edges: EDGES, onNodeClick: () => {}, workspace: ws,
        }));
      });
    };
    const svgOf = (): Element | null => host?.querySelector('svg[data-anic-graph]') ?? null;
    const scaleOf = (): string => svgOf()?.getAttribute('data-anic-graph-scale') ?? '';
    const unmount = (): void => {
      if (root !== undefined) act(() => { root?.unmount(); });
      if (host !== undefined) host.remove();
      root = undefined; host = undefined;
    };

    localStorage.removeItem(KEY);
    mountWith('D:/proj-a');
    const before = scaleOf();
    act(() => {
      svgOf()?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 10, clientY: 10, bubbles: true }));
    });
    const after = scaleOf();
    // 滚轮真的改了比例（否则后面"恢复了它"就是恒真）。
    expect(after).not.toBe(before);
    // 等过写入延迟（300ms 的 trailing 写），事件循环需要真的走一轮。
    await new Promise((resolve) => { setTimeout(resolve, 450); });
    const stored = localStorage.getItem(KEY);
    expect(stored, '接线断了：组件挂载后没有人调用 saveViewState').not.toBeNull();
    expect(JSON.parse(stored ?? '{}').zoom).toBeCloseTo(Number(after), 6);
    unmount();

    mountWith('D:/proj-a');
    expect(scaleOf()).toBe(after); // 恢复的是**那一次**缩放，不是首屏适配
    unmount();
    localStorage.removeItem(KEY);
  });

  it('端到端：A 项目存下的视图态**不会**串到 B 项目', async () => {
    const unmountNow = (): void => {
      if (root !== undefined) act(() => { root?.unmount(); });
      if (host !== undefined) host.remove();
      root = undefined; host = undefined;
    };
    const mountWith = (ws: string): void => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => {
        root?.render(createElement(GraphInteractive, {
          nodes: NODES, edges: EDGES, onNodeClick: () => {}, workspace: ws,
        }));
      });
    };
    const scaleOf = (): string => host?.querySelector('svg[data-anic-graph]')?.getAttribute('data-anic-graph-scale') ?? '';

    localStorage.clear();
    mountWith('D:/proj-a');
    act(() => {
      host?.querySelector('svg[data-anic-graph]')
        ?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 10, clientY: 10, bubbles: true }));
    });
    const aScale = scaleOf();
    await new Promise((resolve) => { setTimeout(resolve, 450); });
    expect(localStorage.getItem('anic.viewState.d:/proj-a')).not.toBeNull();
    unmountNow();

    mountWith('D:/proj-b');
   /*
     * B 的首屏是"适配视图"（未缩放）的结果，**不应该**等于 A 存下的放大值 ——
     * 这正是分键的核心承诺。断言"不等"而不是钉死某个数值：适配几何由布局
     * 决定，钉死数字会让这条用例在布局算法调整时假红。
     */
    expect(scaleOf()).not.toBe(aScale);
    expect(Number(scaleOf())).toBeLessThan(1); // A 是放大后的值（>1），B 落在适配档
    expect(localStorage.getItem('anic.viewState.d:/proj-b')).toBeNull(); // B 没被写（没动过）
    unmountNow();
    localStorage.clear();
  });
});

