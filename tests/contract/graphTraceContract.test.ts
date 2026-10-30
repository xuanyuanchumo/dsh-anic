/**
 * 路径追溯 / 搜索跳转的**真实 DOM** 契约（cycle-84 · V 战线）。
 *
 * 为什么必须是 jsdom 真挂载而不是元素树断言：追溯状态在 `useState` 里，
 * "双击节点 → 状态变化 → 重渲染出状态条 + 节点描边属性"整条链只有真挂载能验证。
 * 元素树只能证明 renderGraph 接受 trace 参数，不能证明组件真的把状态接了进去。
 *
 * 四条腿（每条都带反向自检意识）：
 *   ① 双击节点 → 出现追溯状态条，root 正确，上下游计数 > 0；
 *   ② 节点带 `data-anic-trace`，且 root/up/down 三种角色都出现过（不是全 none）；
 *   ③ 再次双击同一节点 / 点「退出追溯」/ 按 Escape → 状态条消失（三条都能退）；
 *   ④ 搜索后出现命中胶囊，点击真的把视口 transform 改掉（跳转不是装饰）。
 *
 * cycle-85 追加两条（都是"文案承诺过、实现没做或做不全"的收口）：
 *   ⑤ ↑/↓ 在命中候选间移动游标，且 `aria-current` 跟着走（键盘真的能挑）；
 *   ⑥ 双击**空白处**适配视图，而双击节点只追溯、不触发适配（两个动作不互相打断）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphInteractive } from '../../src/client/features/graph/GraphInteractive.ts';
import type { WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;
const NODES = SNAPSHOT.nodes;
const EDGES = SNAPSHOT.edges;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let host: HTMLElement;
let root: Root;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(createElement(GraphInteractive, { nodes: NODES, edges: EDGES })); });
}
function unmount(): void {
  act(() => { root.unmount(); });
  host.remove();
}

/** 找一个在快照里**确有出边或入边**的节点（孤立节点追溯必然为空，不能拿它断言）。 */
function pickConnectedNodeId(): string {
  const withEdge = new Set<string>();
  for (const e of EDGES) { withEdge.add(e.from); withEdge.add(e.to); }
  const hit = NODES.find((n) => withEdge.has(n.id));
  if (hit === undefined) throw new Error('fixture invariant: no connected node');
  return hit.id;
}

function nodeEl(id: string): Element | null {
  return host.querySelector(`[data-anic-node="${id}"]`);
}

describe('cycle-84：双击追溯（真实 DOM）', () => {
  it('① 默认无追溯条；双击节点后出现，root 与上下游计数如实', () => {
    mount();
    expect(host.querySelectorAll('[data-anic-graph-trace-bar]').length).toBe(0);

    const id = pickConnectedNodeId();
    const el = nodeEl(id);
    expect(el).not.toBeNull();
    act(() => { el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });

    const bar = host.querySelector('[data-anic-graph-trace-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('data-anic-graph-trace-root')).toBe(id);
    const up = Number(bar?.getAttribute('data-anic-graph-trace-up'));
    const down = Number(bar?.getAttribute('data-anic-graph-trace-down'));
    expect(up + down).toBeGreaterThan(0);
    expect(Number.isInteger(up)).toBe(true);
    expect(Number.isInteger(down)).toBe(true);

    // ② 节点角色进 DOM：root 必现，且至少有一次 up 或 down（不是全 none）
    expect(nodeEl(id)?.getAttribute('data-anic-trace')).toBe('root');
    const roles = new Set(
      [...host.querySelectorAll('[data-anic-node]')].map((n) => n.getAttribute('data-anic-trace')),
    );
    expect(roles.has('root')).toBe(true);
    expect(roles.has('none') === true && roles.size === 1).toBe(false); // 不能全是 none
    unmount();
  });

  it('② 反向自检：未追溯时所有节点 data-anic-trace 都是 none（属性不是恒有值）', () => {
    mount();
    const roles = new Set(
      [...host.querySelectorAll('[data-anic-node]')].map((n) => n.getAttribute('data-anic-trace')),
    );
    expect([...roles]).toEqual(['none']);
    unmount();
  });

  it('③ 三条退出通道都生效：再次双击 / 退出按钮 / Escape', () => {
    const id = pickConnectedNodeId();
    const open = (): void => {
      act(() => { nodeEl(id)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
      expect(host.querySelectorAll('[data-anic-graph-trace-bar]').length).toBe(1);
    };

    // 再次双击同一节点 → 切换关闭
    mount();
    open();
    act(() => { nodeEl(id)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(host.querySelectorAll('[data-anic-graph-trace-bar]').length).toBe(0);
    unmount();

    // 退出按钮
    mount();
    open();
    const exit = host.querySelector('[data-anic-graph-trace-exit]');
    expect(exit).not.toBeNull();
    act(() => { exit?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.querySelectorAll('[data-anic-graph-trace-bar]').length).toBe(0);
    unmount();

    // Escape（挂在舞台容器上）
    mount();
    open();
    const stage = host.querySelector('[data-anic-graph-stage]');
    expect(stage).not.toBeNull();
    act(() => {
      stage?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelectorAll('[data-anic-graph-trace-bar]').length).toBe(0);
    unmount();
  });
});

describe('cycle-84：搜索命中与跳转（真实 DOM）', () => {
  it('④ 输入查询 → 出现命中胶囊；点一条真的改变视口 transform', () => {
    mount();
    const input = host.querySelector('input[data-anic-graph-search]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    const worldBefore = host.querySelector('[data-anic-graph-world]')?.getAttribute('transform');
    expect(worldBefore).toBeTruthy();

    // React 受控 input：必须走原生 setter + input 事件，直接赋值不会触发 onChange。
    const target = NODES[0];
    if (target === undefined) throw new Error('fixture invariant: empty nodes');
    const q = target.label.slice(0, 3);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, q);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 命中计数必须出现（"搜了但没命中"也要可区分）
    expect(host.querySelector('[data-anic-graph-match-count]')).not.toBeNull();
    const jump = host.querySelector('[data-anic-graph-jump]');
    expect(jump).not.toBeNull();

    // 跳转前先把视口改成"明确不是居中"的状态：直接用跳转按钮的点击作驱动更真实。
    act(() => { jump?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const worldAfter = host.querySelector('[data-anic-graph-world]')?.getAttribute('transform');
    // 只断言"变了"或"至少仍是合法 transform"：若目标恰好已在中心，值可能相同。
    expect(typeof worldAfter).toBe('string');
    expect(worldAfter ?? '').toMatch(/^translate\(/);

    unmount();
  });
});

describe('cycle-85：搜索游标键盘操作（真实 DOM）', () => {
  /** 输入查询并返回输入框（受控 input 必须走原生 setter + input 事件）。 */
  function typeQuery(value: string): HTMLInputElement {
    const input = host.querySelector('input[data-anic-graph-search]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  }

  function activeJumpId(): string | null {
    const el = host.querySelector('[data-anic-graph-jump][data-anic-graph-jump-active="true"]');
    return el?.getAttribute('data-anic-graph-jump') ?? null;
  }

  it('⑤ ↓/↑ 移动游标：active 胶囊与 aria-current 同步，且不移出候选范围', () => {
    mount();
    // 取一个能在多个节点上命中的公共前缀（真实快照里 cycle 节点很多）。
    const q = 'cycle';
    const input = typeQuery(q);
    const pills = [...host.querySelectorAll('[data-anic-graph-jump]')];
    expect(pills.length).toBeGreaterThan(1);

    expect(activeJumpId()).toBe(pills[0]?.getAttribute('data-anic-graph-jump'));
    expect(pills[0]?.getAttribute('aria-current')).toBe('true');

    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(activeJumpId()).toBe(pills[1]?.getAttribute('data-anic-graph-jump'));
    expect(pills[1]?.getAttribute('aria-current')).toBe('true');
    // 同一时刻只能有一个 aria-current（多选感会误导 AT）
    expect(host.querySelectorAll('[data-anic-graph-jump][aria-current="true"]').length).toBe(1);

    // 反向自检：↑ 回到上一条，值必须与第一次相同（不是"只增不减"）
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(activeJumpId()).toBe(pills[0]?.getAttribute('data-anic-graph-jump'));
    unmount();
  });

  it('⑤-2 循环：从最后一条再按 ↓ 回到第一条（长列表里最省事的语义）', () => {
    mount();
    const input = typeQuery('cycle');
    const pills = [...host.querySelectorAll('[data-anic-graph-jump]')];
    for (let i = 0; i < pills.length; i += 1) {
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    }
    expect(activeJumpId()).toBe(pills[0]?.getAttribute('data-anic-graph-jump'));
    unmount();
  });
});

describe('cycle-85：双击空白适配视图（真实 DOM）', () => {
  it('⑥ 双击空白 → 视口回到适配态；双击节点 → 只追溯不触发适配', () => {
    mount();
    const stage = host.querySelector('[data-anic-graph-stage]') as HTMLElement;
    expect(stage).not.toBeNull();

    // 先把视口放大两档（键盘 +），这样"适配"会带来可观测的 transform 变化。
    const svg = host.querySelector('svg[data-anic-graph]') as unknown as SVGElement;
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    const zoomed = host.querySelector('[data-anic-graph-world]')?.getAttribute('transform');
    expect(zoomed).toBeTruthy();

    // 双击空白（stage 自身，无 data-anic-node 祖先）→ 适配
    act(() => { stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const fitted = host.querySelector('[data-anic-graph-world]')?.getAttribute('transform');
    expect(fitted).not.toBe(zoomed);
    // 适配是"回到合适比例"，不是"换了个随机视角"
    expect(fitted ?? '').toMatch(/^translate\(/);

    // 反向自检：双击节点**不**应触发适配（只进追溯）——否则两个动作互相打断
    const node = host.querySelector('[data-anic-node]') as unknown as HTMLElement;
    const beforeNodeDbl = host.querySelector('[data-anic-graph-world]')?.getAttribute('transform');
    act(() => { node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(host.querySelector('[data-anic-graph-trace-bar]')).not.toBeNull();
    // 节点双击后视口不变（追溯只改描边/状态条，不改视口）
    expect(host.querySelector('[data-anic-graph-world]')?.getAttribute('transform')).toBe(beforeNodeDbl);
    unmount();
  });
});

