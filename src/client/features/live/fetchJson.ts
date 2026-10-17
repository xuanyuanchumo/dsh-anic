/**
 * 面板数据拉取的小工具（cycle-9 从 WorkflowGraphPanel 抽出，T3 模块纪律）。
 *
 * 面板的并行拉取任务里，「GET JSON → 形状守卫 → 否则 null」是重复形态
 * （org / flows 两个分区都不需要行级文案，只需要「有数据 / 无数据」）。
 * 抽出后 WorkflowGraphPanel 只保留带状态行文案的任务（snapshot/step-trace/self-check）。
 */

/** GET url → JSON；非 2xx / 网络失败 / 形状不符 → null（不抛、不伪造）。 */
export async function fetchJsonGuarded<T>(
  url: string,
  isValid: (value: unknown) => value is T,
  headers: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return isValid(json) ? json : null;
  } catch {
    return null;
  }
}

/** 形状守卫：对象（org-status 等无强字段的分区用宽松守卫，与旧直接 cast 语义一致）。 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 形状守卫：流程状态机一站式观测面（flows 数组是唯一硬契约）。 */
export function isFlowStatus(value: unknown): value is { flows: unknown[] } {
  return isObjectLike(value) && Array.isArray(value['flows']);
}

/**
 * 遥测同步（cycle-10）：live 数据到达后把 spike 计数更新为实际渲染面。
 * spike.nodes/edges 初值是嵌入快照计数（集成注册时的渲染源）——不更新的话
 * 遥测永远停留在构建期数字，J0 的「渲染=遥测」不变量在 live≠嵌入时必然裂缝
 * （cycle-9 实录 175 圆 vs 169 陈旧遥测）。诚实遥测：报的就是画的。
 */
export function syncTelemetryCounts(nodes: number, edges: number): void {
  const spike = (window as unknown as { __ANIC_TAB_SPIKE__?: { nodes: number; edges: number } }).__ANIC_TAB_SPIKE__;
  if (spike) { spike.nodes = nodes; spike.edges = edges; }
}
