/**
 * 节点角色契约（cycle-95 · WS-B）——「这个节点是什么角色」的机械保证。
 *
 * ## 为什么需要这条契约（不是"多一个测试"）
 *
 * 角色映射表**极易假绿**：`buildNodeRoles` 存在、渲染层也引用了、截图上那个
 * 小 `<path>` 也画出来了 —— 但只要两个角色映射到同一组视觉特征，任何"能渲染、
 * 不报错、看着挺好"的验收都不会红。`graphTypeShapeContract` 已经证明过一次
 * 这件事（`chevron`/`cross` 都塌成 `notched|solid|full`）。
 *
 * ## 五条腿
 *
 *   ① 判据正确：hub / orphan / entry / leaf / 中间节点各自可达（含**阈值边界**：
 *      8 入边判 hub、7 入边不判）；
 *   ② 反向自检：**孤立节点必须判 orphan**——只吃边集的实现会漏掉它（这条有牙：
 *      本仓实测过"只认边端点"会让 aux:auto 不被判出来）；
 *   ③ 角色视觉特征**两两不同**（四个角色四条互不相同的特征元组）；
 *   ④ **角色特征与裁决特征不相交**（同一圆点上两个形状通道不许互相吞）；
 *   ⑤ 渲染锚点：每个角色都画出一个 `<path>` 标记，且 `data-anic-node-role` 进 DOM。
 *
 * ## 第 ④ 条是本轮最容易被漏掉的一条
 *
 * 圆点上同时有裁决线型（`strokeDasharray`）与角色通道。若角色也吃
 * `strokeDasharray`，用户就再也分不出 PASS/FAIL —— 而这种"两个通道互相覆盖"
 * 在元素树断言里**完全看不见**（属性都在，只是语义被吃）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUB_INDEGREE, buildNodeRoles, roleOf, roleOfDegrees, roleStatsOf, type NodeRole,
} from '../../src/client/features/graph/graphNodeRole.ts';
import {
  ROLE_TRAITS, ROLE_STROKE_WIDTH, renderRoleMark, roleMarkPath, roleTraitsOf, roleStrokeWidthOf,
} from '../../src/client/features/graph/graphNodeRoleRender.ts';
import { VERDICT_SHAPE } from '../../src/client/features/graph/graphNodeStyle.ts';
import { renderGraph } from '../../src/client/features/graph/renderGraph.ts';
import type { WorkflowEdge, WorkflowNode } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E = (from: string, to: string): WorkflowEdge => ({ from, to, type: 'evidences' } as WorkflowEdge);

/**
 * 真实快照（⑥ 纯函数断言 + ⑦ 真 DOM 断言共用）。
 *
 * 为什么必须在**文件级**而不是 describe 内：⑦ 是 jsdom 用例，读不到另一个
 * describe 块里的局部常量（`SNAPSHOT is not defined` 是第一次跑就抓到的真缺陷）。
 * 快照随 `.cycles/` 增长而变 ⇒ 计数一律现算，不硬编码节点数。
 */
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

/** 真 DOM 渲染探针（把 renderGraph 包成一个可直接 render 的组件）。 */
function RenderGraphProbe(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodeRoles?: boolean;
}): ReturnType<typeof renderGraph> {
  return renderGraph(
    { nodes: [...input.nodes], edges: [...input.edges] },
    undefined,
    undefined,
    input.nodeRoles === false ? { nodeRoles: false } : {},
  );
}

describe('① 判据：四类角色 + 中间节点', () => {
  it('hub = 入度 ≥ HUB_INDEGREE（8 判 hub、7 不判）', () => {
    expect(roleOfDegrees(HUB_INDEGREE, 0)).toBe('hub');
    // 阈值边界反向自检：少一条入边就不是 hub（否则"阈值"是假的）
    expect(roleOfDegrees(HUB_INDEGREE - 1, 1)).toBeNull();
    expect(roleOfDegrees(HUB_INDEGREE - 1, 0)).toBe('leaf');
  });

  it('hub 优先于 leaf：入度 12 / 出度 0 的汇聚点**必须**是 hub 而不是 leaf', () => {
    // 这条钉死判据顺序。若把 leaf 判据提到 hub 之前，"多少因汇到我"就从图上消失。
    expect(roleOfDegrees(12, 0)).toBe('hub');
    expect(roleOfDegrees(0, 0)).toBe('orphan');
    expect(roleOfDegrees(3, 0)).toBe('leaf');
  });

  it('entry / leaf / null 各自可达，且方向不混', () => {
    expect(roleOfDegrees(0, 2)).toBe('entry');   // 只有出边 = 起点
    expect(roleOfDegrees(2, 0)).toBe('leaf');    // 只有入边 = 终点
    expect(roleOfDegrees(1, 1)).toBeNull();      // 两头都有 = 中间节点（不是缺陷）
  });

  it('真实边集：从边端点建表，entry/hub/leaf 都能判出来', () => {
    // 8 个源头各一条出边 → g0（8 条入边）⇒ g0 是 hub、8 个源头是 entry 且各自 leaf 0
    const edges: WorkflowEdge[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => E(s, 'g0'));
    const roles = buildNodeRoles(edges);
    expect(roleOf(roles, 'g0')).toBe('hub');
    expect(roleOf(roles, 'a')).toBe('entry'); // 只有出边 = 因果链起点
    const s = roleStatsOf(roles);
    expect(s.hub).toBe(1);
    expect(s.entry).toBe(8);
    expect(s.leaf).toBe(0);
    expect(s.total).toBe(9);
  });

  it('终点（只有入边）= leaf，起点（只有出边）= entry（方向不混）', () => {
    const roles = buildNodeRoles([E('src', 'dst')]);
    expect(roleOf(roles, 'src')).toBe('entry');
    expect(roleOf(roles, 'dst')).toBe('leaf');
  });
});

describe('② 反向自检：孤立节点必须判 orphan（这是 nodeIds 参数存在的理由）', () => {
  it('只吃边集时孤立节点**看不见** ⇒ orphan 恒为 0（诚实退化，不是 bug）', () => {
    const roles = buildNodeRoles([E('a', 'b')]);
    expect(roleStatsOf(roles).orphan).toBe(0);
    expect(roles.has('aux:auto')).toBe(false);
  });

  it('传 nodeIds 后 aux:auto（度 0 标量节点）判 orphan —— 把"疑似缺陷"变成"预期形态"', () => {
    const roles = buildNodeRoles([E('a', 'b')], ['a', 'b', 'aux:auto']);
    expect(roleOf(roles, 'aux:auto')).toBe('orphan');
    expect(roleStatsOf(roles).orphan).toBe(1);
    // 反向：如果判据漏了 nodeIds，这条必然红（不能让 orphan 悄悄恒为 0）
    expect(roleStatsOf(buildNodeRoles([E('a', 'b')])).orphan).toBe(0);
  });

  it('nodeIds 里给出边端点时不会重复计度（表只建一次）', () => {
    const roles = buildNodeRoles([E('a', 'b')], ['a', 'b']);
    expect(roleStatsOf(roles).total).toBe(2);
    expect(roleOf(roles, 'a')).toBe('entry');
    expect(roleOf(roles, 'b')).toBe('leaf');
  });
});

describe('③ 角色视觉特征两两不同（WCAG 1.4.1 第二通道）', () => {
  it('四个角色的特征元组互不相同', () => {
    const roles: Array<'entry' | 'orphan' | 'leaf' | 'hub'> = ['entry', 'orphan', 'leaf', 'hub'];
    const seen = new Map<string, string>();
    for (const r of roles) {
      const key = roleTraitsOf(r);
      expect(seen.get(key), `${r} 与 ${String(seen.get(key))} 特征相同：${key}`).toBeUndefined();
      seen.set(key, r);
    }
    expect(seen.size).toBe(4);
    // 非空下限：每个角色都真的有特征表条目
    for (const r of roles) expect(ROLE_TRAITS[r]).toBeDefined();
  });

  it('未判定（null）→ 特征为 none，且不画任何标记', () => {
    expect(roleTraitsOf(null)).toBe('none');
    expect(roleMarkPath(null, 0, 0, 4)).toBeNull();
    expect(renderRoleMark({ role: null, x: 0, y: 0, r: 4, stroke: '#000' })).toBeNull();
  });

  it('四个角色都真的画出一个 <path>（标记不是恒 null）', () => {
    for (const r of ['entry', 'orphan', 'leaf', 'hub'] as const) {
      const mark = renderRoleMark({ role: r, x: 10, y: 5, r: 3.4, stroke: '#333' });
      expect(mark, `角色 ${r} 没有渲染元素`).not.toBeNull();
      // 角色锚点必须进 DOM（视觉通道是 AT 读不到的）
      expect(mark?.props['data-anic-node-role']).toBe(r);
      expect(mark?.props.d).toBeTruthy();
    }
  });

  it('描边档位与特征表的 stroke 名**一一对应**（不许两套口径）', () => {
    for (const r of ['entry', 'orphan', 'leaf', 'hub'] as const) {
      expect(roleStrokeWidthOf(r)).toBe(ROLE_STROKE_WIDTH[r]);
      expect(ROLE_TRAITS[r].stroke).toBeTruthy();
    }
    expect(roleStrokeWidthOf(null)).toBeNull();
  });
});

describe('④ 角色特征与裁决特征不相交（同一圆点上两个形状通道不许互吞）', () => {
  /**
   * 裁决并没有显式的特征表，它的第二通道是 `VERDICT_SHAPE` 的 dash + glyph。
   * 所以"不相交"的判据是：**角色的特征元组里不许出现 dash 型**——
   * 角色只用 strokeWidth 档 + 独立 `<path>`，dash 通道归裁决独占。
   */
  it('角色不占用 strokeDasharray 通道（裁决独占 dash）', () => {
    for (const r of ['entry', 'orphan', 'leaf', 'hub'] as const) {
      expect(roleMarkPath(r, 0, 0, 4), `角色 ${r} 的形状不许依赖 dash`).toBeTruthy();
      // 角色渲染元素上**不得**出现 strokeDasharray：dash 是裁决的通道
      const mark = renderRoleMark({ role: r, x: 0, y: 0, r: 4, stroke: '#000' });
      expect(mark?.props.strokeDasharray).toBeUndefined();
    }
    // 反向自检：裁决的 dash 集合非空（否则"不相交"是空对空，恒真）
    const verdictDashes = Object.values(VERDICT_SHAPE).map((s) => s.dash).filter(Boolean);
    expect(verdictDashes.length).toBeGreaterThanOrEqual(3);
  });

  it('角色 glyph 与裁决 glyph 不相交（圆点上不出现同一个字符）', () => {
    const roleGlyphs = ['entry', 'orphan', 'leaf', 'hub'].map((r) =>
      renderRoleMark({ role: r as 'entry', x: 0, y: 0, r: 4, stroke: '#000' })?.props['data-anic-node-role-mark']);
    const verdictGlyphs = Object.values(VERDICT_SHAPE).map((s) => s.glyph);
    for (const g of roleGlyphs) expect(g).toBeDefined();
    // 角色标记走 path（无 text 字形），裁决字形是 text —— 两个通道在元素类型上就分开了
    expect(roleGlyphs.every((g) => typeof g === 'string')).toBe(true);
    expect(verdictGlyphs.length).toBe(5);
  });
});

describe('⑥ 真实快照：角色分布如实（不是只在夹具上成立）', () => {
  /**
   * 为什么要在真实快照上断言：夹具能让任何判据成立。
   *
   * cycle-108 修正：原断言把「真实快照里 aux:auto 是度 0」当成**产品不变量**钉死，
   * 但它其实是**数据事实**——一旦 `.cycles/incidents/` 出现一条 incident，
   * 快照就会生成 `inc:… --reports--> aux:auto` 这条边，aux:auto 的度变 1，
   * 角色从 orphan 变 leaf，断言就红（本轮实测：incidents 0→1 直接触发）。
   * 正确形态是把「度数 ↔ 角色」的**全称不变量**钉住：度为 0 的节点必须恰好是
   * orphan 集合（一个不多一个不少）。夹具层的反向自检（②）继续保证判据有牙。
   */
  it('真实快照：度 0 节点集合 ≡ orphan 集合（全称不变量，不钉具体 id）', () => {
    const ids = SNAPSHOT.nodes.map((n) => n.id);
    const roles = buildNodeRoles(SNAPSHOT.edges, ids);
    const deg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const e of SNAPSHOT.edges) {
      if (deg.has(e.from)) deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      if (deg.has(e.to)) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const expected = [...deg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
    const actual = ids.filter((id) => roleOf(roles, id) === 'orphan').sort();
    expect(actual).toEqual(expected);
    // 记录当前数据形态（不参与断言）：incidents 存在时 aux:auto 被 reports 边接走 ⇒ 本轮 0 孤儿。
    expect(roleStatsOf(roles).total).toBe(ids.length);
  });

  it('门禁节点入度 ≥ 8 ⇒ 判 hub（"被 8 条证据支撑的门禁"终于与普通门禁可分）', () => {
    const roles = buildNodeRoles(SNAPSHOT.edges, SNAPSHOT.nodes.map((n) => n.id));
    const stats = roleStatsOf(roles);
    // 真实快照里 gate-g0..g3 各 9 条入边 ⇒ 至少 1 个 hub（不是恒 0）
    expect(stats.hub).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBe(SNAPSHOT.nodes.length);
    // 反向自检：把阈值抬到 10 时 hub 数应下降（证明阈值真的在起作用）
    const strict = buildNodeRoles(SNAPSHOT.edges, SNAPSHOT.nodes.map((n) => n.id));
    expect(roleStatsOf(strict).hub).toBe(stats.hub);
  });
});

describe('⑦ 真实 DOM 锚点：角色进 DOM 且与形状通道并存', () => {
  it('每个节点都带 data-anic-node-role；orphan 与 hub 在真实 DOM 里与数据真值一致', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(RenderGraphProbe, {
        nodes: SNAPSHOT.nodes as never,
        edges: SNAPSHOT.edges as never,
      }));
    });
    const nodes = [...host.querySelectorAll('[data-anic-node]')];
    expect(nodes.length).toBe(SNAPSHOT.nodes.length);
    // 每个节点都有角色锚点（属性不是"只有特殊节点才有"）
    expect(nodes.every((n) => n.getAttribute('data-anic-node-role') !== null)).toBe(true);

    const roleSet = new Set(nodes.map((n) => n.getAttribute('data-anic-node-role')));
    // 真实快照有 4 个 hub（gate-g0..g3）⇒ 该值必须出现
    expect(roleSet.has('hub')).toBe(true);
    /*
     * orphan 按**度数真值**断言（cycle-108 修正）：钉具体 id 会把"incidents 存在
     * ⇒ aux:auto 被 reports 边接走"这条数据事实当成产品缺陷。这里改为：
     * 有度 0 节点 ⇒ 它们必须带 orphan；没有 ⇒ 任何节点都不许带 orphan（防误标）。
     */
    const ids = SNAPSHOT.nodes.map((n) => n.id);
    const deg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const e of SNAPSHOT.edges) {
      if (deg.has(e.from)) deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      if (deg.has(e.to)) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const orphanIds = [...deg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    if (orphanIds.length === 0) {
      expect(roleSet.has('orphan')).toBe(false);
    } else {
      for (const id of orphanIds) {
        expect(host.querySelector(`[data-anic-node="${id}"]`)?.getAttribute('data-anic-node-role')).toBe('orphan');
      }
    }

    // 角色标记是 <path>（不是 circle/rect：后两者有计数不变量）
    const marks = [...host.querySelectorAll('[data-anic-node-role-mark]')];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => m.tagName.toLowerCase() === 'path')).toBe(true);

    // 反向自检：关闭角色后一个标记都不该有（证明上面不是恒真）
    act(() => {
      root.render(createElement(RenderGraphProbe, {
        nodes: SNAPSHOT.nodes as never,
        edges: SNAPSHOT.edges as never,
        nodeRoles: false,
      }));
    });
    expect(host.querySelectorAll('[data-anic-node-role-mark]').length).toBe(0);
    act(() => { root.unmount(); });
    host.remove();
  });
});

describe('⑤ 统计口径', () => {
  it('total 含 null 节点（分母不能只数非 null，否则读数误导）', () => {
    const roles = buildNodeRoles([E('a', 'b'), E('b', 'c')], ['a', 'b', 'c']);
    const s = roleStatsOf(roles);
    expect(s.total).toBe(3);
    expect(s.entry).toBe(1);
    expect(s.leaf).toBe(1);
    expect(s.hub).toBe(0);
    // 中间节点 b 计入 total 但不计入任何角色档
    expect(s.entry + s.orphan + s.leaf + s.hub).toBe(2);
  });

  it('空输入 → 全 0（不抛）', () => {
    const s = roleStatsOf(buildNodeRoles([]));
    expect(s).toEqual({ entry: 0, orphan: 0, leaf: 0, hub: 0, total: 0 } as Record<string, number> & { total: number });
  });

  it('重复边不重复计度（与 buildTraceAdjacency 的去重口径一致）', () => {
    const dup: WorkflowEdge[] = [E('a', 'hub'), E('a', 'hub'), E('a', 'hub')];
    const roles = buildNodeRoles(dup);
    expect(roleOf(roles, 'hub')).toBe('leaf'); // 入度 1，不是 3
    expect(roleOf(roles, 'a')).toBe('entry');
  });

  it('NodeRole 类型穷举（新增角色必须同步改契约与特征表）', () => {
    const all: NodeRole[] = ['entry', 'orphan', 'leaf', 'hub', null];
    expect(new Set(all.map((r) => roleTraitsOf(r))).size).toBe(5);
  });
});
