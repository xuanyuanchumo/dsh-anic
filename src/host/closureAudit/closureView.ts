/**
 * 闭环体检**客户端投影**（cycle-75 T3 拆分：registryClosure 超 250 行）。
 *
 * 从 registryClosure.ts 下移——它承载「扫描编排 + 投影」双职责，加入截断与
 * 分类字段后越界。本文件只做**服务端汇总 → 客户端视图**的降维，
 * 不扫描、不读盘、不含分类判据（判据在 closureBuckets.ts）。
 *
 * 消费者 import 路径零变更：registryClosure.ts 再导出本文件的全部公开名。
 *
 * 投影安全纪律：**去 rootDir**（本地绝对路径不出服务端）——这是该面最重要的一条。
 */
import type { ClosureItem } from './closureModel.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import type { ClosureSummary } from './closureSummary.ts';
import type { ClosureBucket } from './closureBuckets.ts';
import { bucketOf, isProduced } from './closureBuckets.ts';

/** 客户端投影：去 rootDir（本地绝对路径不出服务端）。 */
export interface ClosureView {
  generatedAt: string;
  totals: ClosureTotals;
  clusters: Array<{
    cluster: string; unit: string; total: number; consumed: number; codeConsumed: number; unconsumed: number;
    /** ★cycle-75：本族 produced 类别分布（**全量分类**，合计 = 本族 total）。 */
    producedByKind: Record<string, number>;
  }>;
  unconsumed: Array<{
    cluster: string; id: string; definedAt: string;
    evidenceKind: string;
    /** ★cycle-75：produced 类别（回答「这资产到底产出了没有」）。 */
    producedKind: string;
    /** ★cycle-75：是否已生产（declaration-only / no-write-point 为 false）。 */
    produced: boolean;
    /** ★cycle-75：是否为计算键认领的消费证据（不由字面量 grep 得到）。 */
    dynamic: boolean;
    /** ★cycle-75：消费证据（≤3 条 file:line）；空 = 无。 */
    evidence: string[];
  }>;
  ghost: Array<{ cluster: string; id: string }>;
  notes: string[];
  /**
   * ★cycle-76：**连通性**投影（注册 → 生产 → 运行时可达）。
   *
   * 只暴露**判定结论与链跳状态**，不暴露注册器文件清单（体积 + 客户端用不上）；
   * `orphanRegistrars` 是名字（非路径），与 `definedAt` 同级的仓内相对标识。
   */
  connectivity: {
    connected: boolean;
    hopCount: number;
    hops: Array<{ id: string; ok: boolean; at: string | null }>;
    orphanRegistrars: string[];
    routeWired: number;
    routeTotal: number;
    toolWired: number;
    toolTotal: number;
  };
  /** ★cycle-75：明细截断如实上报（**总数永不截断**——只有明细数组受限）。 */
  truncation: { unconsumed: { shown: number; total: number; truncated: boolean } };
}

/**
 * 投影明细上限（cycle-75 实测依据）。
 *
 * 为什么必须有上限：`registered` 371 项、`unconsumed` 86 项时投影已 31 KB；
 * 随插件成长这会无界膨胀，而面板每次全量重取。上限**只作用于明细数组**，
 * 计数永远完整（`unconsumed` 数字与 `truncation.total` 恒等于真值）。
 *
 * 为什么按「真缺口优先」排序：截断必须截掉**最不需要立即行动**的那部分。
 * consumedGap（生产了没人读）排最前，channelOnly 排最后——否则截断会把
 * 真缺口藏起来，正是本模块存在的意义（可见）的反面。
 */
export const UNCONSUMED_VIEW_LIMIT = 80;

/** 投影排序权重（小在前）。真缺口优先，仅通道引用殿后。 */
const VIEW_ORDER: Record<ClosureBucket, number> = {
  consumedGap: 0, producedGap: 1, dynamicClaimed: 2, channelOnly: 3, code: 4,
};

/** 未消费明细的**确定性**排序（族 → id 为稳定次序；权重为主序）。 */
export function orderUnconsumed(items: readonly ClosureItem[]): ClosureItem[] {
  return [...items].sort((a, b) => {
    const w = VIEW_ORDER[bucketOf(a)] - VIEW_ORDER[bucketOf(b)];
    if (w !== 0) return w;
    if (a.cluster !== b.cluster) return a.cluster < b.cluster ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function toClosureView(summary: ClosureSummary): ClosureView {
  const ordered = orderUnconsumed(summary.unconsumed);
  const shown = ordered.slice(0, UNCONSUMED_VIEW_LIMIT);
  return {
    generatedAt: summary.generatedAt,
    totals: summary.totals,
    clusters: summary.clusters.map((c) => ({
      cluster: c.cluster,
      unit: c.unit,
      total: c.total,
      consumed: c.consumed,
      codeConsumed: c.codeConsumed,
      unconsumed: c.unconsumed,
      producedByKind: { ...c.producedByKind },
    })),
    unconsumed: shown.map((it) => ({
      cluster: it.cluster,
      id: it.id,
      definedAt: it.definedAt,
      evidenceKind: it.evidenceKind,
      producedKind: it.producedKind,
      produced: isProduced(it),
      dynamic: it.dynamic,
      evidence: [...it.evidence],
    })),
    ghost: summary.ghost.map((g) => ({ cluster: g.cluster, id: g.id })),
    notes: summary.notes,
    // cycle-76：连通性投影（结论 + 逐跳状态；不暴露注册器文件清单——客户端用不上且增体积）。
    connectivity: {
      connected: summary.connectivity.connected,
      hopCount: summary.connectivity.hopCount,
      hops: summary.connectivity.hops.map((h) => ({ id: h.id, ok: h.ok, at: h.at })),
      orphanRegistrars: [...summary.connectivity.orphanRegistrars],
      routeWired: summary.connectivity.routeRegistrars.filter((r) => r.wired).length,
      routeTotal: summary.connectivity.routeRegistrars.length,
      toolWired: summary.connectivity.toolRegistrars.filter((r) => r.wired).length,
      toolTotal: summary.connectivity.toolRegistrars.length,
    },
    truncation: {
      unconsumed: {
        // shown = 明细数组长度；total = **服务端未消费总数**（永不截断）
        shown: shown.length,
        total: summary.unconsumed.length,
        truncated: summary.unconsumed.length > shown.length,
      },
    },
  };
}
