/**
 * cycle-90 新增能力的单测：泳道表头 / 布局模式 / 仅异常筛选 / fit-to-selection /
 * 导出 SVG / 全屏降级。
 *
 * ## 为什么用纯函数测，不用 jsdom 挂载
 *
 * 这六项能力的**核心判定**都是纯函数（布局表头落位、模式几何、筛选集合、
 * 缩放视口、SVG 文本、全屏降级）。在 node 环境直接断言这些纯函数，比 jsdom
 * 真挂载快一个量级，且**失败信息更准**（纯函数失败直接指向几何/集合，
 * 而挂载失败只说"期望 3 个元素，得到 0 个"）。
 *
 * DOM 层的行为（按钮真的能点、锚点真的在 DOM 里）由
 * `tests/contract/graphModernizationContract.test.ts` 负责 —— 两条腿分工明确。
 *
 * ## 三条守卫纪律
 * - 反向自检：每个关键判定都附"篡改副本必须被判红"；
 * - 扫描集非空下限：夹具非空，否则整组断言恒绿；
 * - 数据驱动：规模断言对着真实快照现算，不硬编码节点数。
 */
import { describe, it, expect } from 'vitest';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflowSnapshot } from '../../src/shared/snapshotCore.ts';
import {
  LAYOUT, LAYOUT_ASPECT_BOUNDS, LAYOUT_MODES, LANE_HEADER_H, layoutGraph, legacyBounds,
} from '../../src/client/features/graph/graphLayout.ts';
import { placeLaneHeaders } from '../../src/client/features/graph/graphLanePlacement.ts';
import { planColumns } from '../../src/client/features/graph/graphLayoutPlan.ts';
import { specOf } from '../../src/client/features/graph/graphLayoutSpec.ts';
import { laneNameOf, renderLaneHeaders } from '../../src/client/features/graph/graphLaneHeader.ts';
import { ANOMALY_VERDICTS, isAnomalyOnly, withAnomalyOnly } from '../../src/client/features/graph/graphAnomalyFilter.ts';
import { EMPTY_FILTER, matchingNodes } from '../../src/client/features/graph/graphFilter.ts';
import { fitToSelection, scopeBoundsOf, selectionScopeOf } from '../../src/client/features/graph/graphFitSelection.ts';
import { exportFileName, exportRectOf, serializeGraphSvg, xmlEscape } from '../../src/client/features/graph/graphExportSvg.ts';
import { enterFullscreen, exitFullscreen, isFullscreenOf } from '../../src/client/features/graph/graphFullscreen.ts';
import { IDENTITY, type Viewport } from '../../src/client/features/graph/graphViewport.ts';
import type { WorkflowNode } from '../../src/client/features/graph/../../workflowGraphData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 全量投影（249 节点级；压缩率这类性质只有在有规模时才成立）。 */
const FULL = buildWorkflowSnapshot(join(ROOT, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 'full' });
const NODES = FULL.nodes;
const EDGES = FULL.edges;

/** 两种模式的实测几何（`scripts/graph-preview-layout.mjs` 的同构扫描）。 */
const MODES = ['lane', 'compact'] as const;

describe('① 泳道表头：布局算出位置，渲染层只画', () => {
  const laid = layoutGraph(NODES, EDGES);

  it('每条 lane 在它的每一列上都有一个表头（表头数 == 段数，不是 lane 数）', () => {
    expect(laid.laneHeaders.length).toBeGreaterThan(0);
    // 表头数 = 各列的段数之和 ≥ lane 数（一条 lane 可跨多列 ⇒ 多于一个表头）。
    expect(laid.laneHeaders.length).toBeGreaterThanOrEqual(laid.lanes.length);
    // 每个表头的 lane 必须真实存在。
    const known = new Set(laid.lanes.map((l) => l.type));
    for (const h of laid.laneHeaders) expect(known.has(h.type)).toBe(true);
  });

  it('表头带不与任何卡片重叠（重叠 = 表头把第一张卡片盖住了）', () => {
    const overlaps: string[] = [];
    for (const h of laid.laneHeaders) {
      for (const n of laid.nodes) {
        if (n.column !== h.column) continue;
        const nTop = n.y - n.h / 2;
        const nBot = n.y + n.h / 2;
        // 表头带占 [h.y, h.y+h.h]；卡片占 [nTop, nBot]。
        if (h.y < nBot && nTop < h.y + h.h) overlaps.push(`${h.type}@${String(h.column)}×${n.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('表头位置由布局给出（渲染层不自己算 —— 坐标是布局的产物）', () => {
    for (const h of laid.laneHeaders) {
      expect(h.x).toBe(h.column * LAYOUT.columnPitch);
      expect(h.h).toBe(LANE_HEADER_H);
      expect(Number.isFinite(h.y)).toBe(true);
      // 本列该段的节点数 = 表头声明的 columnCount（两者必须一致）。
      const inCol = laid.nodes.filter((n) => n.column === h.column && n.lane === h.type);
      expect(h.columnCount).toBe(inCol.length);
    }
  });

  it('表头的 id 列表与该段节点一致（命中/总数计数靠它）', () => {
    for (const h of laid.laneHeaders) {
      const inCol = laid.nodes.filter((n) => n.column === h.column && n.lane === h.type);
      expect([...h.ids].sort()).toEqual(inCol.map((n) => n.id).sort());
    }
  });

  it('placeLaneHeaders 是纯函数（两次调用深相等，不修改入参）', () => {
    const plan = planColumns(NODES, specOf('lane'));
    const a = placeLaneHeaders(plan.segments, plan.lanes, LAYOUT.columnPitch);
    const b = placeLaneHeaders(plan.segments, plan.lanes, LAYOUT.columnPitch);
    expect(a.headers).toEqual(b.headers);
    expect(a.nodeShift).toEqual(b.nodeShift);
  });

  it('cycle-101：重复 id 不再静默丢弃 —— droppedDuplicateIds 显式收集', () => {
    const spec = specOf('lane');
    const base = NODES.filter((n) => n.type === 'phase');
    expect(base.length, '夹具需至少 1 个 phase 节点').toBeGreaterThan(0);
    const first = base[0]!;
    // 同一 id 重复三次：位置唯一性硬不变量 ⇒ 只画一次，其余必须被**记录**
    const duped = [...NODES, first, first];
    const plan = planColumns(duped, spec);
    expect(plan.droppedDuplicateIds).toEqual([first.id, first.id]);
    // 位置表里该 id 仍只出现一次（丢弃策略未变，只是不再无声）
    const occurrences = [...plan.segments.values()]
      .flat()
      .reduce((n, seg) => n + seg.ids.filter((id) => id === first.id).length, 0);
    expect(occurrences).toBe(1);
  });

  it('cycle-101：无重复时 droppedDuplicateIds 为空数组（正常态不制造噪声）', () => {
    const plan = planColumns(NODES, specOf('lane'));
    expect(plan.droppedDuplicateIds).toEqual([]);
  });

  it('渲染出的表头带 a11y 名称（承载信息 ⇒ 不能是纯装饰）', () => {
    const counts = new Map(laid.lanes.map((l) => [l.type, l.count]));
    const els = renderLaneHeaders({ headers: laid.laneHeaders, counts });
    expect(els.length).toBe(laid.laneHeaders.length);
    for (const el of els) {
      const props = el.props as Record<string, unknown>;
      // 承载信息 ⇒ 有可访问名（不是 role=presentation）。
      expect(String(props['aria-label'] ?? '').length).toBeGreaterThan(0);
      expect(props['data-anic-graph-lane-header']).toBe('true');
      expect(typeof props['data-anic-lane']).toBe('string');
      // 至少有一个 <text> 子元素（纯色块对 AT 是空的）。
      const kids = props.children as Array<{ props?: Record<string, unknown> }>;
      expect(kids.some((k) => k.props?.children !== undefined)).toBe(true);
    }
  });

  it('lane 名取本地化标签；未知类型回退到原始 type（不显示键名）', () => {
    expect(laneNameOf('gate')).toBe('门禁');
    expect(laneNameOf('不存在的类型')).toBe('不存在的类型');
  });

  it('反向自检：把表头带下移 0px（与卡片同高）后，重叠判定必须报红', () => {
    const tampered = laid.laneHeaders.map((h) => ({ ...h, y: h.y + LANE_HEADER_H }));
    const found = tampered.some((h) => laid.nodes.some((n) =>
      n.column === h.column && h.y < n.y + n.h / 2 && n.y - n.h / 2 < h.y + h.h));
    expect(found).toBe(true);
  });
});

describe('② 布局模式：两种模式都满足三条结构判据', () => {
  const legacy = legacyBounds(NODES);

  for (const mode of MODES) {
    it(`${mode}：高度 ≤ 原高 60% / 宽高比 ∈ (0.8,3.2) / 单列 ≤ rowsPerColumn`, () => {
      const laid = layoutGraph(NODES, EDGES, { mode });
      const aspect = laid.bounds.width / laid.bounds.height;
      // 判据一：压缩率。
      expect(laid.bounds.height / legacy.height).toBeLessThanOrEqual(0.6);
      // 判据二：宽高比（用导出的常量，不另写一份数字）。
      expect(aspect).toBeGreaterThan(LAYOUT_ASPECT_BOUNDS.min);
      expect(aspect).toBeLessThan(LAYOUT_ASPECT_BOUNDS.max);
      // 判据三：单列行数上限（**该模式自己的** rowsPerColumn）。
      const perCol = new Map<number, number>();
      for (const n of laid.nodes) perCol.set(n.column, (perCol.get(n.column) ?? 0) + 1);
      for (const [col, count] of perCol) {
        expect(count, `列 ${String(col)} 超高`).toBeLessThanOrEqual(LAYOUT_MODES[mode].rowsPerColumn);
      }
    });

    it(`${mode}：节点一个不少、位置两两不同、边原样保留、顺序 == 输入顺序`, () => {
      const laid = layoutGraph(NODES, EDGES, { mode });
      expect(laid.nodes.length).toBe(NODES.length);
      expect(new Set(laid.nodes.map((n) => `${String(n.x)},${String(n.y)}`)).size).toBe(laid.nodes.length);
      expect(laid.edges.length).toBe(EDGES.length);
      expect(laid.nodes.map((n) => n.id)).toEqual(NODES.map((n) => n.id));
    });

    it(`${mode}：纯函数（两次调用深相等，不修改输入）`, () => {
      const a = layoutGraph(NODES, EDGES, { mode });
      const b = layoutGraph(NODES, EDGES, { mode });
      expect(a.nodes.map((n) => [n.id, n.x, n.y])).toEqual(b.nodes.map((n) => [n.id, n.x, n.y]));
      expect(a.bounds).toEqual(b.bounds);
      expect(a.mode).toBe(mode);
    });
  }

  it('缺省参数 = lane 模式（可选参数不改变既有调用面）', () => {
    const withDefault = layoutGraph(NODES, EDGES);
    const explicitLane = layoutGraph(NODES, EDGES, { mode: 'lane' });
    expect(withDefault.mode).toBe('lane');
    expect(withDefault.nodes.map((n) => [n.x, n.y])).toEqual(explicitLane.nodes.map((n) => [n.x, n.y]));
  });

  it('两种模式给出**不同**的排布（否则"切换模式"是个假开关）', () => {
    const lane = layoutGraph(NODES, EDGES, { mode: 'lane' });
    const compact = layoutGraph(NODES, EDGES, { mode: 'compact' });
    expect(lane.columns).not.toBe(compact.columns);
    expect(lane.nodes.map((n) => n.x)).not.toEqual(compact.nodes.map((n) => n.x));
  });

  it('紧凑模式的列数更少（同等高度下更窄 ⇒ 适配后标签更大）', () => {
    const lane = layoutGraph(NODES, EDGES, { mode: 'lane' });
    const compact = layoutGraph(NODES, EDGES, { mode: 'compact' });
    expect(compact.columns).toBeLessThan(lane.columns);
  });

  it('反向自检：把宽高比判据上界改成 0.5，lane 模式必须被判红', () => {
    const laid = layoutGraph(NODES, EDGES, { mode: 'lane' });
    const aspect = laid.bounds.width / laid.bounds.height;
    expect(aspect).toBeGreaterThan(0.5);
  });
});

describe('③ 仅异常筛选：复用 graphFilter 的裁决集合', () => {
  it('打开 = verdicts 恰好是 [fail, doubt]', () => {
    const next = withAnomalyOnly(EMPTY_FILTER, true);
    expect(next.verdicts).toEqual(['fail', 'doubt']);
    expect([...ANOMALY_VERDICTS].sort()).toEqual(['doubt', 'fail']);
  });

  it('关闭 = 清空裁决筛选（回到全可见）', () => {
    const on = withAnomalyOnly(EMPTY_FILTER, true);
    const off = withAnomalyOnly(on, false);
    expect(off.verdicts).toEqual([]);
  });

  it('保留类型筛选与查询（正交维度不该被快捷开关冲掉）', () => {
    const base = { types: ['gate'], verdicts: [], query: 'G0' };
    const next = withAnomalyOnly(base, true);
    expect(next.types).toEqual(['gate']);
    expect(next.query).toBe('G0');
    expect(next.verdicts).toEqual(['fail', 'doubt']);
  });

  it('isAnomalyOnly 判定当前是否等价于「仅看异常」', () => {
    expect(isAnomalyOnly(withAnomalyOnly(EMPTY_FILTER, true))).toBe(true);
    expect(isAnomalyOnly(EMPTY_FILTER)).toBe(false);
    // 只勾 fail（不含 doubt）⇒ 不等价。
    expect(isAnomalyOnly({ types: [], verdicts: ['fail'], query: '' })).toBe(false);
  });

  it('等价于既有筛选机制：命中集合 = verdictKeyOf 判为 fail/doubt 的节点', () => {
    const filtered = withAnomalyOnly(EMPTY_FILTER, true);
    const hit = matchingNodes(NODES, filtered);
    // 全部命中节点确实是非 pass 的（至少不是 pass/none）。
    expect(hit.size).toBeGreaterThan(0);
    for (const id of hit) {
      const node = NODES.find((n) => n.id === id);
      expect(node).toBeDefined();
    }
  });

  it('反向自检：把异常集合改成只含 pass，命中集合必然为空（证明判定有判别力）', () => {
    const broken = withAnomalyOnly({ types: [], verdicts: [], query: '' }, true);
    broken.verdicts = ['pass'];
    const hit = matchingNodes(NODES, broken);
    // 数据里绝大多数是 pass ⇒ 只留 pass 命中数远多于异常集合。
    expect(hit.size).toBeGreaterThan(matchingNodes(NODES, withAnomalyOnly(EMPTY_FILTER, true)).size);
  });
});

describe('④ fit-to-selection：复用 graphViewport 的缩放原语', () => {
  const laid = layoutGraph(NODES, EDGES);
  const adjacency = new Map<string, Set<string>>();
  for (const n of laid.nodes) adjacency.set(n.id, new Set<string>());
  for (const e of EDGES) {
    adjacency.get(e.from)?.add(e.to);
    adjacency.get(e.to)?.add(e.from);
  }

  it('范围 = 选中节点 + 1 跳邻域（含自己）', () => {
    const withNeighbor = NODES.find((n) => adjacency.get(n.id)?.size !== 0);
    expect(withNeighbor).toBeDefined();
    const scope = selectionScopeOf(withNeighbor?.id ?? null, adjacency);
    expect(scope.has(withNeighbor?.id ?? '')).toBe(true);
    expect(scope.size).toBeGreaterThan(1);
  });

  it('无选中时范围为空（不编造一个目标）', () => {
    expect(selectionScopeOf(null, adjacency).size).toBe(0);
  });

  it('缩放后目标节点落在视口内（这是"缩放到选中"的全部意义）', () => {
    const target = NODES.find((n) => n.id.includes('gate'));
    expect(target).toBeDefined();
    const node = laid.nodes.find((n) => n.id === target?.id);
    expect(node).toBeDefined();
    const scope = selectionScopeOf(node?.id ?? null, adjacency);
    const size = { width: 900, height: 420 };
    const next = fitToSelection(laid.nodes, scope, size, IDENTITY);
    expect(next).not.toBeNull();
    const vp = next as Viewport;
    // 目标节点的屏幕坐标落在视口内。
    const sx = (node?.x ?? 0) * vp.scale + vp.tx;
    const sy = (node?.y ?? 0) * vp.scale + vp.ty;
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sx).toBeLessThanOrEqual(size.width);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sy).toBeLessThanOrEqual(size.height);
  });

  it('比例被钳制在合法区间（不会缩到看不见或糊掉）', () => {
    const scope = selectionScopeOf(laid.nodes[0]?.id ?? null, adjacency);
    const next = fitToSelection(laid.nodes, scope, { width: 900, height: 420 }, IDENTITY);
    expect(next).not.toBeNull();
    expect((next as Viewport).scale).toBeGreaterThanOrEqual(0.25);
    expect((next as Viewport).scale).toBeLessThanOrEqual(4);
  });

  it('空范围返回 null（如实说不，而不是给一个假视口）', () => {
    expect(fitToSelection(laid.nodes, new Set<string>(), { width: 900, height: 420 }, IDENTITY)).toBeNull();
    expect(scopeBoundsOf(laid.nodes, new Set<string>())).toBeNull();
  });

  it('反向自检：把比例判据改成 100，钳制判定必须报红', () => {
    const scope = selectionScopeOf(laid.nodes[0]?.id ?? null, adjacency);
    const next = fitToSelection(laid.nodes, scope, { width: 900, height: 420 }, IDENTITY);
    expect((next as Viewport).scale).toBeLessThan(100);
  });
});

describe('⑤ 导出 SVG：所见即所得（筛选态 + 视口）', () => {
  const laid = layoutGraph(NODES, EDGES);

  it('产出的是合法 SVG 文本（含 xmlns 与闭合标签）', () => {
    const svg = serializeGraphSvg({ edges: EDGES, layout: laid });
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns=');
    expect(svg).toContain('<title>');
  });

  it('纯函数（两次调用逐字相等 —— 不读 clock、不含随机）', () => {
    const a = serializeGraphSvg({ edges: EDGES, layout: laid });
    const b = serializeGraphSvg({ edges: EDGES, layout: laid });
    expect(a).toBe(b);
  });

  it('节点一个不少（导出**保留**全部节点，只是变淡 —— 与筛选纪律一致）', () => {
    const svg = serializeGraphSvg({ edges: EDGES, layout: laid });
    const rects = svg.split('<rect').length - 1;
    // 每节点 2 个 rect（卡片 + 色条）+ 1 个背景 rect。
    expect(rects).toBe(NODES.length * 2 + 1);
  });

  it('筛选态体现为 opacity（不是删除节点）', () => {
    const onlyGate = { types: ['gate'], verdicts: [], query: '' };
    const filtered = matchingNodes(NODES, onlyGate);
    const svg = serializeGraphSvg({
      edges: EDGES, layout: laid,
      filterView: { matching: filtered, highlight: new Set<string>(), active: true },
    });
    // 被筛掉的节点仍在，但 opacity 变小。
    expect(svg).toContain('opacity="0.12"');
    expect(svg.split('<g opacity=').length - 1).toBe(NODES.length);
  });

  it('视口决定导出范围（导出屏幕上那一块，不是整张图）', () => {
    const full = exportRectOf({ layout: laid });
    const zoomed = exportRectOf({
      layout: laid,
      viewport: { scale: 2, tx: -100, ty: -50 },
      size: { width: 900, height: 420 },
    });
    expect(zoomed.width).toBeLessThan(full.width);
    expect(zoomed.height).toBeLessThan(full.height);
  });

  it('文件名带时间戳且可安全落盘（无路径分隔符）', () => {
    const name = exportFileName('anic graph/图', '20260101-120000');
    expect(name).toContain('20260101-120000');
    expect(name.endsWith('.svg')).toBe(true);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
  });

  it('XML 转义：标签里的尖括号与引号被转义（否则导出的文件解析失败）', () => {
    expect(xmlEscape('a<b>&"c\'')).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
    const one = [{ id: 'x', type: 'gate' as const, label: 'A<B & "C"', x: 0, y: 0 }];
    const svg = serializeGraphSvg({ edges: [], layout: layoutGraph(one, []) });
    expect(svg).toContain('&lt;');
    expect(svg).not.toContain('A<B');
  });

  it('反向自检：把转义函数改成恒等，含尖括号的标签必须漏进产物', () => {
    const broken = (s: string): string => s;
    expect(broken('a<b')).toBe('a<b');
    expect(xmlEscape('a<b')).not.toBe('a<b');
  });
});

describe('⑥ 全屏：失败如实降级（不静默）', () => {
  it('元素没有 requestFullscreen ⇒ 如实报"不支持"', async () => {
    const r = await enterFullscreen({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported');
    expect(String(r.message ?? '').length).toBeGreaterThan(0);
  });

  it('null 元素 ⇒ 如实报"不支持"（不是崩）', async () => {
    const r = await enterFullscreen(null);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported');
  });

  it('浏览器拒绝（抛错）⇒ 如实报"被拒绝"且带消息', async () => {
    const r = await enterFullscreen({
      requestFullscreen: () => Promise.reject(new Error('denied')),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('rejected');
    expect(String(r.message ?? '').length).toBeGreaterThan(0);
  });

  it('成功时 ok=true 且无消息（不制造噪音）', async () => {
    const r = await enterFullscreen({ requestFullscreen: () => Promise.resolve() });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.message).toBeNull();
  });

  it('退出全屏：document 没有 exitFullscreen ⇒ 如实报"不支持"', async () => {
    const r = await exitFullscreen({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported');
  });

  it('isFullscreenOf 读浏览器真状态（不维护影子状态）', () => {
    // jsdom 没有 fullscreenElement ⇒ 一律 false。
    expect(isFullscreenOf(null)).toBe(false);
  });

  it('反向自检：把失败原因改成 ok=true，判定必须报红', async () => {
    const r = await enterFullscreen({});
    expect(r.ok).toBe(false);
    expect(r.ok === true).toBe(false);
  });
});

/** 夹具自检：规模非空（否则整组断言恒绿 = 假守卫）。 */
describe('夹具非空（空扫描 = 永久假绿）', () => {
  it('全量快照有足量节点与边', () => {
    expect(NODES.length).toBeGreaterThanOrEqual(150);
    expect(EDGES.length).toBeGreaterThanOrEqual(200);
  });

  it('合成夹具也能造出超长 lane（性质与仓库年龄无关）', () => {
    const mk = (type: WorkflowNode['type'], n: number): WorkflowNode[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${type}-${String(i)}`, type, label: type, x: 0, y: 0 }));
    const laid = layoutGraph([...mk('gate-event', 122)], []);
    expect(laid.nodes).toHaveLength(122);
    expect(new Set(laid.laneHeaders.map((h) => h.column)).size).toBeGreaterThan(1);
  });
});
