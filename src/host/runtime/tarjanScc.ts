/**
 * Tarjan 强连通分量（cycle-91 拆分 · 守 T3 ≤250 行）。
 *
 * ## 为什么拆出去
 *
 * `stateMachineFields.ts` 同时承担「YAML 声明字段解析」与「图算法」两件事。
 * 图算法（Tarjan）是**教科书算法**，与本仓的 YAML 形态无关；声明字段解析
 * 则与本仓的图形态强耦合。混在一起时：
 * - 改图算法的人会碰到 YAML 正则；
 * - 改 YAML 形态的人会碰到 Tarjan 的栈管理。
 *
 * ⇒ 拆成独立文件后，算法可独立单测（纯函数、零 IO）。
 *
 * ## 算法要点
 *
 * Tarjan 求**极强连通分量**（SCC）：每个「环」恰好对应一个分量。
 * 本仓用它找工作流图里的回环（宏观环 / 微观环）—— 拓扑排序做不到，
 * 因为拓扑排序只标「在环上」，不区分**环的入口**。
 *
 * 实现是**迭代版**（显式栈模拟递归）：工作流图虽小，但算法不应
 * 依赖调用栈深度 —— 递归版在深图上会爆栈（Node 默认栈上限约 10^4 帧）。
 *
 * ## 边界
 *
 * 纯函数、零 IO、零 clock、零 random：同输入必同输出（可复算）。
 */
/**
 * Tarjan 强连通分量（迭代版，避免深图爆栈）。
 *
 * @returns 每个 SCC 的成员 id 列表（按发现顺序）
 */
export function tarjanScc(nodeIds: readonly string[], edges: readonly { from: string; to: string }[]): string[][] {
  const ids = new Set(nodeIds);
  // 邻接表（只保留两端都在节点表内的边）。
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.from)?.push(e.to);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  for (const start of ids) {
    if (index.has(start)) continue;
    // 显式栈模拟递归：(节点, 邻接表游标)
    const work: Array<{ node: string; cursor: number }> = [{ node: start, cursor: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.cursor < neighbors.length) {
        const next = neighbors[frame.cursor];
        frame.cursor++;
        if (next === undefined) continue;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, cursor: 0 });
        } else if (onStack.has(next)) {
          const lowNext = low.get(next);
          const lowSelf = low.get(frame.node);
          if (lowNext !== undefined && lowSelf !== undefined && lowNext < lowSelf) low.set(frame.node, lowNext);
        }
        continue;
      }
      // 回溯：把子节点的 low 合并进来
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        const lowSelf = low.get(parent.node);
        const lowChild = low.get(frame.node);
        if (lowSelf !== undefined && lowChild !== undefined && lowChild < lowSelf) low.set(parent.node, lowChild);
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          comp.push(popped);
          if (popped === frame.node) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}
