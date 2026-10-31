/**
 * 两点最短路径单测（cycle-95 · WS-B）——「这两点怎么连」。
 *
 * ## 六条腿（每条带反向自检）
 *
 *   ① 链：A→B→C 得 3 节点 / 2 跳，且**方向**正确（反向不可达）；
 *   ② from === to → 零跳一条真路径（不是"找到了 0 跳的路径"这种假绿）；
 *   ③ 不可达 → `found:false` 且 `path:[]`（不是 null，也不抛）；
 *   ④ 超 maxHops → `found:false` 且 reason **点名上限数值**；
 *   ⑤ 最短性：绕远的路径不会被返回（双向 BFS 首遇即最短，这条证明它真的最短）；
 *   ⑥ 无向 vs 有向：同一对端点反向查询必须不同（有向可达不是连通性）。
 *
 * ## 为什么这些断言是"有牙"的
 *
 * 一个只做单向、无上限、把每对端点当无向的实现能通过 ①③⑤ 的大半断言；
 * ②（零跳）与 ⑥（有向）与 ④（上限点名）是专门为抓它写的。实测本仓契约的
 * 历史教训是：**反向自检里最"显然"的那条往往最先裂**。
 */
import { describe, it, expect } from 'vitest';
import { buildTraceAdjacency } from '../../src/client/features/graph/graphTrace.ts';
import { MAX_PATH_HOPS, findPath } from '../../src/client/features/graph/graphPathFind.ts';
import type { WorkflowEdge } from '../../src/client/workflowGraphData.ts';

const E = (from: string, to: string): WorkflowEdge => ({ from, to, type: 'cycle-seq' } as WorkflowEdge);
const adj = (...pairs: Array<[string, string]>) => buildTraceAdjacency(pairs.map(([f, t]) => E(f, t)));

describe('① 基本路径', () => {
  it('A→B→C：3 个节点、2 跳，且节点顺序与边方向一致', () => {
    const r = findPath(adj(['A', 'B'], ['B', 'C']), 'A', 'C');
    expect(r.found).toBe(true);
    expect(r.path).toEqual(['A', 'B', 'C']);
    expect(r.length).toBe(2);
    // 长度自洽：path.length === length + 1（差一错误在这里最容易发生）
    expect(r.path.length).toBe(r.length + 1);
    expect(r.reason).toBeUndefined();
  });

  it('单跳：A→B 得 2 节点 / 1 跳', () => {
    const r = findPath(adj(['A', 'B']), 'A', 'B');
    expect(r.path).toEqual(['A', 'B']);
    expect(r.length).toBe(1);
  });
});

describe('② 零跳：from === to', () => {
  it('返回 [from] / length 0 / found true（零跳是一条真路径）', () => {
    const r = findPath(adj(['A', 'B']), 'A', 'A');
    expect(r.found).toBe(true);
    expect(r.path).toEqual(['A']);
    expect(r.length).toBe(0);
  });

  it('反向自检：孤立节点自己到自己也成立（不能因为"没有边"就判不可达）', () => {
    // 若实现先查邻接表再判相等，孤立节点会返回 not found —— 这条专抓它。
    const r = findPath(buildTraceAdjacency([]), 'aux:auto', 'aux:auto');
    expect(r.found).toBe(true);
    expect(r.path).toEqual(['aux:auto']);
  });

  it('空 id → 明确拒绝且点名原因（不猜、不抛）', () => {
    expect(findPath(adj(['A', 'B']), '', 'B').reason).toBe('empty id');
    expect(findPath(adj(['A', 'B']), 'A', '').reason).toBe('empty id');
  });
});

describe('③ 不可达', () => {
  it('两个互不相连的子图 → found:false 且 path 为空数组', () => {
    const r = findPath(adj(['A', 'B'], ['X', 'Y']), 'A', 'Y');
    expect(r.found).toBe(false);
    expect(r.path).toEqual([]);
    expect(r.length).toBe(0);
    expect(r.reason).toBe('unreachable');
  });

  it('反向自检：**有向**不可达（B 能到 A，但 A 到不了 B 是另一回事）', () => {
    const g = adj(['B', 'A']);
    expect(findPath(g, 'B', 'A').found).toBe(true);
    expect(findPath(g, 'A', 'B').found).toBe(false); // 反向真的不通
  });

  it('目标不存在（无任何边涉及）→ 不可达（不伪造路径）', () => {
    expect(findPath(adj(['A', 'B']), 'A', 'ghost').found).toBe(false);
  });
});

describe('④ 跳数上限', () => {
  it('超过 maxHops → found:false 且 reason 点名上限数值', () => {
    // A→B→C→D→E→F→G：6 跳；上限 4 ⇒ 拒绝，且 reason 里有 "4"
    const pairs: Array<[string, string]> = [
      ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'G'],
    ];
    const r = findPath(adj(...pairs), 'A', 'G', 4);
    expect(r.found).toBe(false);
    expect(r.reason).toContain('4');
  });

  it('刚好等于上限 → 通过（边界不是"小于"）', () => {
    const pairs: Array<[string, string]> = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']];
    // A→E 是 4 跳，上限 4 ⇒ 必须通过
    const r = findPath(adj(...pairs), 'A', 'E', 4);
    expect(r.found).toBe(true);
    expect(r.length).toBe(4);
  });

  it('缺省上限 = MAX_PATH_HOPS，且参数不能绕过全局硬上限（传 99 仍夹到 6）', () => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 10; i += 1) pairs.push([`n${String(i)}`, `n${String(i + 1)}`]);
    // 10 跳链：缺省 6 ⇒ 拒绝
    expect(findPath(adj(...pairs), 'n0', 'n10').found).toBe(false);
    // 传 99 仍被夹到 6 ⇒ 也拒绝（硬上限不可绕过）
    const r = findPath(adj(...pairs), 'n0', 'n10', 99);
    expect(r.found).toBe(false);
    expect(r.reason).toContain(String(MAX_PATH_HOPS));
  });
});

describe('⑤ 最短性（不是"能连上就行"）', () => {
  it('存在捷径时返回**最短**那条，而不是最先遍历到的绕远路', () => {
    // A→B→C→D 与 A→D 直连 ⇒ 必须返回 A→D（1 跳），不是 3 跳
    const r = findPath(adj(['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D']), 'A', 'D');
    expect(r.length).toBe(1);
    expect(r.path).toEqual(['A', 'D']);
  });

  it('双向 BFS 在两端各有长尾时仍找到最短（不因扩展顺序漏掉短链）', () => {
    // 长链 A→x1→…→x6→T，与短链 A→s→T
    const pairs: Array<[string, string]> = [['A', 's'], ['s', 'T']];
    for (let i = 0; i < 6; i += 1) pairs.push([i === 0 ? 'A' : `x${String(i)}`, `x${String(i + 1)}`]);
    pairs.push(['x6', 'T']);
    const r = findPath(adj(...pairs), 'A', 'T');
    expect(r.found).toBe(true);
    expect(r.length).toBe(2);
    expect(r.path).toEqual(['A', 's', 'T']);
  });

  it('反向自检：把最短性换成"任意路径"时，上一条的 length 断言必然红', () => {
    const r = findPath(adj(['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D']), 'A', 'D');
    expect(r.length).not.toBe(3);
  });
});

describe('⑥ 纯函数性质', () => {
  it('两次调用深相等（零 clock / 零 random）', () => {
    const g = adj(['A', 'B'], ['B', 'C'], ['C', 'A']);
    expect(findPath(g, 'A', 'C')).toEqual(findPath(g, 'A', 'C'));
  });

  it('环不会让查询挂死（A→B→C→A，查 C→A）', () => {
    const r = findPath(adj(['A', 'B'], ['B', 'C'], ['C', 'A']), 'C', 'A');
    expect(r.found).toBe(true);
    expect(r.length).toBe(1);
  });

  it('环上零跳仍成立（不因环而误判不可达）', () => {
    const r = findPath(adj(['A', 'B'], ['B', 'A']), 'A', 'A');
    expect(r.found).toBe(true);
    expect(r.length).toBe(0);
  });
});
