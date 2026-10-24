/**
 * 闭环体检**汇总形状**（cycle-75 T3 拆分：registryClosure 超 250 行）。
 *
 * 独立成文件的原因同 closureTotalsTypes：`ClosureSummary` 被编排器（registryClosure）
 * 与投影（closureView）共同引用，下沉破循环 import。
 */
import type { ClusterAudit, ClosureItem } from './closureModel.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import type { ConnectivityReport } from './connectivity.ts';

/** 全量体检的服务端汇总（含 rootDir —— 故**不得**直接出服务端，须经 toClosureView）。 */
export interface ClosureSummary {
  /** ISO 生成时刻（每次调用取一次，不缓存——白盒面要的是这一次）。 */
  generatedAt: string;
  /** 扫描根（绝对路径）；仅服务端可读，客户端投影不含它。 */
  rootDir: string;
  scannedFiles: number;
  totals: ClosureTotals;
  clusters: ClusterAudit[];
  /** registered=true 且 consumed=false（缺口线索）。 */
  unconsumed: ClosureItem[];
  /** consumed=true 但 registered=false（幽灵消费）。 */
  ghost: Array<{ cluster: string; id: string; evidence: string[] }>;
  /** 口径声明：客户端据以显示这些绿是什么绿。 */
  notes: string[];
  /**
   * ★cycle-76：**连通性**（注册 → 生产 → **运行时可达**）。
   *
   * 三态矩阵回答「写了没有、有没有人读」，本维度回答**「那段代码会不会被执行」**——
   * 二者缺一都会漏掉本仓踩过的真实形态：注册器存在、`reg()` 也在，但聚合器没调它
   * ⇒ **空心注册**（静态全绿、运行时永不达）。
   */
  connectivity: ConnectivityReport;
}
