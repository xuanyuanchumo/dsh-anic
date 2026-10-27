/**
 * step-trace → verdicts 映射（cycle-82 从 renderGraph.ts 拆出）。
 *
 * ## 为什么单独成文件
 *
 * 拆分的界线是职责：`renderGraph.ts` 只管「数据 → SVG 元素树」；本文件只管
 * 「trace JSON → `nodeId → verdict` 查找表」。两者之间只有 `Map` 一个接口，
 * 拆开之后 renderGraph 降到 250 行以内（`truthAuditChecks` 的 MAX_FILE_LINES 是
 * 机械扫描项），且 `buildVerdicts` 可以被任何消费 verdict 的地方独立复用
 * （本仓 `runtime/hotReload.ts` 的纯门面同形：转出而不改调用面）。
 *
 * ## 为什么返回 `undefined` 而不是空 Map
 *
 * 调用方（`panelSections.ts` 的 GraphSection）用它区分「没有 trace」与「有 trace 但
 * 一条裁决都没有」，而渲染层的 `verdicts?.get(id) ?? n.result` 依赖 nullish 语义：
 * 传空 Map 会**静默覆盖**节点自带的 `result`（账本里明明有 FAIL，图上一个红点都不出现）。
 * 这不是防御性编程，那是一个已经踩过的坑。
 */
import type { StepTraceJson } from '../stepTrace/renderStepTrace.ts';

/** M3：从 step-trace 构建 verdicts map（nodeId → verdict）；无 trace 返回 undefined。 */
export function buildVerdicts(trace: StepTraceJson | null): Map<string, string> | undefined {
  if (trace === null || trace === undefined) return undefined;
  const map = new Map<string, string>();
  if (Array.isArray(trace.steps)) {
    for (const s of trace.steps) {
      if (s !== null && typeof s === 'object' && 'nodeId' in s) {
        const nodeId = s.nodeId;
        const verdict = s.ledgerVerdict?.result;
        if (typeof nodeId === 'string' && typeof verdict === 'string') {
          map.set(nodeId, verdict);
        }
      }
    }
  }
  // 空表与"没有 trace"在渲染上是同一件事（都回落到节点自带 result），
  // 所以统一归一成 undefined —— 两个值代表同一语义会让调用点的 `??` 判断分叉。
  return map.size > 0 ? map : undefined;
}
