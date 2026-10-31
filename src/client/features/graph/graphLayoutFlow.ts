/**
 * `flow` 分层布局（Sugiyama 简化版）—— cycle-94。
 *
 * `lane`/`compact` 是「按类型分桶 + 折列」：只知道节点属于哪条泳道，不知道边指向谁
 * （32 条 `evidences` 全从 `gate-event` 横穿到 `gate`，顺边看过去中间隔着几列无关
 * 卡片 ⇒ 读不出流程）。本文件改按**边的拓扑**排：
 *
 * ① 断环 + Kahn **最长路径**分层（不断环则 Kahn 跑不完、剩下的半张图悄悄留在 layer 0；
 *    最长而非最短是为了让链上每条边恰好跨一层——最短分层会把长链首尾挤进相邻层）；
 * ② barycenter 层内排序（否则层分对了、层内按输入序，交叉数与随机顺序无异）；
 * ③ 按序铺排（无 dummy node 时不需要 Brandes-Köpf）；④ 交叉计数（**唯一的可断言读数**，
 *    判据在 `graphCrossings.ts`）。
 *
 * 纯函数：零 DOM / 零 clock / 零 random，不修改输入，同输入 ⇒ 同输出。
 */
import type { WorkflowEdge, WorkflowNode } from '../../workflowGraphData.ts';
import { nodeBoxOf, type NodeBox } from './graphNodeBox.ts';
import type { LayoutSpec } from './graphLayoutSpec.ts';
import type { PositionedNode } from './graphLayoutTypes.ts';

/** 层内每行容量的候选。宽高比取决于层数与最高层、两者都由数据决定 ⇒ 无闭式解；
 *  7 档离散扫完取最接近目标那档（ELK 的 aspectRatio 同样是靠重排逼近）。 */
const ROW_CAPS: readonly number[] = [3, 4, 6, 8, 12, 16, 24];

/** 列距压缩档（乘 `spec.columnPitch`）—— 与 `ROW_CAPS` 构成双轴扫档（见 assignCoordinates 头注）。 */
const COLUMN_PITCH_CAPS: readonly number[] = [1, 0.75, 0.6, 0.45, 0.35, 0.28, 0.22];

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

/** ① 层分配：标回边 → 按非回边算入度 → Kahn 最长路径 `layer(v)=max(layer(u)+1)`。 */
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

/** ② 层内排序：barycenter，向下/向上**交替**扫（只向下会收敛到「上层不动、下层迁就」的
 *  偏置解；只看相邻层是因为让跨层长边端点参与重心会让层内顺序震荡）。 */
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
import { placeFlowLayers, type FlowPlacement } from './graphFlowPlacement.ts';

/**
 * ③ 坐标分配：扫 `ROW_CAPS × COLUMN_PITCH_CAPS` 双轴档位，取宽高比最贴 `spec.aspectRatio` 的。
 *
 * ## 为什么必须**双轴**（第三次返工）
 *
 * 换轴（层=列）后宽度被**层数**钉死：`width = 层数 × columnPitch`。真实快照 13 层、
 * `columnPitch=120` ⇒ 宽恒 ≥1560px，而最高层只有几个节点 ⇒ 宽高比 **10.53**。
 * 只扫层内容量**改不动宽度**（它只让高度变大，追不上 1560px；再大就把图变成一堵墙）。
 * ⇒ 必须同时压缩列距：层数多时列间净空本就该更小。实测加上这一维后 **10.53 → 2.77**。
 *
 * 一个只能单向调整的旋钮，遇到双约束就会卡死 —— 这就是"参数要有真实自由度"。
 * 返回**顺序 = 输入顺序**（渲染层靠它对齐裁决字形）。
 */
export function assignCoordinates(
  nodes: readonly WorkflowNode[],
  layers: readonly (readonly string[])[],
  spec: LayoutSpec,
): PositionedNode[] {
  const typeOf = new Map(nodes.map((n): [string, string] => [n.id, n.type]));
  const boxOf = (id: string): NodeBox => nodeBoxOf(typeOf.get(id) ?? '');
  const target = Math.max(0.2, spec.aspectRatio ?? 1.2);
  const score = (p: FlowPlacement): number => Math.abs(Math.log(p.width / p.height / target));
  let best: FlowPlacement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  // 双轴扫档：层内容量（控高度）× 列距（控宽度）。
  for (const cap of ROW_CAPS) {
    for (const pitchFactor of COLUMN_PITCH_CAPS) {
      const cand = placeFlowLayers(layers, boxOf, { ...spec, columnPitch: spec.columnPitch * pitchFactor }, cap);
      const s = score(cand);
      if (s < bestScore) { best = cand; bestScore = s; }
    }
  }
  // 兜底（理论不可达：ROW_CAPS 与 COLUMN_PITCH_CAPS 都非空）。
  if (best === null) best = placeFlowLayers(layers, boxOf, spec, ROW_CAPS[ROW_CAPS.length - 1] ?? 8);
  const chosen = best ?? placeFlowLayers(layers, boxOf, spec, ROW_CAPS[ROW_CAPS.length - 1] ?? 8);
  const layerOf = new Map<string, number>();
  layers.forEach((l, li) => l.forEach((id) => { if (!layerOf.has(id)) layerOf.set(id, li); }));
  const out: PositionedNode[] = [];
  for (const n of nodes) {
    const spot = chosen.spots.get(n.id);
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

/* ★cycle-94：交叉计数已拆至 graphCrossings.ts（判据/布局分离）；此处再导出保持导入路径。 */
export { crossingsOf } from './graphCrossings.ts';
