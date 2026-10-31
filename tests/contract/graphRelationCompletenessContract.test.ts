/**
 * **图谱关系完整性契约**（cycle-94）—— 断言「声明的每一条边都真的出现在图上」。
 *
 * ## 被守卫的缺陷（实测，这是「图谱关系逻辑不完整」的真因）
 *
 * 真实 `.cycles/workflow-graph.yaml` 声明 **15 条**边，而快照只画出 **7 条**。
 * 丢掉的 8 条恰好是 `gate-chain(3) + phase-transition(1) + circuit-breaker(4)`：
 *
 * | 丢掉的关系 | 图上后果 |
 * |---|---|
 * | `gate-chain`（G0→G1→G2→G3） | 四个门禁**全成孤点**，看不到"过了 G0 才查 G1" |
 * | `phase-transition`（G3→test） | 门禁全过后**推进到下一阶段**这条主线消失 |
 * | `circuit-breaker`（Gx→micro） | **熔断反馈环**消失 —— 工作流变成单向直线 |
 *
 * 实测后果是真实图裂成 **14 个连通分量 / 8 个孤立节点**。
 * 一个"工作流图"如果连不通，它展示的就不是流程，只是一堆卡片。
 *
 * ## 为什么既有契约拦不住（这条教训比缺陷本身重要）
 *
 * `graphInteractiveContract` 断言「边锚点数 == `counts.edges`」。
 * 但那两边**取自同一份已经丢边的数据** —— 是自证同义反复，永远绿。
 *
 * ⇒ 完整性判据必须**跨两个独立来源对账**：
 * 一边是 **YAML 声明的原文**（用文本行数逐条解析，不经过业务解析器），
 * 另一边是**装配出来的快照**。只有跨源比对才能发现"解析器静默吞边"。
 *
 * ## 三条守卫纪律
 *
 * ① **逐条对账**（不是只比总数）：两条错配同数量会互相抵消，总数相等是假绿；
 * ② **反向自检**：喂一份"缺少 type 组"的 yaml，判定必须报红（证明它不是永真）；
 * ③ **连通性下限**：真实图必须是一个**单一连通分量**（这是"工作流"的定义性质，
 *    比"边数相等"更强 —— 即使边数对了，若边接错地方，图照样是碎的）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowGraph } from '../../src/shared/snapshotProjection/snapshotSource.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YAML_PATH = join(ROOT, '.cycles', 'workflow-graph.yaml');

/**
 * **独立**的声明边提取器（不经过 `parseWorkflowGraph`）。
 *
 * 为什么必须独立：如果两边都用同一个解析器，"解析器丢边"就会同时发生在两边
 * ⇒ 对账永远相等 ⇒ 契约恒绿。这正是既有契约失效的机理。
 *
 * 这里只用**文本行**判断"哪一行声明了一条边"，再从每行里抽 from/to/type。
 * 它比业务解析器更"笨"，但这正是它的价值：笨实现不会和被测实现一起犯同样的错。
 */
function declaredEdgesFromText(text: string): Array<{ from: string; to: string; type: string }> {
  const out: Array<{ from: string; to: string; type: string }> = [];
  let inEdges = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^edges:/.test(line)) { inEdges = true; continue; }
    // 顶层键（无缩进）结束 edges 段
    if (/^\S/.test(line)) { if (inEdges) inEdges = false; continue; }
    if (!inEdges) continue;
    // 一行一条边：必须以 `- { from:` 开头（这是技能侧 yaml 的唯一形态）
    if (!/^\s*-\s*\{\s*from:/.test(line)) continue;
    const from = /\bfrom:\s*([\w-]+)/.exec(line)?.[1];
    const to = /\bto:\s*([\w-]+)/.exec(line)?.[1];
    const type = /\btype:\s*"([^"]+)"/.exec(line)?.[1];
    if (from !== undefined && to !== undefined) {
      out.push({ from, to, type: type ?? 'flow' });
    }
  }
  return out;
}

/** 无向连通分量数（工作流图必须是 1）。 */
function componentCount(nodeIds: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): number {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const seen = new Set<string>();
  let count = 0;
  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    count += 1;
    const stack = [id];
    seen.add(id);
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const nb of adj.get(cur ?? '') ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return count;
}

describe('图谱关系完整性契约（cycle-94）', () => {
  const yamlText = readFileSync(YAML_PATH, 'utf8');
  const declared = declaredEdgesFromText(yamlText);
  const parsed = parseWorkflowGraph(yamlText);
  const parsedEdgeKey = (e: { from: string; to: string; type: string }): string => `${e.from}->${e.to}:${e.type}`;
  const ids = parsed.nodes.map((n) => n.id);

  it('① 逐条对账：声明的每一条边都出现在解析结果里（含类型）', () => {
    // 扫描集非空下限：yaml 真被读到、真有边，否则下面全是空对空。
    expect(declared.length, '未从 yaml 读到任何边 —— 提取器或文件坏了').toBeGreaterThanOrEqual(10);
    expect(parsed.edges.length, '解析结果没有任何边').toBeGreaterThan(0);

    const got = new Set(parsed.edges.map(parsedEdgeKey));
    const missing = declared.filter((d) => !got.has(parsedEdgeKey(d)));
    // 失败信息逐条点名缺失的边（只说"少了 N 条"的话，下一个人得自己 diff）
    expect(
      missing.map(parsedEdgeKey),
      `解析器吞掉了这些边（图上将缺少这些关系）：${missing.map(parsedEdgeKey).join(' | ')}`,
    ).toEqual([]);
  });

  it('② 边类型不丢：解析出的 type 与原声明一致（不是被兜底成 flow）', () => {
    /*
     * 这一条守的是**第二层缺陷**：放宽正则的第一次尝试里，边数从 7 恢复到 15，
     * 但 15 条的 type **全部变成了 "flow"** —— 惰性 `\S+?` 让可选的 type 组永远跳过。
     * 边数对了、语义全丢，比原来更危险（图看起来完整了，但线型全是同一种）。
     *
     * ⇒ 必须逐条比对 type，而不能只比 from/to。
     */
    const byPair = new Map<string, string>();
    for (const e of parsed.edges) byPair.set(`${e.from}->${e.to}`, e.type);
    const wrong: string[] = [];
    for (const d of declared) {
      const gotType = byPair.get(`${d.from}->${d.to}`);
      if (gotType !== d.type) wrong.push(`${d.from}->${d.to}: 期望 ${d.type} 实得 ${String(gotType)}`);
    }
    expect(wrong, `边类型丢失/错误：${wrong.join(' | ')}`).toEqual([]);
    // 真实 yaml 里确实存在多种类型（否则这条断言在单类型数据上是空的）
    const typeSet = new Set(declared.map((d) => d.type));
    expect(typeSet.size, '声明里应当有多种边类型').toBeGreaterThanOrEqual(4);
  });

  it('③ 连通性：声明的整张工作流图是**单一连通分量**（这是"工作流"的定义性质）', () => {
    /*
     * 为什么这条比"边数相等"更强：即使边数一条不少，只要边接错了地方，
     * 图照样是碎的。实测修复前是 14 个分量 / 8 个孤立节点。
     *
     * 注意：只对**声明图**（yaml 的 nodes+edges）断言连通 —— 运行时快照还含
     * 归档节点、账本事件等"附加层"，它们的连通性另有约束（不在此契约）。
     */
    expect(ids.length, '声明节点为空').toBeGreaterThan(0);
    const comps = componentCount(ids, parsed.edges);
    // 逐分量的诊断信息：只说"不等于 1"的话，无法定位是哪块断了。
    expect(comps, `声明图裂成 ${String(comps)} 个连通分量（应为 1）`).toBe(1);
    // 且没有孤立节点（度 0 = 这个节点在图上没有任何关系）
    const degree = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const e of parsed.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const isolated = [...degree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    expect(isolated, `声明图里有孤立节点（没有任何关系）：${isolated.join(', ')}`).toEqual([]);
  });

  it('④ 反向自检：把 `type` 字段整段删掉后，① 必须能感知（证明它不是永真）', () => {
    // 构造一份"声明里带 type、但解析器读不到 type"的形态：把 yaml 的 type 值改成非法引号
    // （解析器的 `"([^"]+)"` 抓不到 ⇒ 回落 'flow' ⇒ ② 必红）。
    const broken = yamlText.replace(/type:\s*"([^"]+)"/g, 'type: ($1)');
    const parsedBroken = parseWorkflowGraph(broken);
    const wrong: string[] = [];
    for (const d of declared) {
      const hit = parsedBroken.edges.find((e) => e.from === d.from && e.to === d.to);
      if (hit === undefined || hit.type !== d.type) wrong.push(`${d.from}->${d.to}`);
    }
    // 这正是 ② 会抓到的：证明那条断言不是哑的。
    expect(wrong.length, '篡改副本应当让 ② 报红，但它没感知到').toBeGreaterThan(0);
  });

  it('⑤ 反向自检：把带 condition 的边整段注释掉后，① 必须报缺失', () => {
    // 模拟"解析器吞掉带 condition 的边"这一原始缺陷形态。
    const stripped = yamlText
      .split('\n')
      .map((l) => (l.includes('condition:') ? '' : l))
      .join('\n');
    const got = declaredEdgesFromText(stripped);
    // 独立提取器仍能读到剩下的边（证明它自己没坏）
    expect(got.length).toBeGreaterThan(0);
    // 而"原声明 vs 被删后的结果"必然缺边 —— ① 用的就是这条判据
    const lost = declared.filter((d) => !got.some((g) => g.from === d.from && g.to === d.to));
    expect(lost.length, '删掉带 condition 的边后应当感知到缺失').toBeGreaterThan(0);
  });
});
