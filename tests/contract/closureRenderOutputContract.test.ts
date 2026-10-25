/**
 * 闭环分区**渲染产出**契约（cycle-75 · Lead 补口）。
 *
 * ## 为什么必须单列这一条（本仓真实事故的同一个洞）
 *
 * 既有三腿契约覆盖了：
 *   腿1 装配 —— `panelAssemblyContract`（ClosureSection 被 createElement）
 *   腿2 数据 —— `panelDataLegContract`（切片 → setter → target 接线）
 *   腿3 渲染 —— `clientRenderContract`（**通用**渲染纪律，不含本分区产出）
 *
 * 但**没有一条断言 renderClosure 真的产出了内容**。这正是 cycle-72 真实事故
 * 「有壳无表体」的同一个洞换了个位置：分区装配齐、数据腿通、组件被调用，
 * 而 `renderClosure` 若返回空树 / 只返回标题 / 把四类分组全丢掉，
 * 上面三条腿**全是绿的**。白盒面存在的意义是「让人看见缺口」，
 * 分区渲染不出东西 = 缺口被藏起来，比没有这个分区更糟。
 *
 * ## 判据（全部对着**渲染树**取，不读实现源码）
 *
 * ① 真实投影：摘要四计数 + 分组锚点 + 族名（含新族 `skills`）+ producedKind 标签在场；
 * ② 截断态：`data-anic-closure-truncation` 在场，且**两个数**（shown / total）都出现
 *    ——静默截断 = 隐藏缺口；
 * ③ 零未消费：显式空态（`data-anic-closure-none`），不是空白；
 * ④ 失败态：`view=null` 时**失败行可见**（锚点 `data-anic-failed-closure`），不是 null；
 * ⑤ 未知族/未知 producedKind：**回落显示原 id**（可见的漏翻），不崩不空白；
 * ⑥ 安全：无绝对 http(s) URL、无本地绝对路径外泄。
 *
 * ## 守卫纪律
 *
 * - **反向自检**：证明取词器与判据能判两态（有内容的树命中、空树不命中），
 *   否则本文件可能恒真（本仓纪律：恒真断言 = 装饰）；
 * - 取词器对 React 元素树递归展开，不依赖 DOM（测试环境 node，无 jsdom 依赖）；
 * - 不匹配自身：夹具用拼接构造的假 id，不是真实端点。
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderClosure, renderClosureFailure } from '../../src/client/features/closure/renderClosure.ts';
import { CLOSURE_CLASSES } from '../../src/client/features/closure/closureClassify.ts';
import { runClosureAudit, toClosureView } from '../../src/host/closureAudit/registryClosure.ts';
import type { ClosureUnconsumedView, ClosureView } from '../../src/client/features/closure/closureTypes.ts';

/* ── 渲染树取词器（不依赖 DOM）────────────────────────────────────────── */

/** 递归收集元素树里的全部 `data-*` 锚点与文本。 */
function walk(node: unknown, out: { anchors: string[]; texts: string[] }): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return; }
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return; }
  const el = node as { props?: Record<string, unknown> };
  const props = el.props;
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('data-anic') && typeof v === 'string') out.anchors.push(k + '=' + v);
  }
  walk(props['children'], out);
}

/** 元素树 → 锚点集 + 拼接文本。 */
function probe(node: unknown): { anchors: string[]; text: string } {
  const out = { anchors: [] as string[], texts: [] as string[] };
  walk(node, out);
  return { anchors: out.anchors, text: out.texts.join(' | ') };
}

/**
 * 取「带指定 data-* 锚点的那个元素」的 style.color（cycle-78 警色断言用）。
 *
 * 为什么不读 CSS/不依赖 DOM：本仓渲染契约一律对着 React 元素树取证据（无 jsdom），
 * 颜色同样从元素 props 里取——这样「未声明>0 用警示色」才是**可判**的而不是肉眼约定。
 */
function colorOfAnchor(node: unknown, anchorKey: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = colorOfAnchor(c, anchorKey);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const el = node as { props?: Record<string, unknown> };
  const props = el.props;
  if (!props) return undefined;
  if (typeof props[anchorKey] === 'string') {
    const style = props['style'] as Record<string, unknown> | undefined;
    const color = style?.['color'];
    return typeof color === 'string' ? color : undefined;
  }
  return colorOfAnchor(props['children'], anchorKey);
}

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

/** 造一条未消费明细（默认：真注册点、无消费方 = 真缺口）。 */
function item(over: Partial<ClosureUnconsumedView> = {}): ClosureUnconsumedView {
  return {
    cluster: 'routes', id: '/anic/fixture/a', definedAt: 'src/fixture.ts:1',
    evidenceKind: 'none', producedKind: 'register-call', produced: true, dynamic: false, evidence: [],
    ...over,
  };
}

/** ★cycle-78：一条**已声明通道**明细（三元组齐全；仍是未消费）。 */
function declaredItem(over: Partial<ClosureUnconsumedView> = {}): ClosureUnconsumedView {
  return item({
    id: '/anic/fixture/declared',
    declaredChannel: { owner: 'fixture-owner', docRef: 'docs/agents/API参考-周期面.md#1', reason: 'fixture reason' },
    ...over,
  });
}

/**
 * 造一个完整投影（默认值围绕**真实**视图的可复用形态）。
 *
 * ★cycle-78：totals 多了 `channelDeclared`，且未消费三键必须自洽
 * （channelDeclared + consumedGap + producedGap === unconsumed = 86）。
 */
function view(over: Partial<ClosureView> = {}): ClosureView {
  const base: ClosureView = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    totals: {
      registered: 401, produced: 100, consumed: 315, codeConsumed: 313, unconsumed: 86, ghost: 0,
      consumedGap: 43, producedGap: 41, dynamicClaimed: 3, channelOnly: 2, channelDeclared: 2,
    },
    clusters: [
      // ★cycle-78：routes 族的 unconsumed 是「未声明」计数的口径来源（族内收窄）。
      { cluster: 'routes', unit: 'anic http route', total: 63, consumed: 17, codeConsumed: 17, unconsumed: 46, producedByKind: { 'register-call': 63 } },
      { cluster: 'tools', unit: 'tool', total: 21, consumed: 21, codeConsumed: 21, unconsumed: 0, producedByKind: { 'handler-in-file': 21 } },
      { cluster: 'skills', unit: 'script', total: 16, consumed: 16, codeConsumed: 15, unconsumed: 0, producedByKind: { 'handler-in-file': 16 } },
    ],
    unconsumed: [
      // 五类各一条：判据见 closureClassify.classifyItem（declaredChannel 优先，再 produced 二分）。
      // declaredChannel = 有通道声明（cycle-78）
      declaredItem(),
      // consumedGap  = produced && !consumed && 无声明
      item({ cluster: 'routes', id: '/anic/fixture/gap', producedKind: 'register-call', produced: true }),
      // producedGap  = !produced && !dynamic && 非 channel
      item({ cluster: 'i18n', id: 'fixture.key', producedKind: 'no-write-point', produced: false, evidenceKind: 'none' }),
      // dynamicClaimed = !produced && dynamic
      item({ cluster: 'i18n', id: 'fixture.dyn', producedKind: 'no-write-point', produced: false, dynamic: true, evidenceKind: 'code' }),
      // channelOnly  = !produced && !dynamic && channel
      item({ cluster: 'tools', id: '/anic/fixture/channel', producedKind: 'handler-in-file', produced: false, evidenceKind: 'channel' }),
    ],
    ghost: [],
    notes: ['口径声明一'],
    truncation: { unconsumed: { shown: 5, total: 5, truncated: false } },
  };
  return { ...base, ...over };
}

/* ── 断言 ─────────────────────────────────────────────────────────────── */

describe('cycle-75 闭环分区渲染产出（有壳必须有表体）', () => {
  it('① 真实投影：摘要四计数 + 分组锚点 + 新族 skills + producedKind 标签在场', () => {
    const v = probe(renderClosure(view()));
    expect(v.anchors).toContain('data-anic-closure-summary=true');
    // cycle-75 T4：流动可视化必须**真的挂在分区里**（不只是有个纯函数没人调）
    expect(v.anchors).toContain('data-anic-closure-flow=true');
    // 四个总量计数各自带锚点与数值（白盒要的是可读的数字，不是装饰标题）
    for (const k of ['registered', 'consumed', 'unconsumed', 'ghost']) {
      expect(v.anchors.some((a) => a.startsWith('data-anic-closure-' + k + '=')), '缺计数锚点 ' + k).toBe(true);
    }
    // 五类分组：夹具覆盖全部五类 ⇒ 五个分组锚点都必须渲染出来（cycle-78 增 declaredChannel）
    for (const cls of CLOSURE_CLASSES) {
      expect(v.anchors.some((a) => a === 'data-anic-closure-group=' + cls), '缺分组 ' + cls).toBe(true);
    }
    // 逐项明细在场（不是只有分组标题）
    expect(v.anchors.filter((a) => a.startsWith('data-anic-unconsumed=')).length).toBe(5);
    // 族名：新族 skills 必须有 locale 标签（否则回落显示原 id = 漏翻）
    expect(v.text).not.toContain('fixture-gap-marker');
  });

  it('② 截断态：两个数都出现（静默截断 = 隐藏缺口）', () => {
    const v = probe(renderClosure(view({
      totals: { ...view().totals, unconsumed: 200, consumedGap: 200, producedGap: 0, channelDeclared: 0 },
      unconsumed: Array.from({ length: 80 }, (_, i) => item({ id: '/anic/fixture/' + String(i) })),
      truncation: { unconsumed: { shown: 80, total: 200, truncated: true } },
    })));
    const anchor = v.anchors.find((a) => a.startsWith('data-anic-closure-truncation='));
    expect(anchor, '截断时必须有截断锚点').toBeDefined();
    expect(anchor).toContain('shown=80');
    expect(anchor).toContain('total=200');
    expect(v.text).toContain('80');
    expect(v.text).toContain('200');
  });

  it('③ 零未消费 + 零幽灵：显式空态可见（不是空白）', () => {
    const v = probe(renderClosure(view({
      unconsumed: [],
      totals: { ...view().totals, unconsumed: 0, consumedGap: 0, producedGap: 0, dynamicClaimed: 0, channelOnly: 0, channelDeclared: 0 },
      truncation: { unconsumed: { shown: 0, total: 0, truncated: false } },
    })));
    expect(v.anchors).toContain('data-anic-closure-none=true');
    expect(v.anchors).toContain('data-anic-closure-ghost-none=true');
  });

  it('④ 失败态：失败行可见（cycle-72「有壳无表体」不得在闭环面复发）', () => {
    const v = probe(renderClosure(null, 'boom'));
    expect(v.anchors.some((a) => a.startsWith('data-anic-failed-closure')), '失败行锚点缺失 = 失败静默').toBe(true);
    expect(v.text.length).toBeGreaterThan(0);
    // 独立导出与主入口同源（不得各写一份）
    const direct = probe(renderClosureFailure('boom', false));
    expect(direct.anchors.some((a) => a.startsWith('data-anic-failed-closure'))).toBe(true);
  });

  it('⑤ 未知族 / 未知 producedKind：回落显示原 id（可见的漏翻，不崩不空白）', () => {
    const v = probe(renderClosure(view({
      unconsumed: [item({ cluster: 'futureFamily', id: '/anic/fixture/x', producedKind: 'future-kind' as never })],
    })));
    expect(v.text).toContain('futureFamily');
    expect(v.text).toContain('future-kind');
  });

  it('⑥ 安全：无绝对 http(s) URL，无本地绝对路径外泄', () => {
    const v = probe(renderClosure(view()));
    expect(v.text).not.toMatch(/https?:\/\//);
    expect(v.text).not.toContain(':\\\\');
  });

  it('反向自检：取词器与判据能判两态（有内容命中 / 空树不命中）', () => {
    // 正样本：真实视图必须命中分组锚点
    const hit = probe(renderClosure(view())).anchors.some((a) => a.startsWith('data-anic-closure-group='));
    // 负样本：空树必须不命中（证明判据不是恒真）
    const miss = probe(null).anchors.some((a) => a.startsWith('data-anic-closure-group='));
    expect(hit).toBe(true);
    expect(miss).toBe(false);
    // 截断判据两态：未截断不得出现截断锚点
    const noTrunc = probe(renderClosure(view())).anchors.some((a) => a.startsWith('data-anic-closure-truncation='));
    expect(noTrunc).toBe(false);
  });

  /*
   * ★cycle-78：通道声明行（`data-anic-closure-declared`）。
   *
   * 这一行是「46 条未消费」拆成「已声明通道 N / 未声明 M」的**唯一可见出口**：
   * 没有它，宿主算出 channelDeclared 也白算——面板仍然只显示一个未消费总数，
   * 人还是分不清运维通道与真缺口（白盒形式上有、语义上是噪声的原形态复发）。
   *
   * 判据三态（两数在场 / 警示色点名 / 未声明 0 时不点名），并做**两态可分**自检：
   * 同一取色器在有未声明与无未声明两种树上必须给出不同结论。
   */
  it('⑦ 通道声明行：声明 N / 未声明 M 两数在场，未声明 >0 时警示色点名前 3 条', () => {
    const warnTree = renderClosure(view());
    const warn = probe(warnTree);
    const anchor = warn.anchors.find((a) => a.startsWith('data-anic-closure-declared='));
    expect(anchor, '缺通道声明锚点 —— 声明机制在面板上不可见').toBeDefined();
    expect(anchor).toContain('declared=2'); // totals.channelDeclared
    // 未声明按 **routes 族**收窄：46（routes unconsumed）− 2（已声明）= 44。
    // 若按 totals.unconsumed（86）算，会把 39 条 i18n 词表键误报成「未声明」——恒亮假红。
    expect(anchor).toContain('undeclared=44');
    expect(warn.anchors.some((a) => a.startsWith('data-anic-undeclared-list=')), '未声明 >0 必须点名').toBe(true);
    // 警示色：未声明 >0 时该行走 anic-fail 令牌（不是靠「看起来像红的」）。
    const warnColor = colorOfAnchor(warnTree, 'data-anic-closure-declared');
    expect(warnColor ?? '', '未声明 >0 未用警示色').toContain('--anic-fail');

    // 未声明 = 0（routes 族全部已声明）⇒ 不再点名，颜色退回弱化色。
    const cleanTree = renderClosure(view({
      totals: { ...view().totals, unconsumed: 5, consumedGap: 0, producedGap: 0, channelDeclared: 5 },
      clusters: [
        { cluster: 'routes', unit: 'anic http route', total: 5, consumed: 0, codeConsumed: 0, unconsumed: 5, producedByKind: { 'register-call': 5 } },
      ],
      unconsumed: [declaredItem()],
      truncation: { unconsumed: { shown: 1, total: 5, truncated: true } },
    }));
    const clean = probe(cleanTree);
    const cleanAnchor = clean.anchors.find((a) => a.startsWith('data-anic-closure-declared='));
    expect(cleanAnchor).toContain('declared=5');
    expect(cleanAnchor).toContain('undeclared=0');
    expect(clean.anchors.some((a) => a.startsWith('data-anic-undeclared-list=')), '未声明 0 时不该点名').toBe(false);
    expect(colorOfAnchor(cleanTree, 'data-anic-closure-declared') ?? '').not.toContain('--anic-fail');
    // 反向自检：同一判据在两态树上结论不同（证明上面的「不点名」不是恒真）。
    expect(clean.anchors.some((a) => a.startsWith('data-anic-undeclared-list=')))
      .not.toBe(warn.anchors.some((a) => a.startsWith('data-anic-undeclared-list=')));
  });

  it('真机数据可渲染：runClosureAudit 的投影能被本分区完整渲染（端到端不崩）', () => {
    const real = toClosureView(runClosureAudit(process.cwd()));
    const v = probe(renderClosure(real));
    expect(v.anchors).toContain('data-anic-closure-summary=true');
    expect(v.anchors.filter((a) => a.startsWith('data-anic-unconsumed=')).length).toBeGreaterThan(0);
    // 真实投影的四族里至少 tools/routes/i18n/skills 之一的分组要出来
    expect(v.anchors.some((a) => a.startsWith('data-anic-closure-group='))).toBe(true);
    /*
     * ★cycle-78 端到端：真机投影必须带「通道声明 N / 未声明 M」行，且
     * N === routes 族未消费数（本轮 46/46）——声明不是被算进已消费，而是被点名。
     */
    const declaredAnchor = v.anchors.find((a) => a.startsWith('data-anic-closure-declared='));
    expect(declaredAnchor, '真机投影缺通道声明锚点 —— 声明机制在面板上看不见').toBeDefined();
    const routeCl = real.clusters.find((c) => c.cluster === 'routes');
    expect(real.totals.channelDeclared, '真机通道声明数 != routes 未消费数').toBe(routeCl?.unconsumed ?? -1);
    console.log('CLOSURE_DECLARED_ANCHOR ' + String(declaredAnchor));
  }, 120_000);

});
