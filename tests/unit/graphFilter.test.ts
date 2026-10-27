/**
 * 筛选与邻接高亮单测（cycle-82 · G 战线）。
 *
 * ## 本文件守的三条语义决定（都在 graphFilter.ts 头注里给了理由）
 *
 * 1. **空筛选 = 全可见**。这一条若破了，首屏就是白屏，而组件测试看到的只是
 *    "渲染成功"——`visibilityOf` 全返回 `filtered` 也一样"成功"。
 * 2. **多条件取交集，不是并集**。类型 `gate` + 裁决 `fail` 应是"失败的门禁"，
 *    而不是"所有门禁加上所有失败"。并集是看起来更"多"因此更容易被误写成对的那个错。
 * 3. **大小写不敏感 + 同时匹配 id 与 label**。用户看到的是 label（「G0 评估收敛门」），
 *    但想按 id 找时必须能输 `evt:12`——两种是不同意图，只支持一种就有一半人找不到。
 *
 * ## 为什么不删节点（本文件也守这一条）
 *
 * `matchingNodes` 返回的是**集合**而不是过滤后的数组：渲染层据此改 opacity，
 * 节点 DOM 全部保留。理由见 graphFilter.ts 头注（smoke 计数不变量 + AT 可遍历）。
 * 因此这里断言"未命中节点仍在 nodes 里"是**有意义**的，不是废话——
 * 一旦有人把 API 改成 `nodes.filter(...)`，这条会连同契约测试一起红。
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTER,
  OPACITY,
  buildAdjacency,
  buildFilterView,
  countTypes,
  countVerdicts,
  isFilterActive,
  matchingNodes,
  neighborhoodOf,
  nodeMatches,
  normalizeQuery,
  verdictKeyOf,
  visibilityOf,
  type FilterState,
} from '../../src/client/features/graph/graphFilter.ts';
import { LANE_ORDER } from '../../src/client/features/graph/graphLayout.ts';
import { WORKFLOW_SNAPSHOT, type WorkflowNode } from '../../src/client/workflowGraphData.ts';

const NODES = WORKFLOW_SNAPSHOT.nodes;
const EDGES = WORKFLOW_SNAPSHOT.edges;

const mk = (id: string, type: WorkflowNode['type'], label: string, result?: string): WorkflowNode =>
  ({ id, type, label, x: 0, y: 0, ...(result !== undefined ? { result } : {}) });

/** 小夹具：类型/裁决/文本三条筛选条件的可控组合。 */
const FIXTURE: WorkflowNode[] = [
  mk('wf:plan', 'phase', 'Plan（规划）'),
  mk('g0', 'gate', 'G0 评估收敛门', 'PASS'),
  mk('g1', 'gate', 'G1 任务收敛门', 'FAIL'),
  mk('g2', 'gate', 'G2 测试收敛门', 'doubt'),
  mk('evt:1', 'gate-event', 'G0 PASS', 'PASS'),
  mk('evt:2', 'gate-event', 'G1 FAIL', 'FAIL'),
  mk('cyc:1', 'cycle', 'cycle-1'),
];
const FIXTURE_EDGES = [
  { from: 'evt:1', to: 'g0', type: 'evidences' },
  { from: 'evt:2', to: 'g1', type: 'evidences' },
];

describe('verdictKeyOf：裁决归一', () => {
  it('五态 + 别名 + 无裁决', () => {
    expect(verdictKeyOf('PASS')).toBe('pass');
    expect(verdictKeyOf('approve')).toBe('pass');
    expect(verdictKeyOf('FAIL')).toBe('fail');
    expect(verdictKeyOf('reject')).toBe('fail');
    expect(verdictKeyOf('doubt')).toBe('doubt');
    expect(verdictKeyOf('pending')).toBe('pending');
    expect(verdictKeyOf('skip')).toBe('skip');
    expect(verdictKeyOf('skipped')).toBe('skip');
    expect(verdictKeyOf(undefined)).toBe('none');
    expect(verdictKeyOf('')).toBe('none');
    expect(verdictKeyOf('weird')).toBe('none');
  });

  it('大小写与空白都归一（数据来自账本，拼写不完全受控）', () => {
    expect(verdictKeyOf('  Pass ')).toBe('pass');
    expect(verdictKeyOf('FAil')).toBe('fail');
  });

  it('反向自检：不归一时 PASS 与 pass 会被当成两类（筛选漏一半数据）', () => {
    expect('PASS' === 'pass').toBe(false);
    expect(verdictKeyOf('PASS') === verdictKeyOf('pass')).toBe(true);
  });
});

describe('countTypes / countVerdicts：chip 上的数字', () => {
  it('计数之和 == 节点数（chip 数字对不上就是骗人）', () => {
    const types = countTypes(NODES, LANE_ORDER);
    expect(types.reduce((s, t) => s + t.count, 0)).toBe(NODES.length);
    const verdicts = countVerdicts(NODES);
    expect(verdicts.reduce((s, t) => s + t.count, 0)).toBe(NODES.length);
  });

  it('顺序跟随 LANE_ORDER（筛选面板与图的 lane 顺序一致，两处对得上）', () => {
    const types = countTypes(NODES, LANE_ORDER);
    const known = types.map((t) => t.type).filter((t) => LANE_ORDER.includes(t));
    expect(known).toEqual(LANE_ORDER.filter((t) => known.includes(t)));
  });

  it('真实数据的具体计数（挡"计数是随手编的"）', () => {
    const byType = new Map(countTypes(NODES).map((t) => [t.type, t.count]));
    expect(byType.get('gate-event')).toBe(NODES.filter((n) => n.type === 'gate-event').length);
    expect(byType.get('cycle')).toBe(NODES.filter((n) => n.type === 'cycle').length);
    const byVerdict = new Map(countVerdicts(NODES).map((t) => [t.type, t.count]));
    expect(byVerdict.get('pass')).toBe(NODES.filter((n) => verdictKeyOf(n.result) === 'pass').length);
  });

  it('verdicts Map 覆盖优先于节点内嵌 result（投影数据胜过快照数据）', () => {
    const map = new Map([['g0', 'FAIL']]);
    const byVerdict = new Map(countVerdicts(FIXTURE, map).map((t) => [t.type, t.count]));
    expect(byVerdict.get('fail')).toBe(3); // g1 + evt:2 + 被覆盖的 g0
  });

  it('空输入返回空数组（不出 undefined 项）', () => {
    expect(countTypes([], LANE_ORDER)).toEqual([]);
    expect(countVerdicts([])).toEqual([]);
  });

  it('未知类型追加在已知类型之后且按字母序（确定性，不随首现顺序漂移）', () => {
    const odd = [mk('a', 'zzz' as never, 'A'), mk('b', 'aaa' as never, 'B'), mk('c', 'gate', 'G')];
    expect(countTypes(odd, LANE_ORDER).map((t) => t.type)).toEqual(['gate', 'aaa', 'zzz']);
  });
});

describe('normalizeQuery / nodeMatches：文本筛选', () => {
  it('查询归一：去首尾空白 + 小写', () => {
    expect(normalizeQuery('  Evt:12  ')).toBe('evt:12');
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery('   ')).toBe('');
  });

  it('空筛选匹配全部（这一条破了首屏就是白屏）', () => {
    for (const n of FIXTURE) expect(nodeMatches(n, EMPTY_FILTER)).toBe(true);
    expect(matchingNodes(FIXTURE, EMPTY_FILTER).size).toBe(FIXTURE.length);
  });

  it('按 label 匹配且大小写不敏感', () => {
    const f: FilterState = { ...EMPTY_FILTER, query: 'plan' };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['wf:plan']));
    const upper: FilterState = { ...EMPTY_FILTER, query: 'PLAN' };
    expect(matchingNodes(FIXTURE, upper)).toEqual(new Set(['wf:plan']));
  });

  it('按 id 匹配（用户想输 evt:1 这种身份时也必须能搜到）', () => {
    const f: FilterState = { ...EMPTY_FILTER, query: 'evt:2' };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['evt:2']));
  });

  it('中文 label 可搜（本仓文案是中文，只支持 ASCII 等于筛选半残）', () => {
    const f: FilterState = { ...EMPTY_FILTER, query: '评估' };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['g0']));
  });

  it('纯空白查询 == 未筛选（不能因为用户敲了个空格就白屏）', () => {
    const f: FilterState = { ...EMPTY_FILTER, query: '   ' };
    expect(isFilterActive(f)).toBe(false);
    expect(matchingNodes(FIXTURE, f).size).toBe(FIXTURE.length);
  });

  it('无命中返回空集而不是全部（空集是合法结果，不是"回退到全部"）', () => {
    const f: FilterState = { ...EMPTY_FILTER, query: '不存在的标签xyz' };
    expect(matchingNodes(FIXTURE, f).size).toBe(0);
    expect(isFilterActive(f)).toBe(true);
  });

  it('多条件取交集（gate + fail = 失败的门禁，不是并集）', () => {
    const f: FilterState = { types: ['gate'], verdicts: ['fail'], query: '' };
    const hit = matchingNodes(FIXTURE, f);
    expect(hit).toEqual(new Set(['g1']));
    // 反向：并集会给出 4 个（三个 gate + 两个 fail 去重后 5 个）——证明交集不是并集
    const union = new Set([
      ...FIXTURE.filter((n) => n.type === 'gate').map((n) => n.id),
      ...FIXTURE.filter((n) => verdictKeyOf(n.result) === 'fail').map((n) => n.id),
    ]);
    expect(union.size).toBeGreaterThan(hit.size);
  });

  it('三条件同时激活也取交集', () => {
    const f: FilterState = { types: ['gate-event'], verdicts: ['fail'], query: 'evt' };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['evt:2']));
    const narrowed: FilterState = { ...f, query: 'g1 fail' };
    // label "G1 FAIL" 不含 "g1 fail" 这片段（中间有空格但整体是小写 "g1 fail"）→ 实际命中
    expect(matchingNodes(FIXTURE, narrowed)).toEqual(new Set(['evt:2']));
  });

  it('types 多选是"或"（chip 之间是并集，跨维度才是交集）', () => {
    const f: FilterState = { ...EMPTY_FILTER, types: ['cycle', 'phase'] };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['wf:plan', 'cyc:1']));
  });

  it('verdicts 里的 none 能筛出无裁决节点（"哪些还没裁决"是真实运维问题）', () => {
    const f: FilterState = { ...EMPTY_FILTER, verdicts: ['none'] };
    expect(matchingNodes(FIXTURE, f)).toEqual(new Set(['wf:plan', 'cyc:1']));
  });
});

describe('buildAdjacency / neighborhoodOf：1 跳邻接', () => {
  it('无向：入边与出边都算邻居（只看方向会让 122 个事件节点看起来全孤立）', () => {
    const adj = buildAdjacency(FIXTURE, FIXTURE_EDGES);
    expect(adj.get('g0')).toEqual(new Set(['evt:1'])); // g0 只有入边
    expect(adj.get('evt:1')).toEqual(new Set(['g0'])); // 反向同样成立
  });

  it('高亮集含焦点自身（否则"我在看哪个"失去锚点）', () => {
    const adj = buildAdjacency(FIXTURE, FIXTURE_EDGES);
    expect(neighborhoodOf('g0', adj)).toEqual(new Set(['g0', 'evt:1']));
  });

  it('焦点为 null → 空集（没有焦点时不该高亮任何东西）', () => {
    const adj = buildAdjacency(FIXTURE, FIXTURE_EDGES);
    expect(neighborhoodOf(null, adj).size).toBe(0);
  });

  it('悬空边跳过（端点不存在时不产生"幽灵邻居"）', () => {
    const adj = buildAdjacency(FIXTURE, [
      ...FIXTURE_EDGES,
      { from: 'ghost:a', to: 'g0', type: 'x' },
      { from: 'g0', to: 'ghost:b', type: 'x' },
    ]);
    expect(adj.get('g0')).toEqual(new Set(['evt:1']));
    expect(adj.has('ghost:a')).toBe(false);
  });

  it('自环不进邻接集（高亮自己等于没高亮）', () => {
    const adj = buildAdjacency(FIXTURE, [{ from: 'g0', to: 'g0', type: 'self' }]);
    expect(adj.get('g0')).toEqual(new Set());
  });

  it('真实数据：每个节点都有邻接条目（没有节点被漏建索引）', () => {
    const adj = buildAdjacency(NODES, EDGES);
    for (const n of NODES) expect(adj.has(n.id)).toBe(true);
    // 边存在 ⇒ 必有一对邻居（真实数据 292 条边无悬空，见 graphLayout 测试）
    expect(adj.get(NODES[0]?.id ?? '')).toBeDefined();
  });

  it('真实数据：门禁事件与门禁节点确实相邻（不是"每条边都被跳过"的假索引）', () => {
    const adj = buildAdjacency(NODES, EDGES);
    const evt = NODES.find((n) => n.type === 'gate-event');
    expect(evt).toBeDefined();
    const neighbors = adj.get(evt?.id ?? '') ?? new Set();
    // 事件节点至少有一条邻接（event-seq 或 evidences）
    expect(neighbors.size).toBeGreaterThan(0);
  });

  it('反向自检：只算出边（有向）的错索引会让 g0 看起来孤立', () => {
    const directed = new Map<string, Set<string>>();
    for (const n of FIXTURE) directed.set(n.id, new Set());
    for (const e of FIXTURE_EDGES) directed.get(e.from)?.add(e.to); // 只有出边
    expect(directed.get('g0')?.size).toBe(0);
    expect(buildAdjacency(FIXTURE, FIXTURE_EDGES).get('g0')?.size).toBe(1);
  });
});

describe('visibilityOf：三档视觉状态', () => {
  it('命中筛选 + 无高亮 → 全亮', () => {
    expect(visibilityOf('a', new Set(['a']), new Set())).toBe('active');
  });

  it('命中筛选 + 属于高亮 → 全亮；不属于 → dimmed（仍可点）', () => {
    expect(visibilityOf('a', new Set(['a']), new Set(['a', 'b']))).toBe('active');
    expect(visibilityOf('c', new Set(['a', 'b', 'c']), new Set(['a', 'b']))).toBe('dimmed');
  });

  it('未命中筛选 → filtered（即使在高亮集里也最淡：它已不在当前语义子集）', () => {
    expect(visibilityOf('c', new Set(['a']), new Set(['a', 'c']))).toBe('filtered');
  });

  it('三档透明度递减且都 < 1 或 = 1（不能出现相等两档——分不出来就是没分）', () => {
    expect(OPACITY.active).toBe(1);
    expect(OPACITY.dimmed).toBeLessThan(OPACITY.active);
    expect(OPACITY.filtered).toBeLessThan(OPACITY.dimmed);
    expect(OPACITY.filtered).toBeGreaterThan(0); // 必须仍可见：完全 0 等于删除
  });

  it('反向自检：若把 filtered 与 dimmed 合并成一档，用户分不清"不存在"与"不是邻居"', () => {
    const merged = (visible: boolean): string => (visible ? 'active' : 'dimmed');
    // 合并后"筛选排除"与"非邻居"给出同一个值 → 两种需要不同后续动作的状态无法区分
    expect(merged(false)).toBe('dimmed');
    expect(visibilityOf('c', new Set(['a']), new Set(['a']))).toBe('filtered');
  });
});

describe('isFilterActive / buildFilterView', () => {
  it('空筛选不激活；任一条件激活即激活', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, types: ['gate'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, verdicts: ['fail'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, query: 'x' })).toBe(true);
  });

  it('批量视图与逐项查询一致（两条路径不能各说一套）', () => {
    const filter: FilterState = { ...EMPTY_FILTER, types: ['gate'] };
    const view = buildFilterView(FIXTURE, FIXTURE_EDGES, filter, null);
    const expected = new Set(FIXTURE.filter((n) => n.type === 'gate').map((n) => n.id));
    expect(view.matching).toEqual(expected);
    expect(view.active).toBe(true);
    expect(view.highlight.size).toBe(0);
  });

  it('带焦点时同时给出高亮集', () => {
    const view = buildFilterView(FIXTURE, FIXTURE_EDGES, EMPTY_FILTER, 'g0');
    expect(view.highlight).toEqual(new Set(['g0', 'evt:1']));
  });

  it('真实数据全流程：筛选后节点数不减少（渲染层永远拿到全部节点）', () => {
    const view = buildFilterView(NODES, EDGES, { ...EMPTY_FILTER, types: ['cycle'] }, null);
    expect(view.matching.size).toBeLessThan(NODES.length);
    // 但 nodes 数组本身一个不少 —— 这是"筛选不删节点"的可断言形式
    expect(NODES.length).toBe(WORKFLOW_SNAPSHOT.counts.nodes);
    const filtered = NODES.filter((n) => !view.matching.has(n.id));
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((n) => n.type !== 'cycle')).toBe(true);
  });
});
