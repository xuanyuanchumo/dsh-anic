/**
 * 工作流图的**声明字段与依赖图**契约（cycle-91）。
 *
 * ## 为什么钉这个（本轮实测的最严重缺陷）
 *
 * **实测缺陷**：`workflow-graph.yaml` 里的 `next:` / `on_pass:` / `on_fail:`
 * **完全未被解析**（`parseWorkflowGraph` 只认 `id:` / `type:` / `gate:` /
 * `triggers:`）。后果实测：
 *
 * - 运行时图里**根本没有宏观主线**（`plan→design→build→test→deploy→maintain`）；
 * - 依赖入度 = 0 的节点 **9 个**（`plan`/`design`/`build`/`deploy`/`maintain`/
 *   `micro-plan`/`micro-verify`/`micro-gate`/`micro-retro`）；
 * - `gate-g0` 的唯一前驱 `micro-retro` 入度 = 0 ⇒ `advance('gate-g0')`
 *   **恒返回** `predecessor micro-retro not done` ⇒ **整条 gate-chain 锁死**。
 *
 * ## 为什么既有契约全绿（覆盖盲区，不是测试失效）
 *
 * `tests/contract/stateMachineGraphShape.test.ts` 只断言「解析出 N 个节点 /
 * 边是流式形态 / type 小写」—— **从不断言「节点可达」**。
 * ⇒ 本文件专门补**可达性**与**推进链**断言。
 *
 * ## 三个语义区分（本文件的核心决策）
 *
 * | 字段 | 语义 | 是依赖边？ |
 * |---|---|---|
 * | `next:` | 顺序声明（含**回环**） | ✅ 是，但**回环边断开** |
 * | `on_pass:` / `on_fail:` | 条件后继（不是前置条件） | ❌ 否 |
 * | `edges:` 的 `circuit-breaker` | 失败分支（回退路径） | ❌ 否 |
 *
 * 为什么 `next:` 不能原样当依赖：`maintain → plan` 与
 * `micro-retro → micro-eval` 都是**显式回环**（注释明写「形成宏观/微观
 * 循环」）⇒ 原样入依赖图 ⇒ 环上每个节点都要求对方先完成 ⇒
 * 「所有前驱都 done」**永远无法满足** ⇒ 宏观循环一次都推不动。
 *
 * ⇒ 断环判据：**Tarjan SCC** 找环 + **声明序最早**的节点为环入口 +
 * 断开「指向入口」的那条边。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWorkflowGraph,
  buildGraphIndex,
  initState,
  advance,
  type WorkflowGraph,
} from '../../src/host/runtime/stateMachine.ts';
import { parseNodeDeclarationFields } from '../../src/host/runtime/stateMachineFields.ts';
import {
  isDependentEdgeType,
  expandNextEdges,
  cycleEntryOf,
  buildDependentNextEdges,
} from '../../src/host/runtime/stateMachineGraph.ts';
import { tarjanScc } from '../../src/host/runtime/tarjanScc.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 本仓真实图。 */
function realGraph(): WorkflowGraph {
  return parseWorkflowGraph(readFileSync(join(ROOT, '.cycles', 'workflow-graph.yaml'), 'utf8'));
}

/** 依赖入度 = 0 的节点。 */
function rootsOf(graph: WorkflowGraph): string[] {
  const idx = buildGraphIndex(graph);
  return graph.nodes.filter((n) => (idx.predecessors.get(n.id) ?? []).length === 0).map((n) => n.id);
}

describe('cycle-91：next:/on_pass:/on_fail: 声明字段解析', () => {
  it('`next:` 被解析（修复前 0 个节点有该字段）', () => {
    const g = realGraph();
    const withNext = g.nodes.filter((n) => n.next !== undefined);
    // 本仓真实图有 13 处 `next:`（6 宏观 + 7 微观）。
    expect(withNext.length, '`next:` 完全未被解析（cycle-91 实测缺陷）').toBeGreaterThanOrEqual(13);
    expect(withNext.find((n) => n.id === 'plan')?.next).toBe('design');
    expect(withNext.find((n) => n.id === 'maintain')?.next).toBe('plan');
  });

  it('`on_pass:` / `on_fail:` 被解析为节点字段（条件后继，**不是**依赖边）', () => {
    const g = realGraph();
    const g0 = g.nodes.find((n) => n.id === 'gate-g0');
    expect(g0?.onPass, 'gate-g0 的 on_pass 未被解析').toBe('gate-g1');
    expect(g0?.onFail, 'gate-g0 的 on_fail 未被解析').toBe('micro-eval');
  });

  it('行尾注释被正确剥离（`next: plan  # 回到 Plan`）', () => {
    expect(parseNodeDeclarationFields('    next: plan  # 回到 Plan，形成宏观循环')).toEqual({ id: '', next: 'plan' });
    expect(parseNodeDeclarationFields('    on_pass: gate-g1  # 通过则进下一门')).toEqual({ id: '', onPass: 'gate-g1' });
  });

  it('非声明字段不被误解析（label:/description:/artifacts: 保持沉默）', () => {
    expect(parseNodeDeclarationFields('    label: "Plan（规划）"')).toBeNull();
    expect(parseNodeDeclarationFields('    description: "理解需求"')).toBeNull();
    expect(parseNodeDeclarationFields('    artifacts:')).toBeNull();
    expect(parseNodeDeclarationFields('      - intent/intent.md')).toBeNull();
  });
});

describe('cycle-91：边类型分流（依赖 vs 引用/回退）', () => {
  it('circuit-breaker **不**是依赖边（否则目标要等"回退源"⇒ 成环死锁）', () => {
    expect(isDependentEdgeType('circuit-breaker')).toBe(false);
  });

  it('主线边是依赖边', () => {
    for (const t of ['human-gate', 'gate-chain', 'phase-transition', 'micro-entry', 'micro-exit']) {
      expect(isDependentEdgeType(t), `${t} 应是依赖边`).toBe(true);
    }
    // 无 type 的纯文本边按依赖处理（它通常就是主线）。
    expect(isDependentEdgeType(undefined)).toBe(true);
  });
});

describe('cycle-91：Tarjan SCC 与环入口（断环判据）', () => {
  it('宏观环被识别为一个 SCC', () => {
    const g = realGraph();
    const nextEdges = expandNextEdges(g.nodes);
    const sccs = tarjanScc(g.nodes.map((n) => n.id), nextEdges);
    const macro = sccs.find((c) => c.includes('plan') && c.includes('maintain'));
    expect(macro, '宏观环未被识别为 SCC').toBeDefined();
    expect(macro).toContain('design');
    expect(macro).toContain('build');
  });

  it('微观环被识别为**另一个** SCC（两个环互不相交）', () => {
    const g = realGraph();
    const nextEdges = expandNextEdges(g.nodes);
    const sccs = tarjanScc(g.nodes.map((n) => n.id), nextEdges);
    const macro = sccs.find((c) => c.includes('plan'));
    const micro = sccs.find((c) => c.includes('micro-eval'));
    expect(macro).toBeDefined();
    expect(micro).toBeDefined();
    // 宏观环不含微观节点，反之亦然。
    expect(macro?.some((id) => id.startsWith('micro-'))).toBe(false);
    expect(micro?.some((id) => ['plan', 'design', 'build', 'test', 'deploy', 'maintain'].includes(id))).toBe(false);
  });

  it('环入口 = **声明序最早**的节点（纯环里图论上无入口 ⇒ 语义判据）', () => {
    const g = realGraph();
    const nextEdges = expandNextEdges(g.nodes);
    const declIndex = new Map<string, number>();
    g.nodes.forEach((n, i) => declIndex.set(n.id, i));
    const declOrder = (id: string): number => declIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
    const sccs = tarjanScc(g.nodes.map((n) => n.id), nextEdges);
    const macro = sccs.find((c) => c.includes('plan'));
    expect(macro).toBeDefined();
    // ⚠️ 纯环里每个节点都有分量内前驱 ⇒ 候选集为空 ⇒ 必须靠声明序兜底。
    expect(cycleEntryOf(macro ?? [], nextEdges, declOrder), '宏观环入口应为 plan').toBe('plan');
    const micro = sccs.find((c) => c.includes('micro-eval'));
    expect(cycleEntryOf(micro ?? [], nextEdges, declOrder), '微观环入口应为 micro-eval').toBe('micro-eval');
  });

  it('回环边被断开（`maintain→plan` / `micro-retro→micro-eval` 不进依赖集）', () => {
    const g = realGraph();
    const dep = buildDependentNextEdges(g.nodes, g.edges);
    const keys = dep.map((e) => `${e.from}->${e.to}`);
    expect(keys, '回环边 maintain->plan 未被断开').not.toContain('maintain->plan');
    expect(keys, '回环边 micro-retro->micro-eval 未被断开').not.toContain('micro-retro->micro-eval');
    // 主线边保留。
    expect(keys).toContain('plan->design');
    expect(keys).toContain('design->build');
    expect(keys).toContain('build->test');
  });
});

describe('cycle-91：**可达性**（既有契约的覆盖盲区）', () => {
  it('依赖入度 = 0 的节点**只应有 1 个**（修复前是 9 个）', () => {
    const roots = rootsOf(realGraph());
    expect(roots.length, `依赖入度=0 的节点有 ${String(roots.length)} 个：${roots.join(', ')}`).toBe(1);
    expect(roots[0], '起点应是 plan').toBe('plan');
  });

  it('宏观主线 6 个相位节点**互为链式前驱**', () => {
    const idx = buildGraphIndex(realGraph());
    expect(idx.predecessors.get('design')).toContain('plan');
    expect(idx.predecessors.get('build')).toContain('design');
    expect(idx.predecessors.get('test')).toContain('build');
    expect(idx.predecessors.get('deploy')).toContain('test');
    expect(idx.predecessors.get('maintain')).toContain('deploy');
  });

  it('`gate-g0` 的前驱是 `micro-retro`（不再是入度 0 的孤儿）', () => {
    const idx = buildGraphIndex(realGraph());
    expect(idx.predecessors.get('gate-g0')).toContain('micro-retro');
    expect(idx.predecessors.get('micro-retro')).toContain('micro-gate');
  });

  it('**整条推进链走得通**（修复前在 gate-g0 处锁死）', () => {
    const g = realGraph();
    let state = initState(g);
    const order = [
      'plan', 'design', 'build',
      'micro-eval', 'micro-plan', 'micro-task', 'micro-verify', 'micro-fix', 'micro-gate', 'micro-retro',
      'gate-g0', 'gate-g1', 'gate-g2', 'gate-g3',
      'test', 'deploy', 'maintain',
    ];
    const failures: string[] = [];
    for (const id of order) {
      const r = advance(g, state, id, { gateApproved: true });
      if (!r.ok) {
        failures.push(`${id}: ${r.reason ?? 'unknown'}`);
        break;
      }
      state = r.state;
    }
    expect(failures, `推进链在第 ${String(failures.length)} 步断裂：${failures.join(' | ')}`).toEqual([]);
    expect(state['maintain']?.status).toBe('done');
  });

  it('**不依赖断环也能推进**（断开回环边不破坏正常推进）', () => {
    // 反向自检：若断环逻辑有误（比如断错了边），推进链必然断裂。
    // 本用例与上一条互为对照：上一条证明"能走通"，本条证明"走通不是因为恰好没环"。
    const g = realGraph();
    const dep = buildDependentNextEdges(g.nodes, g.edges);
    expect(dep.length, '依赖 next 边数量异常').toBe(11); // 13 - 2 回环
  });
});
