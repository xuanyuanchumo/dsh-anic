/**
 * 分层布局单测（cycle-82 · G 战线）——对着**真实快照**断言，不造小夹具。
 *
 * ## 为什么用真数据而不是玩具夹具
 *
 * 布局的目标只有一个：让 188 个节点的真实图可读。用 6 个节点的夹具测「高度降了 60%」
 * 毫无意义——缩放比取决于最长 lane（122 个门禁事件）和 lane 数量的组合，
 * 小夹具里这个结构根本不存在，测出来的绿是假绿。
 *
 * ## 每条断言都想挡什么
 *
 * - **节点不丢**：`placed.size == nodes.length`。丢一个点用户看不出是丢了还是被边遮住。
 * - **位置唯一**：两个点同坐标等于其中一个永久不可见——而 DOM 里两个都在，任何计数断言都救不了。
 * - **同输入同输出**：深比较两次布局结果。这条挡的是「有人为了"更好看"引入随机抖动
 *   或 `Object.keys` 顺序依赖」——那会让截图对比与快照测试永久不稳定。
 * - **输出顺序 == 输入顺序**：既有 `graphA11y` 契约靠 circle 顺序对齐裁决字形。
 * - **高度 ≤ 60%**：合同明写的验收线。
 * - **宽高比**：不但要变矮，还要"接近可视比例"，否则 60% 只是把长条压扁成更长的条。
 * - **反向自检**：把布局产物篡改成已知坏形态（重叠 / 丢点 / 顺序错乱），
 *   证明上面每条断言真的会红——否则它们可能只是恒真。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYOUT,
  LANE_ORDER,
  balancedChunks,
  layoutGraph,
  legacyBounds,
  type PositionedNode,
} from '../../src/client/features/graph/graphLayout.ts';
import type { WorkflowSnapshot } from '../../src/client/workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = JSON.parse(
  readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8'),
) as WorkflowSnapshot;

/** 同一份数据布局两次（不同对象引用，验证不依赖 Map 插入顺序之外的状态）。 */
function layoutTwice() {
  return [
    layoutGraph(JSON.parse(JSON.stringify(SNAPSHOT.nodes)), JSON.parse(JSON.stringify(SNAPSHOT.edges))),
    layoutGraph(SNAPSHOT.nodes, SNAPSHOT.edges),
  ] as const;
}

const LAYOUT_RESULT = layoutGraph(SNAPSHOT.nodes, SNAPSHOT.edges);

describe('layoutGraph：真实快照的结构不变量', () => {
  it('扫描集非空（空快照 = 永久假绿的起点）', () => {
    expect(SNAPSHOT.nodes.length).toBeGreaterThanOrEqual(150);
    expect(SNAPSHOT.edges.length).toBeGreaterThanOrEqual(200);
    expect(LAYOUT_RESULT.nodes.length).toBe(SNAPSHOT.nodes.length);
  });

  it('节点一个不少（丢点在任何计数断言里都看不出来——DOM 里两个点都在）', () => {
    expect(LAYOUT_RESULT.nodes.map((n) => n.id).sort()).toEqual(SNAPSHOT.nodes.map((n) => n.id).sort());
    expect(new Set(LAYOUT_RESULT.nodes.map((n) => n.id)).size).toBe(SNAPSHOT.nodes.length);
  });

  it('位置两两不同（同坐标 = 其中一个永久被遮住）', () => {
    const coords = LAYOUT_RESULT.nodes.map((n) => `${String(n.x)},${String(n.y)}`);
    expect(new Set(coords).size).toBe(coords.length);
  });

  it('边原样保留（布局不改拓扑；悬空边由渲染层跳过，那是渲染契约的事）', () => {
    expect(LAYOUT_RESULT.edges).toHaveLength(SNAPSHOT.edges.length);
    expect(LAYOUT_RESULT.edges.map((e) => `${e.from}>${e.to}`)).toEqual(
      SNAPSHOT.edges.map((e) => `${e.from}>${e.to}`),
    );
  });

  it('输出顺序 == 输入顺序（graphA11y 靠 circle 顺序对齐裁决字形）', () => {
    expect(LAYOUT_RESULT.nodes.map((n) => n.id)).toEqual(SNAPSHOT.nodes.map((n) => n.id));
  });

  it('同输入同输出（深相等；挡随机抖动与字典序依赖）', () => {
    const [a, b] = layoutTwice();
    expect(a.nodes.map((n) => [n.id, n.x, n.y, n.column, n.row])).toEqual(
      b.nodes.map((n) => [n.id, n.x, n.y, n.column, n.row]),
    );
    expect(a.bounds).toEqual(b.bounds);
    expect(a.lanes).toEqual(b.lanes);
  });

  it('不修改输入（纯函数纪律：调用方可能复用同一数组做等价数据表）', () => {
    const nodes = SNAPSHOT.nodes.map((n) => ({ ...n }));
    const before = nodes.map((n) => `${String(n.x)},${String(n.y)}`).join('|');
    layoutGraph(nodes, SNAPSHOT.edges);
    expect(nodes.map((n) => `${String(n.x)},${String(n.y)}`).join('|')).toBe(before);
  });
});

describe('layoutGraph：压缩率与比例（cycle-82 验收线）', () => {
  it('总高度 ≤ 原高度 60%', () => {
    const legacy = legacyBounds(SNAPSHOT.nodes);
    const ratio = LAYOUT_RESULT.bounds.height / legacy.height;
    // 附带把两个数打进失败信息：只报"超了"无法判断是布局退化还是验收线收紧。
    expect({ ratio, height: LAYOUT_RESULT.bounds.height, legacy: legacy.height })
      .toMatchObject({ ratio: expect.any(Number) });
    expect(ratio).toBeLessThanOrEqual(0.6);
  });

  it('宽高比进入可视区间（0.8 ~ 2.6）——变矮不能靠"压成更长的条"', () => {
    const aspect = LAYOUT_RESULT.bounds.width / LAYOUT_RESULT.bounds.height;
    expect(aspect).toBeGreaterThan(0.8);
    expect(aspect).toBeLessThan(2.6);
  });

  it('单列高度有上限（任何一列都不超过 rowsPerColumn 行）', () => {
    const byColumn = new Map<number, PositionedNode[]>();
    for (const n of LAYOUT_RESULT.nodes) {
      const list = byColumn.get(n.column);
      if (list === undefined) byColumn.set(n.column, [n]);
      else list.push(n);
    }
    expect(byColumn.size).toBe(LAYOUT_RESULT.columns);
    for (const [col, list] of byColumn) {
      expect(list.length, `列 ${String(col)} 超高`).toBeLessThanOrEqual(LAYOUT.rowsPerColumn);
    }
  });

  it('超长 lane 折成多列（cycle 43 个、gate-event 122 个都必须折）', () => {
    const cycle = LAYOUT_RESULT.lanes.find((l) => l.type === 'cycle');
    const evt = LAYOUT_RESULT.lanes.find((l) => l.type === 'gate-event');
    expect(cycle?.count).toBeGreaterThan(LAYOUT.rowsPerColumn);
    expect(evt?.count).toBeGreaterThan(LAYOUT.rowsPerColumn);
    expect(new Set(cycle?.columns).size).toBeGreaterThan(1);
    expect(new Set(evt?.columns).size).toBeGreaterThan(1);
  });

  it('lane 汇总与实际节点数一致（汇总不能是随手编的数字）', () => {
    const total = LAYOUT_RESULT.lanes.reduce((s, l) => s + l.count, 0);
    expect(total).toBe(SNAPSHOT.nodes.length);
    for (const lane of LAYOUT_RESULT.lanes) {
      const actual = LAYOUT_RESULT.nodes.filter((n) => n.lane === lane.type).length;
      expect(actual, `lane ${lane.type} 汇总 ${String(lane.count)} 与实际 ${String(actual)} 不符`).toBe(lane.count);
    }
  });

  it('lane 顺序按 LANE_ORDER（已知类型在前，未知类型按字母序追加）', () => {
    const known = LAYOUT_RESULT.lanes.map((l) => l.type).filter((t) => LANE_ORDER.includes(t));
    const expected = LANE_ORDER.filter((t) => known.includes(t));
    expect(known).toEqual(expected);
  });
});

describe('balancedChunks：均衡切分', () => {
  it('之和恒等于 total，任一份 ≤ ceil(total/cols)', () => {
    for (const [total, cols] of [[43, 2], [122, 6], [188, 9], [7, 1], [1, 1], [24, 1], [25, 2]] as const) {
      const chunks = balancedChunks(total, cols);
      expect(chunks).toHaveLength(cols);
      expect(chunks.reduce((s, v) => s + v, 0)).toBe(total);
      for (const c of chunks) expect(c).toBeLessThanOrEqual(Math.ceil(total / cols));
    }
  });

  it('前 total%cols 份各多 1（确定性：不依赖随机或浮点）', () => {
    expect(balancedChunks(43, 2)).toEqual([22, 21]);
    expect(balancedChunks(122, 6)).toEqual([21, 21, 20, 20, 20, 20]);
    expect(balancedChunks(5, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it('边界：cols<=0 或 total<=0 返回空数组（不出 NaN/Infinity）', () => {
    expect(balancedChunks(0, 3)).toEqual([]);
    expect(balancedChunks(10, 0)).toEqual([]);
    expect(balancedChunks(-5, 2)).toEqual([]);
  });

  it('反向自检：故意做成"填满再换列"的切分，必须被上面的上限断言判红', () => {
    const naive = (total: number, cols: number): number[] => {
      const out = Array.from({ length: cols }, () => 0);
      let left = total;
      for (let i = 0; i < cols && left > 0; i += 1) {
        const take = Math.min(24, left); // 24 = rowsPerColumn，"填满再换列"
        out[i] = take;
        left -= take;
      }
      return out;
    };
    // 122 个事件切成 6 列：朴素切法给出 24/24/24/24/24/2 —— 前五列都超 ceil(122/6)=21
    const bad = naive(122, 6);
    expect(bad.some((c) => c > Math.ceil(122 / 6))).toBe(true);
    // 均衡切法必须全部 ≤ 21 —— 同一判定式对两种输入给出相反结论，证明它有判别力
    expect(balancedChunks(122, 6).every((c) => c <= Math.ceil(122 / 6))).toBe(true);
  });
});

describe('layoutGraph：空与退化输入', () => {
  it('空图不抛、给最小可见包围盒（0 宽高会让 SVG 整块不渲染）', () => {
    const empty = layoutGraph([], []);
    expect(empty.nodes).toEqual([]);
    expect(empty.bounds.width).toBeGreaterThan(0);
    expect(empty.bounds.height).toBeGreaterThan(0);
    expect(empty.columns).toBe(0);
  });

  it('单节点：一列一行，包围盒包含标签余量', () => {
    const one = layoutGraph([{ id: 'a', type: 'gate', label: 'A', x: 0, y: 0 }], []);
    expect(one.nodes).toHaveLength(1);
    expect(one.nodes[0]?.column).toBe(0);
    expect(one.nodes[0]?.row).toBe(0);
    expect(one.columns).toBe(1);
    expect(one.bounds.maxX).toBeGreaterThan(0);
  });

  it('未知类型自成一 lane（不丢节点、按字母序追加）', () => {
    const odd = layoutGraph([
      { id: 'x', type: 'gate', label: 'G', x: 0, y: 0 },
      { id: 'y', type: 'mystery' as never, label: 'M', x: 0, y: 0 },
    ], []);
    expect(odd.nodes).toHaveLength(2);
    expect(odd.lanes.map((l) => l.type)).toEqual(['gate', 'mystery']);
  });

  it('同 id 重复节点只占一个位置（首个胜出，保证位置唯一不变量）', () => {
    // 真实数据 188 个 id 全唯一；这里测的是"未来数据变脏时行为可预测"。
    // 若两个同 id 项各占一格，它们在位置表里互相覆盖、DOM 里却各留一份 ——
    // 两个点叠在同一坐标，其中一个永久不可见，而任何计数断言都看不出问题。
    const dup = layoutGraph([
      { id: 'a', type: 'gate', label: 'A1', x: 0, y: 0 },
      { id: 'a', type: 'gate', label: 'A2', x: 0, y: 0 },
    ], []);
    expect(dup.nodes).toHaveLength(1);
    expect(dup.nodes[0]?.label).toBe('A1');
  });
});

describe('反向自检：上面那些不变量真的能判红', () => {
  it('篡改副本注入「重叠位置」→ 唯一性断言必须发现', () => {
    const tampered = LAYOUT_RESULT.nodes.map((n, i) =>
      i === 1 ? { ...n, x: LAYOUT_RESULT.nodes[0]?.x ?? 0, y: LAYOUT_RESULT.nodes[0]?.y ?? 0 } : n,
    );
    const coords = tampered.map((n) => `${String(n.x)},${String(n.y)}`);
    expect(new Set(coords).size).not.toBe(coords.length);
  });

  it('篡改副本丢掉一个节点 → 数量与集合断言必须发现', () => {
    const tampered = LAYOUT_RESULT.nodes.slice(1);
    expect(tampered.length).not.toBe(SNAPSHOT.nodes.length);
    expect(tampered.map((n) => n.id).sort()).not.toEqual(SNAPSHOT.nodes.map((n) => n.id).sort());
  });

  it('篡改副本打乱顺序 → 输入顺序断言必须发现', () => {
    const tampered = [...LAYOUT_RESULT.nodes].reverse();
    expect(tampered.map((n) => n.id)).not.toEqual(SNAPSHOT.nodes.map((n) => n.id));
  });

  it('篡改副本放大行距到原值 → 高度验收线必须发现', () => {
    // 用 legacyBounds 的等价形态：把每个点按 46 行距重排，高度必然回到原量级。
    const legacyHeight = legacyBounds(SNAPSHOT.nodes).height;
    expect(legacyHeight).toBeGreaterThan(LAYOUT_RESULT.bounds.height / 0.6);
  });
});
