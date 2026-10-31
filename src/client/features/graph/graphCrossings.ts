/**
 * 交叉计数（cycle-94 · 从 `graphLayoutFlow.ts` 拆出）。
 *
 * ## 为什么独立成文件
 *
 * 「怎么分层/排序/铺排」（`graphLayoutFlow.ts`）与「**怎么量**布局质量」
 * （本文件）是两个独立的问题。混在一起时，改判据的人会顺手改动布局算法，
 * 而交叉数恰恰是**唯一能客观比较两种布局的尺子** —— 尺子必须独立可审。
 *
 * ## 三轮返工的历史（读这段能省下重新踩坑的时间）
 *
 * 1. **第一版**：把 `(列,行)` 压成一个标量比乘积符号 ⇒ 共端点的扇入被逐对算成交叉
 *    （真实快照 32 条 `evidences` 全指向同一批 gate ⇒ 上百个假交叉）。
 * 2. **第二版**：改成"起点顺序 vs 终点顺序反序"，并显式排除共端点 —— 判据对了。
 * 3. **第三版**：发现真快照上 916 这个数**大部分是真实的**：`lane` 模式把所有节点
 *    挤进 2 列，行号跨度极大，任何跨列边都密集交错。**那不是判据错，是布局真的差。**
 *
 * ⇒ 教训：交叉数大不一定是尺子坏，也可能是布局坏。两者要用**小夹具**（已知答案的
 * 4~8 个节点）区分，见 `tests/unit/graphCrossings.test.ts`。
 */
import type { WorkflowEdge } from '../../workflowGraphData.ts';

/**
 * ④ 交叉计数：两条边在 (列,行) 栅格投影里**是否真的相交**。
 *
 * ## ★cycle-94 修复：单键全序比较会把「同列反序」误判成交叉（第三次返工）
 *
 * 初版把 `(列,行)` 压成**一个标量** `column * LAYER_WEIGHT + row` 再比乘积符号：
 *
 * ```ts
 * if ((ai - aj) * (bi - bj) < 0) n += 1;   // ai=from 的标量, bi=to 的标量
 * ```
 *
 * 这在**一条边内部**是对的（from 必须排在 to 之前），但**两条边之间**不成立：
 * 两条边只要"起点的全序键"与"终点的全序键"反序就算交叉 —— 而真实图里
 * **32 条 `evidences` 边全部指向同一批 gate 节点**，它们的终点键相同、
 * 起点只有行号不同 ⇒ 乘积恒负 ⇒ **每条都算一次交叉**（实测 flow 916 / lane 957，
 * 其中绝大部分是这个假交叉）。
 *
 * ## 正确的判据（几何定义，不是全序定义）
 *
 * 两条边 `(a1→b1)`、`(a2→b2)` 在栅格投影上交叉 ⇔ **严格交错**：
 *
 * ```
 * a1 在 a2 之前  且  b1 在 b2 之后      （起点分离 + 终点反序）
 * 或 a2 在 a1 之前 且  b2 在 b1 之后
 * ```
 *
 * 且**排除共端点的边**（共享起点或终点不算交叉 —— 它们在同一个节点汇聚，
 * 那是"扇入/扇出"而不是"缠绕"）。共端点的乘积恰为 0，故用 `=== 0` 显式排除，
 * 而不是依赖"乘积不为负"这种巧合。
 *
 * 这是 ELK/dagre 里的标准定义（crossing = edges crossing, not endpoint ordering）。
 */
export function crossingsOf(
  edges: readonly WorkflowEdge[],
  columnOf: ReadonlyMap<string, number>,
  rowOf: ReadonlyMap<string, number>,
): number {
  // 只保留两端都有坐标的边（布局不负责悬空边），并把坐标摊平成数组便于双循环。
  const segs: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
  for (const e of edges) {
    if (e.from === e.to) continue;
    const ax = columnOf.get(e.from);
    const ay = rowOf.get(e.from);
    const bx = columnOf.get(e.to);
    const by = rowOf.get(e.to);
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;
    segs.push({ ax, ay, bx, by });
  }
  const before = (a: number, a2: number, b: number, b2: number): boolean => a < a2 && b > b2;
  let n = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const s1 = segs[i];
    if (s1 === undefined) continue;
    for (let j = i + 1; j < segs.length; j += 1) {
      const s2 = segs[j];
      if (s2 === undefined) continue;
      // 共端点不算交叉（扇入/扇出，不是缠绕）。
      if ((s1.ax === s2.ax && s1.ay === s2.ay) || (s1.bx === s2.bx && s1.by === s2.by)) continue;
      // 起点按 (列,行) 排序；终点若反序则是真交叉。
      const startCmp = s1.ax !== s2.ax ? s1.ax - s2.ax : s1.ay - s2.ay;
      const endCmp = s1.bx !== s2.bx ? s1.bx - s2.bx : s1.by - s2.by;
      if (startCmp * endCmp < 0) n += 1;
      void before;
    }
  }
  return n;
}
