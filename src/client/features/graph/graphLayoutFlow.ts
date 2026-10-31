/**
 * `flow` 分层布局（Sugiyama 简化版）—— cycle-94 · WS-A。
 *
 * `lane`/`compact` 是「按类型分桶 + 折列」的类别分组布局：只知道节点属于哪条泳道，
 * 不知道边指向谁。32 条 `evidences` 边全从 `gate-event` 横穿到 `gate`，顺边看过去
 * 中间隔着 3 列无关卡片 ⇒ 读不出流程。本文件改按边的拓扑排：① 断环 + Kahn **最长
 * 路径**分层（不断环时 Kahn 跑不完、剩下半张图悄悄留在 layer 0，是最难查的「图少了
 * 一块」；用最长而非最短路径是为了让链上每条边恰好跨一层 —— 最短分层会把长链首尾
 * 挤进相邻层，边全退化成跨层长边）；② barycenter 层内排序（否则层分对了但层内按
 * 输入序，交叉数与随机顺序无异）；③ 按序堆叠（无 dummy node 时不需要 Brandes-
 * Köpf）；④ 交叉计数 —— 本模式唯一的可断言读数。
 *
 * 交叉数不看几何，只看 (列, 行) 栅格投影的相对次序：`a→b` 与 `c→d` 交叉 ⇔ a 排在
 * c 前而 b 排在 d 后。同一把尺既能量 `lane`（列 = 泳道列）也能量 `flow`（列 = 层号），
 * 「flow ≤ lane 的 60%」才是同口径比较；共端点两条边乘积为 0 ⇒ 不计交叉。
 * 纯函数：零 DOM / 零 clock / 零 random，不修改输入，同输入 ⇒ 同输出。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { nodeBoxOf, type NodeBox } from './graphNodeBox.ts';
import type { LayoutSpec } from './graphLayoutSpec.ts';
import type { PositionedNode } from './graphLayoutTypes.ts';

/** (列,行) 拼严格全序的权重：须远大于层内序号，否则「行 1200 的第 0 层」会排到
 *  「行 0 的第 1 层」后面，交叉判定就反了。 */
const LAYER_WEIGHT = 1_000_000;

/** 层内每行容量的候选。宽高比取决于层数与最高层、两者都由数据决定 ⇒ 无闭式解；
 *  7 档离散扫完取最接近目标那档（ELK 的 aspectRatio 同样是靠重排逼近）。 */
const ROW_CAPS: readonly number[] = [3, 4, 6, 8, 12, 16, 24];

/** 分层产物（②③ 的输入，也是单测的断言面）。 */
export interface FlowLayering {
  /** 层号 → 层内节点 id（输入顺序，未做 barycenter 排序）。 */
  layers: string[][];
  layerOf: Map<string, number>;
  /** 回边键 `from>to`：断环证据，不参与分层也不计入度。 */
  backEdges: ReadonlySet<string>;
}

/** 铺排产物：节点 id → 坐标 + 层内序号，以及整体宽高。 */
type Placement = {
  spots: Map<string, { x: number; y: number; seq: number }>;
  width: number;
  height: number;
};

/** DFS 三色标回边（迭代：递归要另算调用栈深）。只把「指向灰节点」的边判回边：灰 = 仍在当前 DFS 栈上 ⇒ 闭合回路；指向黑节点是横叉边，合法。 */
function findBackEdges(ids: readonly string[], out: ReadonlyMap<string, string[]>): Set<string> {
  const color = new Map<string, number>(ids.map((id): [string, number] => [id, 0]));
  const back = new Set<string>();
  for (const root of ids) {
    if ((color.get(root) ?? 0) !== 0) continue;
    color.set(root, 1);
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const next = out.get(top.id) ?? [];
      if (top.i >= next.length) { color.set(top.id, 2); stack.pop(); continue; }
      const to = next[top.i];
      top.i += 1;
      if (to === undefined) continue;
      const c = color.get(to) ?? 0;
      if (c === 1) back.add(`${top.id}>${to}`);
      else if (c === 0) { color.set(to, 1); stack.push({ id: to, i: 0 }); }
    }
  }
  return back;
}

/** ① 层分配：标回边 → 只按非回边算入度 → Kahn 最长路径 `layer(v)=max(layer(u)+1)`。 */
export function layerAssign(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): FlowLayering {
  // 重复 id 首个胜出（与折列布局同一纪律；Set 的插入序即首现序）。
  const ids = [...new Set(nodes.map((n) => n.id))];
  const known = new Set(ids);
  // 丢自环与悬空边：悬空边的目标永远进不了队列，会让"入度降不到 0"静默丢层。
  const all = edges.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to));
  const out = new Map<string, string[]>(ids.map((id): [string, string[]] => [id, []]));
  for (const e of all) out.get(e.from)?.push(e.to);
  const backEdges = findBackEdges(ids, out);
  // 入度只按非回边计：计入回边的话环上节点入度永远降不到 0，Kahn 队列会空。
  const indeg = new Map<string, number>(ids.map((id): [string, number] => [id, 0]));
  const next = new Map<string, string[]>();
  for (const e of all) {
    if (backEdges.has(`${e.from}>${e.to}`)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const layerOf = new Map<string, number>(ids.map((id): [string, number] => [id, 0]));
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    if (u === undefined) continue;
    const lu = layerOf.get(u) ?? 0;
    for (const v of next.get(u) ?? []) {
      if (lu + 1 > (layerOf.get(v) ?? 0)) layerOf.set(v, lu + 1);
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  let maxLayer = 0;
  for (const id of ids) maxLayer = Math.max(maxLayer, layerOf.get(id) ?? 0);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) layers[layerOf.get(id) ?? 0]?.push(id);
  return { layers, layerOf, backEdges };
}

/** ② 层内排序：barycenter，向下/向上交替扫（默认 4 轮）。交替是因为只向下扫会收敛到「上层不动、下层迁就」的偏置解；只看相邻层是因为让跨层长边端点参与重心会让层内顺序震荡。 */
export function orderWithinLayers(
  layers: readonly (readonly string[])[],
  edges: readonly WorkflowEdge[],
  rounds = 4,
): string[][] {
  const cur: string[][] = layers.map((l) => [...l]);
  /** id → (所在层, 层内序号)：两个语义量一起查，避免维护两张同步的索引表。 */
  const pos = new Map<string, { li: number; i: number }>();
  const reindex = (): void => {
    for (let li = 0; li < cur.length; li += 1) {
      (cur[li] ?? []).forEach((id, i): void => { pos.set(id, { li, i }); });
    }
  };
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const layer of cur) for (const id of layer) { preds.set(id, []); succs.set(id, []); }
  for (const e of edges) {
    if (e.from === e.to) continue;
    preds.get(e.to)?.push(e.from);
    succs.get(e.from)?.push(e.to);
  }
  reindex();
  for (let r = 0; r < Math.max(0, Math.min(rounds, 8)); r += 1) {
    const down = r % 2 === 0;
    const neigh = down ? preds : succs;
    const scan: number[] = [];
    for (let i = 1; i < cur.length; i += 1) scan.push(down ? i : cur.length - i);
    for (const li of scan) {
      const want = down ? li - 1 : li + 1;
      // 无相邻邻居时重心取自身序号：拿 0 会把它甩到层首（无谓的位移）。
      const scored = (cur[li] ?? []).map((id, i) => {
        let sum = 0;
        let n = 0;
        for (const nb of neigh.get(id) ?? []) {
          const p = pos.get(nb);
          if (p === undefined || p.li !== want) continue;
          sum += p.i;
          n += 1;
        }
        return { id, i, s: n === 0 ? i : sum / n };
      });
      cur[li] = scored.sort((a, z) => (a.s - z.s) || (a.i - z.i)).map((x) => x.id);
      reindex();
    }
  }
  return cur;
}

/** 单档容量铺排。每层是一条水平层带，带内按 barycenter 序行优先填格子 ⇒ 层内邻居在屏幕上真的相邻，这是交叉数下降的物理来源。层带左缘统一对齐 x = 0：居中属渲染审美，若在布局里居中，`x` 就不再是 `columnPitch` 整数倍，「节点 x 是列距整数倍」的既有断言会失效。 */
function place(
  layers: readonly (readonly string[])[],
  boxOf: (id: string) => NodeBox,
  spec: LayoutSpec,
  cap: number,
): Placement {
  const spots = new Map<string, { x: number; y: number; seq: number }>();
  let y = 0;
  let width = 0;
  for (const layer of layers) {
    if (layer.length === 0) continue;
    const cols = Math.max(1, Math.ceil(layer.length / cap));
    // 层带 pitch 取该带最高卡片：矮卡片不该被大卡片撑出的行距浪费。
    let pitch = spec.rowPitch;
    for (const id of layer) pitch = Math.max(pitch, boxOf(id).h + spec.gap);
    layer.forEach((id, i) => spots.set(id, {
      x: (i % cols) * spec.columnPitch,
      y: y + Math.floor(i / cols) * pitch + pitch / 2,
      seq: i,
    }));
    y += Math.ceil(layer.length / cols) * pitch;
    width = Math.max(width, cols * spec.columnPitch);
  }
  return { spots, width, height: Math.max(1, y) };
}

/** ③ 坐标分配：扫候选容量，取宽高比最接近 `spec.aspectRatio` 的一档。不在 spec 里写死容量是因为层带多宽取决于层数分布，写死会在另一种快照上退化成长条。返回**顺序 = 输入顺序**（渲染层按它建 DOM，`graphA11y` 靠它对齐裁决字形）。 */
export function assignCoordinates(
  nodes: readonly WorkflowNode[],
  layers: readonly (readonly string[])[],
  spec: LayoutSpec,
): PositionedNode[] {
  const typeOf = new Map(nodes.map((n): [string, string] => [n.id, n.type]));
  const boxOf = (id: string): NodeBox => nodeBoxOf(typeOf.get(id) ?? '');
  const target = Math.max(0.2, spec.aspectRatio ?? 1.2);
  const score = (p: Placement): number => Math.abs(Math.log(p.width / p.height / target));
  let best = place(layers, boxOf, spec, ROW_CAPS[ROW_CAPS.length - 1] ?? 8);
  let bestScore = score(best);
  for (const cap of ROW_CAPS) {
    const cand = place(layers, boxOf, spec, cap);
    if (score(cand) < bestScore) { best = cand; bestScore = score(cand); }
  }
  const layerOf = new Map<string, number>();
  layers.forEach((l, li) => l.forEach((id) => { if (!layerOf.has(id)) layerOf.set(id, li); }));
  const out: PositionedNode[] = [];
  for (const n of nodes) {
    const spot = best.spots.get(n.id);
    if (spot === undefined) continue;
    const box = nodeBoxOf(n.type);
    // `column` 存层号、`row` 存层内序号：交叉数只认这两个语义量，与铺排细节无关。
    out.push({
      ...n, lane: n.type, column: layerOf.get(n.id) ?? 0, row: spot.seq,
      x: spot.x, y: spot.y, w: box.w, h: box.h,
    });
  }
  return out;
}

/** ④ 交叉计数：(列,行) 投影的逆序边对数。O(E²)，E 是几十条且只在切模式时算一次 ——
 *  不值得为它引入排序树。缺任一端坐标的边跳过：布局不负责悬空边。 */
export function crossingsOf(
  edges: readonly WorkflowEdge[],
  columnOf: ReadonlyMap<string, number>,
  rowOf: ReadonlyMap<string, number>,
): number {
  const a: number[] = [];
  const b: number[] = [];
  for (const e of edges) {
    if (e.from === e.to) continue;
    const ca = columnOf.get(e.from);
    const ra = rowOf.get(e.from);
    const cb = columnOf.get(e.to);
    const rb = rowOf.get(e.to);
    if (ca === undefined || ra === undefined || cb === undefined || rb === undefined) continue;
    a.push(ca * LAYER_WEIGHT + ra);
    b.push(cb * LAYER_WEIGHT + rb);
  }
  let n = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    for (let j = i + 1; j < a.length; j += 1) {
      if ((ai - (a[j] ?? 0)) * (bi - (b[j] ?? 0)) < 0) n += 1;
    }
  }
  return n;
}
