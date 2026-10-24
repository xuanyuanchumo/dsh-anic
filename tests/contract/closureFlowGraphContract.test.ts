/**
 * 闭环**流动可视化**契约（cycle-75 T4）。
 *
 * ## 为什么要有独立守卫
 *
 * 「可视化流动」是本轮唯一新增的**呈现层派生**：它把投影重新算成节点/边。
 * 派生层最容易出的两类错都是**静默**的：
 *   ① 恒等式破：`notProduced + producedNotConsumed` 与 `registered − consumed` 不符
 *      ⇒ 图会把缺口画丢或画多（读图的人得出错结论，且没有任何报错）；
 *   ② 硬编码：把族名写死 ⇒ 新增族时图上**静默少一族**（本仓「族会继续长」已被
 *      cycle-75 自己验证过：三族 → 四族）。
 *
 * ## 判据
 *
 * ① **数据驱动**：改簇名后节点/边随之改变（不硬编码）；
 * ② **恒等式**：逐族 `notProduced + producedNotConsumed === registered − consumed`；
 * ③ **两种形态**：有产出锚点 → `viaProduction`；无写入点（词表）→ `directRead`
 *    且**不伪造**产出节点；
 * ④ **空输入** → `empty: true` 且渲染出可见空态（不是空白、不崩）；
 * ⑤ **渲染**：每族一行、缺口段带 `data-anic-flow-gap|notproduced|unread` 锚点、
 *    已消费按证据强弱分层可见；
 * ⑥ **反向自检**：同一判据能判两态（有族命中 / 空输入不命中），否则是恒真断言。
 *
 * 纪律：纯函数无副作用；夹具用拼接构造的假族名，不依赖真实族清单。
 */
import { describe, it, expect } from 'vitest';
import { buildClosureFlow, renderClosureFlow, type ClosureFlow } from '../../src/client/features/closure/closureFlowGraph.ts';
import { runClosureAudit, toClosureView } from '../../src/host/closureAudit/registryClosure.ts';
import type { ClosureClusterView, ClosureView } from '../../src/client/features/closure/closureTypes.ts';

/* ── 渲染树取词器（同 closureRenderOutputContract 手法：不依赖 DOM）── */
function walk(node: unknown, out: { anchors: string[]; texts: string[] }): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return; }
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return; }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('data-anic') && typeof v === 'string') out.anchors.push(k + '=' + v);
  }
  walk(props['children'], out);
}
function probe(node: unknown): { anchors: string[]; text: string } {
  const out = { anchors: [] as string[], texts: [] as string[] };
  walk(node, out);
  return { anchors: out.anchors, text: out.texts.join(' | ') };
}

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

function cluster(over: Partial<ClosureClusterView> & { cluster: string }): ClosureClusterView {
  return {
    unit: 'u', total: 0, consumed: 0, codeConsumed: 0, unconsumed: 0,
    producedByKind: { 'register-call': 0, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 },
    ...over,
  } as ClosureClusterView;
}

function view(clusters: ClosureClusterView[], over: Partial<ClosureView> = {}): ClosureView {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    totals: { registered: 0, produced: 0, consumed: 0, codeConsumed: 0, unconsumed: 0, ghost: 0, consumedGap: 0, producedGap: 0, dynamicClaimed: 0, channelOnly: 0 },
    clusters, unconsumed: [], ghost: [], notes: [],
    truncation: { unconsumed: { shown: 0, total: 0, truncated: false } },
    ...over,
  };
}

/* ── 断言 ─────────────────────────────────────────────────────────────── */

describe('cycle-75 闭环流动可视化（注册 → 生产 → 消费）', () => {
  it('② 恒等式：逐族 notProduced + producedNotConsumed === registered − consumed', () => {
    const f = buildClosureFlow(view([
      // 有产出锚点：63 注册 / 63 产出 / 19 消费
      cluster({ cluster: 'routes', total: 63, consumed: 19, producedByKind: { 'register-call': 63, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } }),
      // 无写入点（词表）：302 注册 / 0 产出 / 260 消费
      cluster({ cluster: 'i18n', total: 302, consumed: 260, producedByKind: { 'register-call': 0, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 302 } }),
    ]));
    expect(f.clusters).toHaveLength(2);
    for (const c of f.clusters) {
      expect(c.notProduced + c.producedNotConsumed).toBe(c.registered - c.consumed);
    }
  });

  it('③ 两种形态：有产出锚点→viaProduction；无写入点→directRead 且不伪造产出节点', () => {
    const f = buildClosureFlow(view([
      cluster({ cluster: 'routes', total: 10, consumed: 4, producedByKind: { 'register-call': 10, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } }),
      cluster({ cluster: 'i18n', total: 8, consumed: 3, producedByKind: { 'register-call': 0, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 8 } }),
    ]));
    const routes = f.clusters.find((c) => c.cluster === 'routes') as ClosureFlow['clusters'][number];
    const i18n = f.clusters.find((c) => c.cluster === 'i18n') as ClosureFlow['clusters'][number];
    expect(routes.mode).toBe('viaProduction');
    expect(routes.produced).toBe(10);
    expect(i18n.mode).toBe('directRead');
    expect(i18n.produced).toBe(0);
    // directRead **不得**有 produced 节点（不伪造一段不存在的生产）
    expect(f.nodes.some((n) => n.cluster === 'i18n' && n.stage === 'produced')).toBe(false);
    expect(f.nodes.some((n) => n.cluster === 'routes' && n.stage === 'produced')).toBe(true);
  });

  it('① 数据驱动：改簇名后节点随之改变（不硬编码族清单）', () => {
    const a = buildClosureFlow(view([cluster({ cluster: 'alpha', total: 5, consumed: 2, producedByKind: { 'register-call': 5, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } })]));
    const b = buildClosureFlow(view([cluster({ cluster: 'beta', total: 5, consumed: 2, producedByKind: { 'register-call': 5, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } })]));
    expect(a.nodes.every((n) => n.cluster === 'alpha')).toBe(true);
    expect(b.nodes.every((n) => n.cluster === 'beta')).toBe(true);
    // 同一族集合换名 → 节点 id 集不同（证明不是查表硬编码出来的）
    expect(a.nodes.map((n) => n.id).join(',')).not.toBe(b.nodes.map((n) => n.id).join(','));
  });

  it('④ 空输入：empty=true 且渲染出可见空态（不是空白、不崩）', () => {
    const f = buildClosureFlow(view([]));
    expect(f.empty).toBe(true);
    expect(f.clusters).toEqual([]);
    const v = probe(renderClosureFlow(f));
    expect(v.anchors).toContain('data-anic-flow-empty=true');
    expect(v.text.length).toBeGreaterThan(0);
  });

  it('⑤ 渲染：每族一行、缺口段带锚点、消费证据分层可见', () => {
    const f = buildClosureFlow(view(
      [
        cluster({ cluster: 'routes', total: 63, consumed: 19, producedByKind: { 'register-call': 63, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } }),
        cluster({ cluster: 'i18n', total: 302, consumed: 260, producedByKind: { 'register-call': 0, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 302 } }),
      ],
      { totals: { registered: 365, produced: 63, consumed: 279, codeConsumed: 276, unconsumed: 86, ghost: 0, consumedGap: 44, producedGap: 42, dynamicClaimed: 3, channelOnly: 2 } },
    ));
    const v = probe(renderClosureFlow(f));
    // 每族一行
    expect(v.anchors.filter((a) => a.startsWith('data-anic-flow-cluster='))).toHaveLength(2);
    // 缺口段可见（routes 有 63−19=44 生产了没人读；i18n 有 302−260=42 未读取）
    expect(v.anchors.some((a) => a.startsWith('data-anic-flow-unread='))).toBe(true);
    expect(v.anchors.some((a) => a.startsWith('data-anic-flow-gap='))).toBe(true);
    // 已消费按证据强弱分层
    expect(v.anchors).toContain('data-anic-flow-tiers=true');
    for (const tier of ['code', 'dynamicClaimed', 'channelOnly']) {
      expect(v.anchors.some((a) => a === 'data-anic-flow-tier=' + tier), '缺分层 ' + tier).toBe(true);
    }
  });

  it('⑥ 反向自检：判据能判两态（有族命中 / 空输入不命中）', () => {
    const hit = probe(renderClosureFlow(buildClosureFlow(view([
      cluster({ cluster: 'routes', total: 3, consumed: 1, producedByKind: { 'register-call': 3, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 } }),
    ])))).anchors.some((a) => a.startsWith('data-anic-flow-cluster='));
    const miss = probe(renderClosureFlow(buildClosureFlow(view([])))).anchors.some((a) => a.startsWith('data-anic-flow-cluster='));
    expect(hit).toBe(true);
    expect(miss).toBe(false);
  });

  it('真机投影：四族可完整建流且恒等式成立（端到端不崩）', () => {
    const real = toClosureView(runClosureAudit(process.cwd()));
    const f = buildClosureFlow(real);
    expect(f.empty).toBe(false);
    expect(f.clusters.length).toBe(real.clusters.length);
    for (const c of f.clusters) expect(c.notProduced + c.producedNotConsumed).toBe(c.registered - c.consumed);
    // 真机上词表族应落 directRead（无写入点），路由/技能/工具落 viaProduction
    const i18n = f.clusters.find((c) => c.cluster === 'i18n');
    if (i18n) expect(i18n.mode).toBe('directRead');
    const v = probe(renderClosureFlow(f));
    expect(v.anchors.filter((a) => a.startsWith('data-anic-flow-cluster=')).length).toBe(real.clusters.length);
  });
});
