/**
 * 路径选择模式状态机的单元契约（cycle-95 · WS-C）。
 *
 * ## 为什么状态机值得单独测
 *
 * 「第一下设起点、第二下设终点、再点起点清空、两端都有了再点第三个就重开场」
 * 这四条转移是**最容易写错又最不容易测出**的地方：真挂组件要模拟两次点击 +
 * 断言结果节点色，而失败形态（"点第三下没反应"）与"路径算错了"极难区分。
 * 纯函数可以直接喂 (state, id) 断言下一状态 —— 这是本仓
 * `graphFilter` / `graphTrace` 同一纪律的直接收益。
 *
 * ## 与 WS-B 的分工（重要）
 *
 * 本文件**不测** `findPath` 的正确性（那是 `tests/unit/graphPathFind.test.ts`
 * 的责任，属 WS-B）。这里只测**接线**：端点状态 → 调用 → 读数（highlight /
 * length / status）。两者分开是刻意的：路径算法错了应该在 B 的文件里红，
 * 而不是在这里被一条"highlight 为空"的断言盖住。
 */
import { describe, it, expect } from 'vitest';
import { buildTraceAdjacency } from '../../src/client/features/graph/graphTrace.ts';
import { findPath, MAX_PATH_HOPS } from '../../src/client/features/graph/graphPathFind.ts';
import {
  PATH_IDLE, pathExitOf, pathModelOf, pathPickOf, togglePathOf, withPathHighlight,
} from '../../src/client/features/graph/graphPathMode.ts';
import { EMPTY_FILTER, type FilterView } from '../../src/client/features/graph/graphFilter.ts';
import type { WorkflowEdge } from '../../src/client/workflowGraphData.ts';

/** 一条 3 跳链 a→b→c→d，外加一个孤立节点 z（判"不可达"用）。 */
const EDGES: WorkflowEdge[] = [
  { from: 'a', to: 'b' } as WorkflowEdge,
  { from: 'b', to: 'c' } as WorkflowEdge,
  { from: 'c', to: 'd' } as WorkflowEdge,
];
const ADJ = buildTraceAdjacency(EDGES);

describe('① 模式进入 / 退出', () => {
  it('未进入时是 PATH_IDLE（active=false 且两端都空）', () => {
    expect(PATH_IDLE).toEqual({ active: false, from: null, to: null });
  });

  it('toggle 进入 → 清空端点；再 toggle 退出并清空（不带着上一轮的起点）', () => {
    const entered = togglePathOf(PATH_IDLE);
    expect(entered.active).toBe(true);
    expect(entered.from).toBeNull();
    // 选了起点后再退出：端点必须一起清（否则下次进入会带着旧起点"半张弓"）。
    const exited = togglePathOf({ active: true, from: 'a', to: null });
    expect(exited).toEqual(PATH_IDLE);
  });

  it('未进入模式时 pick 是**空操作**（点击语义不被悄悄改写）', () => {
    const next = pathPickOf(PATH_IDLE, 'a');
    expect(next).toEqual(PATH_IDLE);
  });

  it('未进入模式时 exit 是空操作（幂等）', () => {
    expect(pathExitOf(PATH_IDLE)).toEqual(PATH_IDLE);
  });
});

describe('② 端点转移（三条：设起点 / 设终点 / 重开场）', () => {
  const ACTIVE = { active: true, from: null, to: null };

  it('第一次 pick → 设起点', () => {
    expect(pathPickOf(ACTIVE, 'a')).toEqual({ active: true, from: 'a', to: null });
  });

  it('第二次 pick（不同节点）→ 设终点', () => {
    expect(pathPickOf({ active: true, from: 'a', to: null }, 'd'))
      .toEqual({ active: true, from: 'a', to: 'd' });
  });

  it('第二次 pick 同一个起点 → 清空起点（"我选错了"）', () => {
    expect(pathPickOf({ active: true, from: 'a', to: null }, 'a'))
      .toEqual({ active: true, from: null, to: null });
  });

  it('两端都有后再 pick 第三个节点 → **重开场**（起点换成它），不是静默忽略', () => {
    const next = pathPickOf({ active: true, from: 'a', to: 'd' }, 'b');
    expect(next).toEqual({ active: true, from: 'b', to: null });
    // 反向自检：若实现"忽略第三下"，上面这条会红（from 仍是 a、to 仍是 d）。
    expect(next.to).toBeNull();
  });

  it('两端都有后 pick 起点本身 → 清空起点（同一条"再点一次取消"语义）', () => {
    expect(pathPickOf({ active: true, from: 'a', to: 'd' }, 'a'))
      .toEqual({ active: true, from: null, to: null });
  });

  it('转移是幂等安全的：清空后再点同一节点只是重新设起点', () => {
    expect(pathPickOf({ active: true, from: null, to: null }, 'a'))
      .toEqual({ active: true, from: 'a', to: null });
  });
});

describe('③ 读数（status / length / highlight / blast）', () => {
  it('未进入模式 → 空模型（零占位：渲染层据此不画状态条）', () => {
    const model = pathModelOf(PATH_IDLE, ADJ);
    expect(model.active).toBe(false);
    expect(model.highlight.size).toBe(0);
    expect(model.blast).toBeNull();
    expect(model.result).toBeNull();
  });

  it('进入但未选 → pickStart（第一句文案是"选起点"）', () => {
    const model = pathModelOf({ active: true, from: null, to: null }, ADJ);
    expect(model.status).toBe('pickStart');
    expect(model.blast).toBeNull();
  });

  it('选了起点 → pickEnd，且**起点的影响半径**已可读（先读数再决定要不要找）', () => {
    const model = pathModelOf({ active: true, from: 'a', to: null }, ADJ);
    expect(model.status).toBe('pickEnd');
    expect(model.blast?.down.d1).toBe(1); // a→b
    expect(model.blast?.down.d2).toBe(1); // a→b→c
    expect(model.blast?.down.d3).toBe(1); // a→b→c→d
    expect(model.blast?.up.total).toBe(0); // a 没有入边
  });

  it('两端都选且有路径 → found，length 与 highlight 覆盖整条链', () => {
    const model = pathModelOf({ active: true, from: 'a', to: 'd' }, ADJ);
    expect(model.status).toBe('found');
    expect(model.length).toBe(3);
    expect([...model.highlight].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(model.result?.path).toEqual(['a', 'b', 'c', 'd']);
  });

  /*
   * cycle-96 语义收紧：`noPath` 拆成 `unreachable` 与 `tooLong`。
   *
   * 旧断言 `toBe('noPath')` 把两种失败揉成一态，而 `findPath` 早已区分它们：
   *   - `reason === 'unreachable'`  → 图上真的没有这条路径 ⇒ 该换端点
   *   - `reason` 点名跳数上限        → 路径可能存在，只是超预算 ⇒ 该抬上限
   * 视图层比数据层更粗，正是本仓「数据源 A 与视图 B 一致吗要用跨源对账」的同族缺陷。
   */
  it('不可达 → unreachable（且 highlight 为空 —— 高亮一条不存在的链等于撒谎）', () => {
    const model = pathModelOf({ active: true, from: 'a', to: 'z' }, ADJ);
    expect(model.status).toBe('unreachable');
    expect(model.highlight.size).toBe(0);
    expect(model.length).toBe(0);
    expect(model.result?.found).toBe(false);
    // 与数据层同口径：reason 必须是结构性不可达，而不是"超上限"被误分类。
    expect(model.result?.reason).toBe('unreachable');
  });

  /*
   * cycle-109（U4 ③）语义升级：d → a **正向**不可达，而 a → b → c → d 是通的。
   *
   * 旧断言把它记成 `unreachable` —— 那是把"方向反了"与"真的不连通"揉成一态。
   * 两种结论的补救动作完全不同：前者该**把端点对调**，后者该换节点。
   * 所以这一条改为 `reverseOnly`，并由下一条"两向都不通仍必须是 unreachable"
   * 守住反向自检：若实现写成"只要正向不通就 reverseOnly"，下一条必红。
   */
  it('正向不通但反向可达 → reverseOnly（有向可达，不是无向连通）', () => {
    const model = pathModelOf({ active: true, from: 'd', to: 'a' }, ADJ);
    expect(model.status).toBe('reverseOnly');
    // 高亮按**用户选的** from → to 方向给出（翻转过的反链，不是原始的 a→…→d 顺序）。
    expect(model.result?.path).toEqual(['d', 'c', 'b', 'a']);
    expect(model.length).toBe(3);
    expect([...model.highlight]).toEqual(['d', 'c', 'b', 'a']);
    // 反向自检：反向通 ≠ 正向通 —— 状态绝不能塌成 found。
    expect(model.status).not.toBe('found');
  });

  it('两向都不通 → unreachable（若把 reverseOnly 写成"正向不通就 reverseOnly"，这条会红）', () => {
    // z 是孤立节点：z → a 不通，反向 a → … → z 同样不通。
    const model = pathModelOf({ active: true, from: 'z', to: 'a' }, ADJ);
    expect(model.status).toBe('unreachable');
    expect(model.result?.found).toBe(false);
    // 没有候选路径：reverseOnly 只允许在"反向真的找到"时出现。
    expect(model.candidates).toEqual([]);
  });

  it('超跳数上限 → tooLong（**不是** unreachable：路径可能存在，只是超预算）', () => {
    /*
     * 造一条**严格超过** MAX_PATH_HOPS 的链：n0 → n1 → … → n{H+1}。
     *
     * 为什么不用"把 maxHops 参数放大再断言 found"：`findPath` 内部
     * `Math.min(MAX_PATH_HOPS, …)` 把参数**夹**到绝对上限（那是有意的安全上界，
     * 不接受"结果超出一点点"）。所以验证"路径确实存在、只是超预算"只能在
     * **同一预算下**比：链长 = 上限 + 1 ⇒ 必然超；而把它缩到上限 ⇒ 必然 found。
     * 两条一起才证明 `tooLong` 是"预算不够"而非"不存在"。
     */
    const H = MAX_PATH_HOPS;
    const chain = (len: number) => {
      const edges = Array.from({ length: len }, (_, i) => ({
        from: `n${String(i)}`, to: `n${String(i + 1)}`, type: 'flow',
      })) as unknown as Parameters<typeof buildTraceAdjacency>[0];
      return buildTraceAdjacency(edges);
    };
    // 链长 H+1（= 7 条边 ⇒ 7 跳），超过上限 6。
    const tooFar = pathModelOf({ active: true, from: 'n0', to: `n${String(H + 1)}` }, chain(H + 1));
    expect(tooFar.status).toBe('tooLong');
    // 对照：同样形状但链长恰好 = 上限，必须 found（证明不是图不连通）。
    const justOk = pathModelOf({ active: true, from: 'n0', to: `n${String(H)}` }, chain(H));
    expect(justOk.status).toBe('found');
    expect(justOk.length).toBe(H);
  });

  it('两端相同 → duplicate（**不是** found：length=0 的"路径"不是用户要的东西）', () => {
    const model = pathModelOf({ active: true, from: 'a', to: 'a' }, ADJ);
    expect(model.status).toBe('duplicate');
    expect(model.length).toBe(0);
    expect(model.highlight.size).toBe(0);
    // 反向自检：findPath 对 from===to 返回 found=true，本层必须拦成 duplicate。
    expect(model.result).toBeNull();
  });

  it('反向自检：把 status 实现成"两端不空就 found"，上面两类失败都会红', () => {
    const wrong = (from: string | null, to: string | null): string => (from !== null && to !== null ? 'found' : 'pickEnd');
    expect(wrong('a', 'z')).toBe('found'); // 错误实现给出的答案
    expect(pathModelOf({ active: true, from: 'a', to: 'z' }, ADJ).status).toBe('unreachable');
  });
});

describe('④ 路径高亮并入筛选视图（复用既有渲染语义）', () => {
  const base: FilterView = { matching: new Set(['a', 'b', 'c', 'd']), highlight: new Set(['a']), active: false };

  it('空高亮 → 原视图不变（未被进入时不影响邻接高亮）', () => {
    expect(withPathHighlight(base, new Set())).toBe(base);
  });

  it('非空高亮 → highlight **被替换**（不是求交：路径链外的邻居不该被点亮）', () => {
    const merged = withPathHighlight(base, new Set(['a', 'b', 'c', 'd']));
    expect([...merged.highlight].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.matching).toEqual(base.matching); // matching 不受影响（筛选是另一回事）
  });

  it('路径链外的节点**不在**高亮里（求交实现会把它们点亮）', () => {
    const merged = withPathHighlight(base, new Set(['a', 'd']));
    expect(merged.highlight.has('b')).toBe(false);
  });

  it('返回的 Set 是**新副本**（调用方改它不会污染输入）', () => {
    const src = new Set(['a']);
    const merged = withPathHighlight(base, src);
    src.add('b');
    expect(merged.highlight.size).toBe(1);
  });
});
