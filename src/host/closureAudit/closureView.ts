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
 * ★cycle-82：`isolation` 投影同样去 workspace（同样是一条绝对路径）。
 */
import type { ClosureItem } from './closureModel.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import type { ClosureSummary } from './closureSummary.ts';
import type { ClosureBucket } from './closureBuckets.ts';
import { bucketOf, isProduced } from './closureBuckets.ts';
// cycle-82：第五族与隔离面的投影由 closureExtra 侧的窄视图提供（不在此重算判据）。
import { toArtifactsView, type ArtifactsView } from './artifactsView.ts';
import { toIsolationView, type IsolationView } from './isolation.ts';

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
    /**
     * ★cycle-78：通道声明（未消费但已声明为「通道独占」）。缺席 = 未声明，
     * 面板据以把已声明项与真缺口分开显示；**声明不是豁免**，项仍在未消费里。
     */
    declaredChannel?: { owner: string; docRef: string; reason: string };
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
  /**
   * ★cycle-82：第五族（`.cycles` 文档生命周期）投影。
   *
   * 缺席 = 旧服务端（向前兼容：客户端按可选处理，不渲染该分区而不是判失败）。
   * 为什么做成可选而不是必填：既有 isClosureView 是 fail-closed 逐字段守卫，
   * 把它改成必填会让所有旧宿主响应判假 —— 一条新数据可把一个面整体打瞎。
   */
  artifacts?: ArtifactsView;
  /**
   * ★cycle-82：跨项目隔离投影（去 workspace 绝对路径）。
   *
   * `violations` 只含污染类（越界 / cwd 兜底 / 写死绝对路径）；`dangling` 是登记表
   * 漂移。两者分开显示——处置动作不同，混排会让读者不知道先修哪个。
   */
  isolation?: IsolationView;
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
  // cycle-78：已声明的通道**最不急**（无待办：只需维持文档），故排最后 ——
  // 截断（上限 80）时优先丢弃它们，真缺口一条都不会被截掉。
  declaredChannel: 5,
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
      // cycle-78：声明透传（投影只搬运事实，不在投影层重算「算不算已声明」）。
      ...(it.declaredChannel === undefined ? {} : { declaredChannel: { ...it.declaredChannel } }),
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
    // ★cycle-82：第五族与隔离面。**只在服务端真算了才挂键**（旧 summary 形状/夹具
    // 没有这两面时，投影不凭空造一个空壳 —— 空壳会被渲染层当成"全绿"）。
    ...(summary.artifacts === undefined ? {} : { artifacts: toArtifactsView(summary.artifacts) }),
    ...(summary.isolation === undefined ? {} : { isolation: toIsolationView(summary.isolation) }),
  };
}
