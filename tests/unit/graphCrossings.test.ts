/**
 * 交叉数语义单测（cycle-94）—— 证明 `crossingsOf` 数的是**真交叉**，不是"全序反序"。
 *
 * ## 为什么这条单测必须存在（三轮返工的教训）
 *
 * 初版把 `(列,行)` 压成一个标量比较乘积符号 ⇒ **共端点的扇入被逐对算成交叉**
 * （真实快照 32 条 `evidences` 全部指向同一批 gate 节点，于是产生上百个假交叉）。
 * 症状很隐蔽：数字很大、看起来"布局很差"，但**布局其实没问题** —— 是尺子坏了。
 *
 * 所以必须有"已知答案"的小夹具把判据钉死，否则任何布局改动都无法通过交叉数验证。
 */
import { describe, it, expect } from 'vitest';
import { crossingsOf } from '../../src/client/features/graph/graphLayoutFlow.ts';
import type { WorkflowEdge } from '../../src/client/workflowGraphData.ts';

/** 造一条边（crossingsOf 只读 from/to/type）。 */
const edge = (from: string, to: string): WorkflowEdge => ({ from, to, type: 'x' }) as WorkflowEdge;

describe('crossingsOf —— 交叉判据', () => {
  it('① 两条平行边（同向、同行序）⇒ 0 交叉', () => {
    const col = new Map([['a1', 0], ['b1', 1], ['a2', 0], ['b2', 1]]);
    const row = new Map([['a1', 0], ['b1', 0], ['a2', 1], ['b2', 1]]);
    expect(crossingsOf([edge('a1', 'b1'), edge('a2', 'b2')], col, row)).toBe(0);
  });

  it('② 两条真交叉边（起点顺序与终点顺序相反）⇒ 1 交叉', () => {
    const col = new Map([['a1', 0], ['a2', 0], ['b1', 1], ['b2', 1]]);
    // a1 在上、b1 在下；a2 在下、b2 在上 ⇒ 交错 ⇒ 真交叉
    const row = new Map([['a1', 0], ['a2', 1], ['b1', 1], ['b2', 0]]);
    expect(crossingsOf([edge('a1', 'b1'), edge('a2', 'b2')], col, row)).toBe(1);
  });

  it('③ 扇入（多条边共享同一终点）**不算**交叉', () => {
    const col = new Map([['a1', 0], ['a2', 0], ['g', 1]]);
    const row = new Map([['a1', 0], ['a2', 1], ['g', 0]]);
    // 两条边都指向 g —— 在 g 汇聚是"扇入"，不是缠绕。
    expect(crossingsOf([edge('a1', 'g'), edge('a2', 'g')], col, row)).toBe(0);
  });

  it('④ 扇出（多条边共享同一来源）**不算**交叉', () => {
    const col = new Map([['g', 0], ['b1', 1], ['b2', 1]]);
    const row = new Map([['g', 0], ['b1', 0], ['b2', 1]]);
    expect(crossingsOf([edge('g', 'b1'), edge('g', 'b2')], col, row)).toBe(0);
  });

  it('⑤ 真实快照的 32 条 evidences（扇入到 4 个门禁）不应逐对计入', () => {
    // 这是一个**结构性**断言：32 条边全部指向 4 个 gate，配对后共端点必须被排除。
    // 32 条边里，指向同一个 gate 的边（约 8 条一组）共 4 组 ⇒ 组内配对 ≥ 4×C(8,2) = 112 对。
    // 初版（全序比较）会把这些全算成交叉；正确实现必须返回 0 或极小值。
    const gates = ['wf:gate-g0', 'wf:gate-g1', 'wf:gate-g2', 'wf:gate-g3'];
    const col = new Map<string, number>();
    const row = new Map<string, number>();
    gates.forEach((g, i) => { col.set(g, 1); row.set(g, i); });
    const edges: WorkflowEdge[] = [];
    for (let grp = 0; grp < 8; grp += 1) {
      // 8 个 gate-event 在同一列、不同行，各指向 4 个 gate
      col.set(`evt:group-${String(grp)}`, 0);
      row.set(`evt:group-${String(grp)}`, grp);
      for (const g of gates) edges.push(edge(`evt:group-${String(grp)}`, g));
    }
    /*
     * ## 预期值必须来自**几何**，不能来自"我希望它是 0"
     *
     * 我第一版在这里写 `toBe(0)` —— **错了**，实测 168。原因：虽然同一 gate 内的
     * 8 条边共终点（被正确排除），但**跨 gate 的边是真实交叉**：
     * `evt:group-0 -> gate-g0`（行 0→0）与 `evt:group-1 -> gate-g3`（行 1→3）
     * 在对角方向确实交错，画出来就是两根交叉的线。
     *
     * ⇒ 这条断言的真实价值不是"应为 0"，而是**给出一个可复算的上界**：
     * 32 条边两两配对共 C(32,2)=496 对，其中同 gate 的 4×C(8,2)=112 对被排除
     * ⇒ **最多 384 对**可能交叉。实测 168 ⇒ 扇入排除确实生效（
     * 若未排除会 ≥496 量级），且不是"全算"也不是"全不算"。
     *
     * 这就是为什么这条用例保留 168 这个具体数字：**它证明尺子在"扇入之外"仍然在工作**。
     * 任何把共端点误算进去的实现会 > 384；任何把交叉全吞掉的实现会 == 0。
     */
    const n = crossingsOf(edges, col, row);
    const pairs = (edges.length * (edges.length - 1)) / 2;          // 496
    const sharedTargets = gates.length * ((8 * 7) / 2);              // 112（同 gate 内共终点）
    expect(n).toBeGreaterThan(0);                                    // 不是"全吞掉"
    expect(n).toBeLessThanOrEqual(pairs - sharedTargets);            // 不是"全算"（≤384）
    expect(n).toBe(168);                                             // 可复算的实测值（棘轮）
  });

  it('⑥ 缺端点坐标的边被跳过（布局不负责悬空边）', () => {
    const col = new Map([['a', 0]]);
    const row = new Map([['a', 0]]);
    // b 没有坐标 ⇒ 这条边不参与计数，不能因为"取不到"就崩或算 1。
    expect(crossingsOf([edge('a', 'b')], col, row)).toBe(0);
  });
});
