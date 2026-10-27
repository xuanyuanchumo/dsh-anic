/**
 * 闭环体检**汇总形状**（cycle-75 T3 拆分：registryClosure 超 250 行）。
 *
 * 独立成文件的原因同 closureTotalsTypes：`ClosureSummary` 被编排器（registryClosure）
 * 与投影（closureView）共同引用，下沉破循环 import。
 */
import type { ClusterAudit, ClosureItem } from './closureModel.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import type { ConnectivityReport } from './connectivity.ts';
import type { ArtifactsReport } from './artifactsSpecs.ts';
// 注意 import 来源：IsolationReport 是**编排层**的形状（含 workspace 绝对路径 +
// dangling），而 isolationScan 只有登记表与判据。从 isolation.ts 取，别取错。
import type { IsolationReport } from './isolation.ts';

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
  /**
   * ★cycle-82：**第五族**（`.cycles` 文档生命周期）—— 逐模板 × 逐循环矩阵。
   *
   * 前三族回答「代码资产有没有人读」；本面回答「**文档交付物**有没有真的写出来、
   * 谁在读、缺的是哪一份」。三态矩阵答不了它（文档不在注册表里）。
   */
  artifacts: ArtifactsReport;
  /**
   * ★cycle-82：**跨项目隔离**判定 —— 每条持久化路径都必须能从 workspace 根推导。
   *
   * 这一维是所有其他读数的**前提**：路径若越出工作区，上面那些数字描述的就是
   * 别的项目（或插件自身），再准确也没有意义。
   */
  isolation: IsolationReport;
}
