/**
 * 图谱 UX 契约（cycle-96 WS-D）—— 「所见即所得」的导出 + 路径结果显式反馈。
 *
 * ## 被守卫的缺陷（cycle-95 明确登记的诚实边界）
 *
 * cycle-95 交付了节点角色（entry/hub/leaf/orphan，形状通道 + 描边宽度档），
 * 但只画在**屏幕上**。导出 SVG 走的是 `graphExportSvg.serializeGraphSvg` 这条
 * **独立的序列化路径**（不经 `renderNode`），所以导出的图里角色通道**完全缺失**。
 *
 * 后果不是"风格不统一"，是**信息丢失**：用户导出一张图给同事看，对方拿到的是一张
 * 「枢纽门禁（9 条入边）与一次性门禁（1 条入边）长得一模一样」的图 ——
 * 而屏幕上那张明明能分出来。导出的唯一正确语义是「所见即所得」（见该文件头注）。
 *
 * ## 判据为什么用「同源」而不是「数数」
 *
 * 弱判据：`导出文本里出现 data-anic-node-role` ⇒ 恒真（随便画一个就有）。
 * 强判据：**导出与屏幕的角色集合必须逐节点相同** —— 两边都调 `buildNodeRoles`，
 * 若有人日后在导出处"自己算一套"或"漏掉某类角色"，逐节点比对立刻不等。
 * 这正是本仓 `graphRelationCompletenessContract` 用的「跨源对账」范式。
 *
 * ## 反向自检（守卫必须有牙）
 *
 * 喂一份**移除角色字段**的导出文本，判据必须翻假。若判据写成
 * `includes('data-anic-node-role')` 这种存在性断言，这条变异抓不到它。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeGraphSvg } from '../../src/client/features/graph/graphExportSvg.ts';
import { buildNodeRoles } from '../../src/client/features/graph/graphNodeRole.ts';
import { MAX_PATH_HOPS } from '../../src/client/features/graph/graphPathFind.ts';
import { pathModelOf } from '../../src/client/features/graph/graphPathMode.ts';
import { TOOLBAR_ROW_BUDGET, estimateToolbarRows, toolbarDensityOf } from '../../src/client/features/graph/graphToolbarDensity.ts';
import { buildTraceAdjacency } from '../../src/client/features/graph/graphTrace.ts';
import { layoutGraph } from '../../src/client/features/graph/graphLayout.ts';
import type { GraphData } from '../../src/client/features/graph/renderGraph.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 真实快照（与屏幕共用同一份数据源）。
 *
 * 为什么用真实快照而不造 fixture：角色的**语义**只有在大图上才成立
 * （34 节点 / 79 边里 hub=gate-g0..g3 各 9 条入边、orphan=aux:auto 度 0）。
 * 造一个小 fixture 可以让"四类角色都出现"变成人为布置，测不出真实分布。
 */
function realSnapshot(): GraphData {
  const raw = readFileSync(join(ROOT, 'artifacts', 'workflow-snapshot.json'), 'utf8');
  const parsed = JSON.parse(raw) as { nodes?: unknown; edges?: unknown };
  const nodes = (parsed.nodes ?? []) as GraphData['nodes'];
  const edges = (parsed.edges ?? []) as GraphData['edges'];
  return { nodes, edges };
}

/** 从导出文本里抽 `data-anic-node-role="X"` 出现次数（按角色名分组）。 */
function roleCountsInSvg(svg: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of svg.matchAll(/data-anic-node-role="([^"]+)"/g)) {
    const r = m[1] as string;
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

/** 屏幕侧同一判据：`buildNodeRoles` 的角色分布（导出必须与它一致）。 */
function roleCountsOnScreen(data: GraphData): Record<string, number> {
  const roles = buildNodeRoles(data.edges, data.nodes.map((n) => n.id));
  const counts: Record<string, number> = {};
  for (const role of roles.values()) {
    if (role === null) continue;
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

describe('cycle-96 图谱 UX 契约', () => {
  it('① 导出 SVG 带角色通道，且与屏幕**逐角色计数相同**（跨源对账，非存在性断言）', () => {
    const data = realSnapshot();
    expect(data.nodes.length, '快照为空 = 本契约空转').toBeGreaterThan(10);
    const layout = layoutGraph(data.nodes, data.edges);
    const svg = serializeGraphSvg({ edges: data.edges, layout });

    const screen = roleCountsOnScreen(data);
    const exported = roleCountsInSvg(svg);

    // 双向相等：导出多出一类（自己算了一套）或漏掉一类（某角色没画）都必须红。
    expect(exported, '导出图的角色分布与屏幕不一致（导出的不是所见即所得）').toEqual(screen);
    // 非空下限：四类角色在真实快照上确实都出现了（否则上面的相等是空对空）。
    expect(Object.keys(screen).length, '真实快照上角色类别不足 —— 相等断言退化成空转')
      .toBeGreaterThanOrEqual(3);
  });

  it('② 角色形状标记同源：每个带角色的节点恰有一个 `<path>` 标记', () => {
    const data = realSnapshot();
    const layout = layoutGraph(data.nodes, data.edges);
    const svg = serializeGraphSvg({ edges: data.edges, layout });

    const withRole = [...svg.matchAll(/data-anic-node-role="([^"]+)"/g)].length;
    const marks = [...svg.matchAll(/data-anic-node-role-mark="true"/g)].length;
    expect(marks, `角色节点 ${String(withRole)} 个但形状标记 ${String(marks)} 个 —— 标记与角色不同源`)
      .toBe(withRole);
    expect(marks, '一个角色标记都没有 = 形状通道未落地').toBeGreaterThan(0);
  });

  it('③ 反向自检：从导出文本里抹掉角色字段后，判据必须翻假（证明 ① 不是恒真）', () => {
    const data = realSnapshot();
    const layout = layoutGraph(data.nodes, data.edges);
    const svg = serializeGraphSvg({ edges: data.edges, layout });
    const screen = roleCountsOnScreen(data);
    // 原始文本必须通过（前向）
    expect(roleCountsInSvg(svg)).toEqual(screen);
    // 变异：抹掉全部角色字段（模拟"实现回退成不画角色"）
    const mutant = svg.replace(/ data-anic-node-role="[^"]+"/g, '');
    expect(roleCountsInSvg(mutant), '抹掉角色字段后仍判等 ⇒ 判据是恒真装饰').not.toEqual(screen);
    expect(roleCountsInSvg(mutant)).toEqual({});
  });

  it('④ 导出仍是**单** svg 根 + 合法 XML 骨架（角色标记不得引入第二个根）', () => {
    const data = realSnapshot();
    const layout = layoutGraph(data.nodes, data.edges);
    const svg = serializeGraphSvg({ edges: data.edges, layout });
    expect((svg.match(/<svg /g) ?? []).length, '导出文本出现多个 <svg> 根').toBe(1);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  /*
   * ⑤ 路径失败分类：视图层**不得比数据层更粗**。
   *
   * 被守卫的缺陷（cycle-96 实测）：`findPath` 早已区分
   *   - `reason === 'unreachable'` → 图上真的没有（该换端点）
   *   - `reason` 点名跳数上限      → 可能存在但超预算（该抬上限）
   * 而 `PathStatus` 把它们合并成单一的 `noPath` ⇒ 两种完全不同的补救动作
   * 被渲染成同一句话，用户只能靠猜。这是「信息在类型层丢失」。
   *
   * 判据双向：
   *   ① 不可达必须分类成 `unreachable`（不是 `tooLong`）；
   *   ② 超上限必须分类成 `tooLong`（不是 `unreachable`），且**同形状的短链**必须 `found`
   *      —— 后者证明"超上限"是预算问题而非图不连通。
   */
  it('⑤ 路径失败分类与数据层同口径：unreachable ⇄ tooLong 双向可分，短链对照必须 found', () => {
    const H = MAX_PATH_HOPS;
    // 链长 n 条边（n 跳）。
    const chain = (len: number) => buildTraceAdjacency(
      Array.from({ length: len }, (_, i) => ({ from: `n${String(i)}`, to: `n${String(i + 1)}`, type: 'flow' })) as never,
    );

    const far = pathModelOf({ active: true, from: 'n0', to: `n${String(H + 1)}` }, chain(H + 1));
    expect(far.status, '超上限被判成 unreachable ⇒ 分类丢失（用户会去换端点而不是抬上限）').toBe('tooLong');

    const ok = pathModelOf({ active: true, from: 'n0', to: `n${String(H)}` }, chain(H));
    expect(ok.status, '同形状短链必须 found —— 否则上面的 tooLong 无法区分"超预算"与"不连通"').toBe('found');
    expect(ok.length).toBe(H);

    // 真不连通（两块独立图）必须 unreachable。
    const split = buildTraceAdjacency([
      { from: 'a', to: 'b', type: 'flow' },
      { from: 'c', to: 'd', type: 'flow' },
    ] as never);
    const dead = pathModelOf({ active: true, from: 'a', to: 'd' }, split);
    expect(dead.status, '结构性不可达被判成 tooLong ⇒ 用户会去抬上限，而抬到天上也没用').toBe('unreachable');
  });

  /*
   * ⑥ 工具栏纵向占用**不得超过预算**（cycle-96 WS-D3）。
   *
   * 被守卫的缺陷形态：工具栏是 `flexWrap: wrap`，7 个组 + 图例行在窄面板下折成 3–4 行，
   * 把图区往下推。此前**没有任何断言在看这件事** ⇒ 每加一个控件都悄悄多占一行，
   * 而"排版是否恶化"只能靠肉眼（等于无法评审）。
   *
   * 判据来自 `graphToolbarDensity.TOOLBAR_ROW_BUDGET`（**唯一**来源，不在此另写数字）。
   * 读数与渲染是**同一次计算**（渲染把结果写进 `data-anic-toolbar-est-rows`），
   * 契约不自己重算 —— 重算就是两套真相。
   *
   * 反向自检：再塞两个组，估行数必须真的超预算（否则预算判据形同虚设）。
   */
  it('⑥ 工具栏估行数 ≤ 预算，且"再加一组"会真的超预算（守卫有牙）', () => {
    // 全开形态：视图 + 路径 + 角色图例都在（最坏情形）。
    const full = toolbarDensityOf({ hasView: true, hasPath: true, hasRoleLegend: true });
    const rowsFull = estimateToolbarRows(full);
    expect(rowsFull, `全开形态估 ${String(rowsFull)} 行，超预算 ${String(TOOLBAR_ROW_BUDGET)} —— 加控件把图区推下去了`)
      .toBeLessThanOrEqual(TOOLBAR_ROW_BUDGET);

    // 组数确实是数据驱动的（不是手写常量）：条件组开关必须改变计数。
    const minimal = toolbarDensityOf({ hasView: false, hasPath: false, hasRoleLegend: false });
    expect(full.total, '条件组开关没有改变组数 ⇒ 读数是常量而非结构').toBeGreaterThan(minimal.total);

    // 反向自检：再加两个组（模拟继续塞控件），必须真的超预算。
    const overloaded = { ...full, total: full.total + 2, rendered: full.rendered + 2 };
    expect(estimateToolbarRows(overloaded), '多加两组仍未超预算 ⇒ 预算判据形同虚设')
      .toBeGreaterThan(TOOLBAR_ROW_BUDGET);
  });
});
