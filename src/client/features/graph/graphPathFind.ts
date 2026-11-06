/**
 * 两点最短路径（cycle-95 · WS-B）——「这两点怎么连」。
 *
 * ## 为什么需要它（第三个真问题）
 *
 * 「哪个 evt group 导致 G2 失败？」此前只能靠三次双击 + 肉眼在 217 条边上
 * 拼因果链。用户心里其实有**确定的起点与终点**，缺的只是"它们之间那条线"
 * ——这正是最短路问题的原形。做成纯函数后，面板与工具条都能直接调用，
 * 也不必再写第二份图遍历。
 *
 * ## 为什么是**双向** BFS 而不是单向
 *
 * 单向 BFS 的搜索体积随度增长，真实快照里的 hub（如 `wf:gate-g0`，8 入边）
 * 会让第 2 层就铺开上百个节点。双向交替扩展把两侧体积各减一半、**相遇即停**，
 * 且逐层交替保证首遇点一定在最短路径上（双向 BFS 的标准结论）。
 *
 * ## 有向图，复现成的正反邻接表
 *
 * 第三问题问的是**有向可达**（"因 → 果"能不能走到），不是无向连通。所以正向
 * 扩展走 `forward`（出边）、反向扩展走 `reverse`（入边），两者都直接用
 * `buildTraceAdjacency` 的表——不另建一份邻接（两份表迟早漂移）。
 *
 * ## 边界（三条都写死，不许"差不多"）
 *
 *   from === to  → `path=[from]`、`length=0`、`found=true`（零跳是一条真路径）
 *   不可达        → `found=false`、`path=[]`、`reason='unreachable'`
 *   超过 maxHops  → `found=false`、`path=[]`、`reason` **点名上限数值**
 *
 * `length` = 边数（跳数），`path.length` = length + 1。两者都返回是为了让渲染
 * 层不必自己推长度（差一错误在这里最容易发生）。
 *
 * ## 纯函数（零 DOM / 零 clock / 零 random）
 *
 * 结果只依赖 (adjacency, from, to, maxHops)；同一输入两次调用深相等。
 */
import type { TraceAdjacency } from './graphTrace.ts';

/** 默认跳数上限。 */
export const MAX_PATH_HOPS = 6;

export interface PathResult {
  found: boolean;
  /** 节点序列（含首尾）；未找到时为空数组。 */
  path: string[];
  /** 跳数（= path.length - 1）；未找到时为 0。 */
  length: number;
  /** 未找到 / 被拒时的原因（`unreachable` / 点名上限 / 空 id）。 */
  reason?: string;
}

function notFound(reason: string): PathResult {
  return { found: false, path: [], length: 0, reason };
}

/**
 * 双向 BFS 求有向最短路径。
 *
 * @param adjacency 正/反邻接表（`graphTrace.buildTraceAdjacency` 产出）
 * @param from 起点节点 id
 * @param to 终点节点 id
 * @param maxHops 跳数上限（缺省 6；超上限一律拒绝，不接受"结果超出一点点"）
 */
export function findPath(
  adjacency: TraceAdjacency,
  from: string,
  to: string,
  maxHops = MAX_PATH_HOPS,
): PathResult {
  return findPathAvoiding(adjacency, from, to, maxHops, EMPTY_BLOCKED);
}

/** 空屏蔽集（模块级常量：`findPath` 每次调用不新造一个 Set）。 */
const EMPTY_BLOCKED: ReadonlySet<string> = new Set<string>();

/**
 * 双向 BFS，但**绕开**给定节点集（候选路径的第二/三条靠它算）。
 *
 * 为什么把实现放在这里、让 `findPath` 当薄包装：`findPath` 已有 20 条单测钉着
 * 四种边界（不可达 / 超上限 / 空 id / from===to）。若为候选路径再写一份 BFS，
 * 两份迟早漂移——而漂移的表现是"第一条路径对、第二条路径莫名少一跳"，这种
 * 差异在任何截图里都看不出来。单一实现 + 一个屏蔽参数，漂移面为零。
 *
 * @param blocked 屏蔽节点（**不得**包含 from / to：那是端点，屏蔽了就无解）
 */
export function findPathAvoiding(
  adjacency: TraceAdjacency,
  from: string,
  to: string,
  maxHops = MAX_PATH_HOPS,
  blocked: ReadonlySet<string> = EMPTY_BLOCKED,
): PathResult {
  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
    return notFound('empty id');
  }
  if (from === to) return { found: true, path: [from], length: 0 };
  const limit = Math.max(1, Math.min(MAX_PATH_HOPS, Math.floor(maxHops)));

  /**
   * 两侧父指针。**两个 Map 的键含义不同，别把它们当同一个方向用**：
   *   - `fwdPrev[succ] = pred`：正向搜索里"谁先走到我"（键→值 是逆向的）；
   *   - `bwdPrev[pred] = succ`：反向搜索沿入边扩展，"我是从哪个后继被找到的"
   *     （键→值 恰好**是正向**的）。
   * 缝合时必须按各自方向拼，否则路径会整体反序（本文件末尾有注释钉住这点）。
   * 空串 `''` 是根哨兵：`Map.get` 对"缺键"与"空串"都 falsy，所以判定统一用
   * `undefined || === ''`，而不是 `!p`。
   */
  const fwdPrev = new Map<string, string>([[from, '']]);
  const bwdPrev = new Map<string, string>([[to, '']]);
  let fwdFrontier: string[] = [from];
  let bwdFrontier: string[] = [to];

  for (let step = 0; step < limit * 2; step += 1) {
    if (step % 2 === 0) {
      const next: string[] = [];
      for (const id of fwdFrontier) {
        for (const nb of adjacency.forward.get(id) ?? []) {
          if (blocked.has(nb)) continue;
          if (fwdPrev.has(nb)) continue;
          fwdPrev.set(nb, id);
          // 相遇：反向已从这个点出发过 ⇒ 两侧路径可缝合（首遇即最短）。
          if (bwdPrev.has(nb)) return finish(nb, limit, fwdPrev, bwdPrev);
          next.push(nb);
        }
      }
      if (next.length === 0) return notFound('unreachable');
      fwdFrontier = next;
    } else {
      const next: string[] = [];
      for (const id of bwdFrontier) {
        for (const nb of adjacency.reverse.get(id) ?? []) {
          if (blocked.has(nb)) continue;
          if (bwdPrev.has(nb)) continue;
          bwdPrev.set(nb, id);
          if (fwdPrev.has(nb)) return finish(nb, limit, fwdPrev, bwdPrev);
          next.push(nb);
        }
      }
      if (next.length === 0) return notFound('unreachable');
      bwdFrontier = next;
    }
  }
  return notFound(`no path within ${String(limit)} hops`);
}

/** 首遇点处的路径装配 + 上限复核（首遇即最短 ⇒ 超上限即"确实没有更短的"）。 */
function finish(
  meet: string,
  limit: number,
  fwdPrev: ReadonlyMap<string, string>,
  bwdPrev: ReadonlyMap<string, string>,
): PathResult {
  const path = assemble(meet, fwdPrev, bwdPrev);
  if (path.length - 1 > limit) return notFound(`no path within ${String(limit)} hops`);
  return { found: true, path, length: path.length - 1 };
}

/**
 * 沿父指针链回到根（**原始顺序**：从 `end` 沿 prev 链往回）。
 *
 * 对 `fwdPrev` 而言这个顺序是 `meet → … → from`（需反转）；
 * 对 `bwdPrev` 而言这个顺序是 `meet → … → to`（**已经是正向**，不需反转）。
 */
function chainOf(prev: ReadonlyMap<string, string>, end: string): string[] {
  const out: string[] = [];
  let cur = end;
  for (;;) {
    out.push(cur);
    const p = prev.get(cur);
    if (p === undefined || p === '') break;
    cur = p;
    // 防御：父指针若成环（不该发生，但纯函数不许挂死）。
    if (out.length > prev.size + 1) break;
  }
  return out;
}

/** 缝合：head = from…meet（反转 fwd 链）+ tail = meet 的后继…to（去掉重复 meet）。 */
function assemble(
  meet: string,
  fwdPrev: ReadonlyMap<string, string>,
  bwdPrev: ReadonlyMap<string, string>,
): string[] {
  const head = chainOf(fwdPrev, meet).reverse();
  const tail = chainOf(bwdPrev, meet).slice(1);
  return head.concat(tail);
}

/**
 * 前 k 条**互不相同**的候选路径（cycle-109 · U4 ③）。
 *
 * ## 为什么是"屏蔽首条路径的中间节点再求一次"
 *
 * 真实图里等价路径常见（同一对端点有 2–3 条不同中继）。只给一条时，用户无法判断
 * 「为什么偏选这条」——而"最短"在有向图里常有多解。做法是**绕开**已得路径的
 * 中间节点重求（首尾不能屏蔽，它们是端点）：这样第 2 条一定与第 1 条占用不同的
 * 中继，也就一定不同。k 上限 3 是产品裁决（面板上再多也读不动）。
 *
 * ## 三条边界（都写死）
 *
 *   前一条都没有 → 空数组（不是"一条 found:false"：调用方要知道"没候选"）
 *   算不出新路径   → 提前停（不为了凑 k 条给重复路径）
 *   `k = 1`       → 与 `findPath` **逐字段相等**（同一条实现路径，见该文件头）
 */
export function findPathCandidates(
  adjacency: TraceAdjacency,
  from: string,
  to: string,
  k = 3,
  maxHops = MAX_PATH_HOPS,
): PathResult[] {
  const limit = Math.max(1, Math.min(3, Math.floor(k)));
  const blocked = new Set<string>();
  const out: PathResult[] = [];
  for (let i = 0; i < limit; i += 1) {
    const r = findPathAvoiding(adjacency, from, to, maxHops, blocked);
    if (!r.found) break;
    // 与已收结果同路径 ⇒ 再算下去只会重复（零跳 / 无中间节点时必然发生）。
    if (out.some((o) => o.path.join('>') === r.path.join('>'))) break;
    out.push(r);
    // 屏蔽本条路径的中间节点后重求；没有中间节点 ⇒ 不可能再变出新路径。
    for (const id of r.path.slice(1, -1)) blocked.add(id);
    if (blocked.size === 0) break;
  }
  return out;
}
