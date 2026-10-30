/**
 * 路径追溯 / 搜索跳转纯函数单测（cycle-84 · V 战线）。
 *
 * 覆盖四件事，每件都有「反向自检」——正向断言只能证明"现在能过"，反向断言
 * 才能证明"这个判据有牙"（本仓既有契约的同一纪律）：
 *   ① `buildTrace`：上下游**方向**不能混（混成一个集合 = 用户分不清因果）；
 *   ② `buildTrace`：深度上限真的截断，且**诚实标注** truncated；
 *   ③ `traceRoleOf`：root/up/down/both 四态互斥且可判定；
 *   ④ `matchNodes`：有界 + 大小写不敏感 + 空查询返回空（不是全量）。
 *
 * 另外钉住 `centerOnWorld`：世界点落在视口正中，且保持当前 scale（除非显式传）。
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_TRACE, MAX_TRACE_DEPTH, buildTrace, buildTraceAdjacency, matchNodes, traceRoleOf,
} from '../../src/client/features/graph/graphTrace.ts';
import { IDENTITY, centerOnWorld, toScreen } from '../../src/client/features/graph/graphViewport.ts';
import type { WorkflowEdge } from '../../src/client/workflowGraphData.ts';

const edge = (from: string, to: string): WorkflowEdge => ({ from, to, type: 'cycle-seq' } as WorkflowEdge);

/** 链 A → B → C → D → E（四跳，超过默认深度 3）。 */
const CHAIN: WorkflowEdge[] = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('D', 'E')];

describe('buildTrace：有向 BFS 的上下游分离', () => {
  it('中间节点 C：上游 = {A,B}，下游 = {D,E}（方向不混）', () => {
    const t = buildTrace(buildTraceAdjacency(CHAIN), 'C');
    expect(t.root).toBe('C');
    expect([...t.up].sort()).toEqual(['A', 'B']);
    expect([...t.down].sort()).toEqual(['D', 'E']);
  });

  it('反向自检：把 up/down 合并成一个集合时，本用例的第一个断言必然红', () => {
    const t = buildTrace(buildTraceAdjacency(CHAIN), 'C');
    const merged = new Set([...t.up, ...t.down]);
    expect(merged.size).toBe(4);
    expect([...t.up].sort()).not.toEqual([...merged].sort());
  });

  it('根节点从不包含在自己的一跳集合里（自环不污染结果）', () => {
    const t = buildTrace(buildTraceAdjacency([edge('A', 'A'), edge('A', 'B')]), 'A');
    expect(t.up.has('A')).toBe(false);
    expect(t.down.has('A')).toBe(false);
    expect([...t.down]).toEqual(['B']);
  });

  it('深度上限真的截断，且 truncated 诚实为 true', () => {
    const t = buildTrace(buildTraceAdjacency(CHAIN), 'A', MAX_TRACE_DEPTH);
    // A 出发三跳 = B,C,D；E 需要四跳，必须不在集合里
    expect([...t.down].sort()).toEqual(['B', 'C', 'D']);
    expect(t.truncated).toBe(true);
  });

  it('反向自检：深度参数**不能**绕过硬上限（传 4 仍按 3 执行，E 不出现）', () => {
    const t = buildTrace(buildTraceAdjacency(CHAIN), 'A', 4);
    expect(t.down.has('E')).toBe(false);
    expect(t.truncated).toBe(true);
  });

  it('反向自检：链短于上限时 truncated 为 false（证明上一条不是恒定 true）', () => {
    const t = buildTrace(buildTraceAdjacency([edge('A', 'B'), edge('B', 'C')]), 'A');
    expect([...t.down].sort()).toEqual(['B', 'C']);
    expect(t.truncated).toBe(false);
  });

  it('空 root / 空边集 → EMPTY_TRACE（不是抛错，也不是「全图高亮」）', () => {
    expect(buildTrace(buildTraceAdjacency([]), null)).toBe(EMPTY_TRACE);
    expect(buildTrace(buildTraceAdjacency([]), '')).toBe(EMPTY_TRACE);
    expect([...buildTrace(buildTraceAdjacency([]), 'A').up]).toEqual([]);
  });

  it('邻接表去重：同一对端点重复边不会让 BFS 结果重复计数', () => {
    const dup = [edge('A', 'B'), edge('A', 'B'), edge('A', 'B')];
    expect([...buildTrace(buildTraceAdjacency(dup), 'A').down]).toEqual(['B']);
  });
});

describe('traceRoleOf：四态互斥', () => {
  it('root / up / down / both / null 各自可达且互不重叠', () => {
    // X 同时是 R 的上游与下游（环 R→X→R）
    const adj = buildTraceAdjacency([edge('U', 'R'), edge('R', 'D'), edge('R', 'X'), edge('X', 'R'), edge('X', 'R')]);
    const t = buildTrace(adj, 'R');
    expect(traceRoleOf(t, 'R')).toBe('root');
    expect(traceRoleOf(t, 'U')).toBe('up');
    expect(traceRoleOf(t, 'D')).toBe('down');
    expect(traceRoleOf(t, 'X')).toBe('both'); // R→X→R：既是下游又是上游
    expect(traceRoleOf(EMPTY_TRACE, 'U')).toBeNull();
  });

  it('both 态：节点既在 up 又在 down', () => {
    const adj = buildTraceAdjacency([edge('A', 'B'), edge('B', 'C'), edge('C', 'B')]);
    const t = buildTrace(adj, 'C');
    // A 是上游；B 既是上游（B→C）又是下游（C→B）
    expect(traceRoleOf(t, 'A')).toBe('up');
    expect(traceRoleOf(t, 'B')).toBe('both');
  });
});

describe('matchNodes：有界、大小写不敏感、空查询不返回全量', () => {
  const nodes = [
    { id: 'gate-1', label: 'G0 Gate Check' },
    { id: 'gate-2', label: 'G1 Gate Check' },
    { id: 'cycle-9', label: 'cycle 9' },
    { id: 'incident-1', label: 'Incident' },
  ];

  it('按 label 与 id 双向匹配', () => {
    expect(matchNodes(nodes, 'gate').total).toBe(2);
    expect(matchNodes(nodes, 'CYCLE-9').total).toBe(1); // id 命中 + 大小写不敏感
  });

  it('limit 截断 matches 但 total 仍报真实总数（工具条要显示“共 M 条”）', () => {
    const r = matchNodes(nodes, 'gate', 1);
    expect(r.matches).toHaveLength(1);
    expect(r.total).toBe(2);
  });

  it('空 / 纯空白查询 → 空结果（不是全量：空查询不该点亮整张图）', () => {
    expect(matchNodes(nodes, '').total).toBe(0);
    expect(matchNodes(nodes, '   ').total).toBe(0);
  });

  it('无命中 → total=0 且 matches 空（区分“搜了没有”与“还没搜”）', () => {
    expect(matchNodes(nodes, 'zzzz').total).toBe(0);
  });
});

describe('centerOnWorld：跳转的视口算术', () => {
  it('目标世界点落在视口正中', () => {
    const size = { width: 900, height: 560 };
    const vp = centerOnWorld({ x: 300, y: 200 }, size, IDENTITY);
    expect(toScreen(vp, { x: 300, y: 200 })).toEqual({ x: size.width / 2, y: size.height / 2 });
  });

  it('缺省保持当前 scale；显式传 scale 才改', () => {
    const size = { width: 900, height: 560 };
    const zoomed = { scale: 2, tx: 10, ty: -20 };
    expect(centerOnWorld({ x: 0, y: 0 }, size, zoomed).scale).toBe(2);
    expect(centerOnWorld({ x: 0, y: 0 }, size, zoomed, 1.5).scale).toBe(1.5);
  });

  it('非有限输入不产 NaN 视口（NaN 会让整张图消失）', () => {
    const vp = centerOnWorld({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, { width: 0, height: 0 }, IDENTITY);
    expect(Number.isFinite(vp.tx)).toBe(true);
    expect(Number.isFinite(vp.ty)).toBe(true);
  });
});
