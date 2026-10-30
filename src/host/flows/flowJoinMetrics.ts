/**
 * flowJoin 的**量化指标面**（cycle-89 · 从 flowJoin.ts 拆出，守 T3 ≤250 行）。
 *
 * `coverageMetrics` 是面板「归属率 / 孤儿 / 门禁证据覆盖」量化条的数据源。
 * 拆出理由：它依赖 `joinFlows`（留在 flowJoin.ts）+ 自身的 countsOf /
 * cycleHasGateEvidence 两个私有函数——三者与 joinFlows 的分组逻辑是不同
 * 的抽象层（一个是「怎么聚」、一个是「聚完之后算什么指标」），混在一个文件
 * 里加任何指标都要先翻分组逻辑。
 */
import type { FlowRecord } from '../runtime/flowTracker.ts';
import type { CoverageMetrics, GateEvidence, FlowGroup } from './flowJoin.ts';
import { joinFlows, JOIN_GATE_IDS } from './flowJoin.ts';

/** 计数字典（扁平化，面板排序/百分比计算用）。 */
function countsOf(groups: FlowGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.key] = g.total;
  return out;
}

/**
 * 量化指标：归属率 / 孤儿 / 三维分布 / 门禁证据覆盖 / 无门禁循环。
 *
 * `attributionRate` 保留 4 位小数（0.6667 而非 0.66666666…）：面板显示两位百分数，
 * 契约测试也不必跟浮点尾数搏斗；0 条记录时为 0（不是 NaN）。
 */
export function coverageMetrics(records: readonly FlowRecord[]): CoverageMetrics {
  const index = joinFlows(records);
  const total = index.total;
  const attributed = total - index.orphanCount;
  const byCycle = countsOf(index.byCycle);
  const byPhase = countsOf(index.byPhase);
  const byGate = countsOf(index.byGate);
  const gateEvidence: GateEvidence[] = JOIN_GATE_IDS.map((gate) => ({
    gate,
    evidence: (byGate[gate] ?? 0) > 0,
    flows: byGate[gate] ?? 0,
  }));
  const unGatedCycles = Object.keys(byCycle).filter((cycle) => !cycleHasGateEvidence(index.byCycle, byGate, cycle)).sort();
  return {
    total,
    attributed,
    attributionRate: total === 0 ? 0 : Math.round((attributed / total) * 10000) / 10000,
    byCycle,
    byPhase,
    byGate,
    orphans: index.orphanCount,
    gateEvidence,
    unGatedCycles,
  };
}

/** 该循环下的记录里是否至少有一条带 gate（跨维度 join：cycle 组的成员看自己的 gate 字段）。 */
function cycleHasGateEvidence(groups: FlowGroup[], byGate: Record<string, number>, cycle: string): boolean {
  const group = groups.find((g) => g.key === cycle);
  if (!group) return false;
  return group.flows.some((f) => typeof f.gate === 'string' && f.gate !== '' && (byGate[f.gate] ?? 0) > 0);
}
