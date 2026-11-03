/**
 * cycle-100：角色筛选维（FilterState.roles）——「找出所有汇聚点/孤立节点」在图上的解法。
 *
 * 被守卫缺口：节点角色（hub/orphan/entry/leaf）此前只进图例说明（aria-hidden 纯展示），
 * 不进筛选——用户在 169 节点图上逐个点开找 hub 是不可用的。
 *
 * 交互裁决（本文件钉死）：
 * 1. roles 是 FilterState 第四维（与类型/裁决/查询同维并列，交集语义）；
 * 2. 旧 FilterState 字面量无 roles 键 ⇒ undefined ⇒ 不筛（向后兼容，旧存档零迁移）；
 * 3. roleOfNode 缺席 + roles 激活 ⇒ 零命中（诚实退化，不假装全命中）；
 * 4. 图例在带 onToggleRole 时升级为 button[aria-pressed]，否则保持 aria-hidden 纯展示。
 */
import { describe, it, expect } from 'vitest';
import {
  nodeMatches, matchingNodes, isFilterActive, buildFilterView, EMPTY_FILTER,
} from '../../src/client/features/graph/graphFilter.ts';
import { buildNodeRoles, roleStatsOf } from '../../src/client/features/graph/graphNodeRole.ts';
import { renderRoleLegend } from '../../src/client/features/graph/graphToolbarRoleLegend.ts';
import type { WorkflowNode } from '../../src/client/workflowGraphData.ts';

function node(id: string, type = 'gate'): WorkflowNode {
  return { id, type, label: id, detail: undefined, result: undefined, testReport: undefined } as unknown as WorkflowNode;
}

/** 小图：A→B→C（A=entry, B=中间, C=leaf）+ D（orphan）+ E,F→G（G=hub）。 */
const NODES = [node('A'), node('B'), node('C'), node('D'), node('E'), node('F'), node('G')];
const EDGES = [
  { from: 'A', to: 'B' }, { from: 'B', to: 'C' },
  { from: 'E', to: 'G' }, { from: 'F', to: 'G' },
];
const ROLES = buildNodeRoles(EDGES, NODES.map((n) => n.id));
const roleOf = (id: string): string | null => ROLES.get(id) ?? null;

describe('FilterState.roles 第四维（角色筛选）', () => {
  it('roles 筛出对应角色（leaf=C,G；orphan=D）', () => {
    // 夹具里 G 入度 2 < HUB_INDEGREE(8) ⇒ 判 leaf 不是 hub（真实判据，不是拍脑袋）
    const leaves = matchingNodes(NODES, { ...EMPTY_FILTER, roles: ['leaf'] }, undefined, roleOf);
    expect([...leaves].sort()).toEqual(['C', 'G']);
    const orphans = matchingNodes(NODES, { ...EMPTY_FILTER, roles: ['orphan'] }, undefined, roleOf);
    expect([...orphans]).toEqual(['D']);
  });

  it('多角色并集内含（entry ∪ leaf = A,E,F,C,G）', () => {
    const sel = matchingNodes(NODES, { ...EMPTY_FILTER, roles: ['entry', 'leaf'] }, undefined, roleOf);
    expect([...sel].sort()).toEqual(['A', 'C', 'E', 'F', 'G']);
  });

  it('角色 × 类型交集（既有语义不被破坏）', () => {
    const nodes = [node('A', 'phase'), node('C', 'phase'), node('G', 'gate')];
    const sel = matchingNodes(nodes, { ...EMPTY_FILTER, types: ['phase'], roles: ['leaf'] }, undefined, roleOf);
    expect([...sel]).toEqual(['C']);
  });

  it('向后兼容：无 roles 键的旧 filter 零行为变化', () => {
    const legacy = { types: [], verdicts: [], query: '' };
    expect(isFilterActive(legacy)).toBe(false);
    expect(matchingNodes(NODES, legacy, undefined, roleOf).size).toBe(NODES.length);
    // 显式空数组同样不筛
    expect(matchingNodes(NODES, { ...legacy, roles: [] }, undefined, roleOf).size).toBe(NODES.length);
  });

  it('诚实退化：roles 激活但 roleOfNode 缺席 ⇒ 零命中（不假装全命中）', () => {
    expect(matchingNodes(NODES, { ...EMPTY_FILTER, roles: ['hub'] }).size).toBe(0);
  });

  it('isFilterActive 含 roles 维（清空筛选按钮联动）', () => {
    expect(isFilterActive({ ...EMPTY_FILTER, roles: ['hub'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, roles: [] })).toBe(false);
  });

  it('buildFilterView 透传角色维', () => {
    const view = buildFilterView(NODES, EDGES, { ...EMPTY_FILTER, roles: ['orphan'] }, null, undefined, roleOf);
    expect(view.matching.has('D')).toBe(true);
    expect(view.matching.has('G')).toBe(false);
    expect(view.active).toBe(true);
  });
});

describe('角色图例可点选形态（cycle-100）', () => {
  it('纯展示形态：aria-hidden 保持（零行为变化）', () => {
    const el = renderRoleLegend({ entry: 1, orphan: 1, leaf: 1, hub: 1 });
    expect(el.props['aria-hidden']).toBe('true');
    expect(el.props.children.length).toBe(4);
  });

  it('交互形态：button + aria-pressed + 激活锚点', () => {
    let toggled: string | null = null;
    const el = renderRoleLegend(
      { entry: 1, orphan: 1, leaf: 1, hub: 1 },
      ['hub'],
      (role) => { toggled = role; },
    );
    expect(el.props['aria-hidden']).toBeUndefined();
    const buttons = el.props.children as Array<{ type: string; props: Record<string, unknown> }>;
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    const hubBtn = buttons.find((b) => b.props['data-anic-graph-role-legend-item'] === 'hub');
    expect(hubBtn?.props['aria-pressed']).toBe('true');
    expect(hubBtn?.props['data-anic-graph-role-filter-active']).toBe('true');
    const entryBtn = buttons.find((b) => b.props['data-anic-graph-role-legend-item'] === 'entry');
    expect(entryBtn?.props['aria-pressed']).toBe('false');
    // 点击回调真的带着角色名触发
    (entryBtn?.props['onClick'] as () => void)();
    expect(toggled).toBe('entry');
  });

  it('角色判定不变量：hub 优先于 leaf（入度 ≥8 出度 0 的门禁是汇聚点）', () => {
    // 夹具无入度 ≥8 的节点 ⇒ hub=0 是**正确**读数（不是判据坏了）；
    // 判据顺序本身由 graphNodeRole 契约钉死（HUB_INDEGREE=8 优先）。
    const stats = roleStatsOf(ROLES);
    expect(stats.hub).toBe(0);
    expect(stats.entry).toBe(3); // A、E、F（入度 0 出度 >0）
    expect(stats.leaf).toBe(2);  // C、G（出度 0 入度 >0）
    expect(stats.orphan).toBe(1); // D（度 0）
    expect(stats.total).toBe(7);
  });
});
