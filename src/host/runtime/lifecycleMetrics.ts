/**
 * 生命周期指标的**路由投影**（cycle-90）—— 把三个数学模型的读数组装成响应体。
 *
 * ## 为什么单独成文件
 *
 * `statVerdict.ts` / `durationStats.ts` / `gateSurvival.ts` / `controlCharts.ts`
 * 是**判据层**（怎么算、什么时候不可判定）。本文件是**投影层**
 * （算出来的东西长什么样、给谁看）。
 *
 * 混在一起会有两个后果：① 路由要重述一遍「不可判定怎么表达」；
 * ② 面板要反向理解每个模型的内部结构才能渲染。
 *
 * ## 诚实边界（必须**一起**投影，不能只给好看的那些）
 *
 * 1. **截断徽标**：窗口一旦截断，所有跨窗口读数都要带警告 ——
 *    `truncationWarning` 的文案随响应一起返回，由面板显示。
 * 2. **归属覆盖**：当前 101/104 条 flow 是孤儿（归属机制上线前的历史），
 *    按门分组统计**只覆盖有归属的部分**。这个比例必须随读数一起给出，
 *    否则读者会把「只统计了 3%」当成「统计了全部」。
 * 3. **不可判定**：模型的 `Verdict` 失败时**原样投影**
 *    （`{ ok: false, reason, detail }`），**不**降级成 `null` 或 0。
 *
 * ## 边界
 *
 * 零 IO（本模块只接收已读好的数据）；纯函数。
 */
import type { Verdict } from '../runtime/statVerdict.ts';
import { truncationWarning, type TruncationInfo } from '../runtime/statVerdict.ts';
import type { FlowRecord } from '../runtime/flowTracker.ts';
import { durationQuantiles, giniReadout, type DurationQuantiles, type GiniReadout } from '../runtime/durationStats.ts';
import { kaplanMeier, type KaplanMeierReadout } from '../runtime/gateSurvival.ts';
import type { SurvivalSample } from '../runtime/gateSurvivalTypes.ts';
import { failEpisodes } from '../runtime/failEpisodes.ts';
import { ewmaFromLedger, type EwmaReadout } from '../flows/controlCharts.ts';

/** 一个模型读数在响应里的形态（成功给值，失败给**原因**）。 */
export type MetricProjection<T> =
  | { available: true; value: T }
  | { available: false; reason: string; detail: string };

/** 把 `Verdict` 投影成响应形态。 */
function project<T>(v: Verdict<T>): MetricProjection<T> {
  if (v.ok) return { available: true, value: v.value };
  return { available: false, reason: v.reason, detail: v.detail };
}

/** 门禁账本条目（读侧最小形状）。 */
export interface LedgerEntryLike {
  gate?: string;
  result?: string;
  timestamp?: string;
}

/** 生命周期指标响应体。 */
export interface LifecycleMetricsView {
  /** 数据窗口诚实信息。 */
  window: {
    /** 累计写入条数 / 当前保留条数 / 已淘汰条数。 */
    everWritten: number;
    retained: number;
    evicted: number;
    truncated: boolean;
    windowSpanMs: number | null;
    /** 截断告警（未截断 ⇒ null）。 */
    truncationWarning: string | null;
  };
  /** 归属覆盖（孤儿比例 —— 决定「按门分组统计」的可信度）。 */
  attribution: {
    /** 有归属的条数。 */
    attributed: number;
    /** 孤儿条数（归属机制上线前的历史）。 */
    orphans: number;
    /** 归属覆盖率（0..1）。 */
    coverage: number;
    /** 一句给读者的话。 */
    note: string;
  };
  /** 门禁通过率的 EWMA 控制图（run 级）。 */
  gatePassRate: MetricProjection<EwmaReadout>;
  /** 门禁修复时间的 KM 生存分析。 */
  gateRepairTime: MetricProjection<KaplanMeierReadout>;
  /** 流程耗时统计（全部 flow）。 */
  duration: MetricProjection<DurationQuantiles>;
  /** 耗时分布的不均衡度（双尺度）。 */
  inequality: MetricProjection<GiniReadout>;
}

/**
 * 组装生命周期指标视图。
 *
 * @param flows   flow-tracker 的记录
 * @param ledger  门禁账本条目
 * @param truncation 截断信息（由 `truncationInfo` 算出）
 */
export function buildLifecycleMetrics(
  flows: readonly FlowRecord[],
  ledger: readonly LedgerEntryLike[],
  truncation: TruncationInfo,
): LifecycleMetricsView {
  // 归属覆盖：孤儿照实计入（**绝不**用 workflow-state 现值回填历史）。
  const attributed = flows.filter((f) => f.attribution !== undefined && f.attribution.source !== 'none').length;
  const orphans = flows.length - attributed;
  const coverage = flows.length === 0 ? 0 : attributed / flows.length;

  // 耗时样本：只取有 durationMs 的（DONE/FAILED 都有；RUNNING 没有 ⇒ 天然右删失被排除）。
  const durations = flows
    .map((f) => f.durationMs)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0);

  // 门禁修复时间：从账本切 FAIL→PASS episode。
  const episodes: SurvivalSample[] = failEpisodes(ledger);

  return {
    window: {
      everWritten: truncation.everWritten,
      retained: truncation.retained,
      evicted: truncation.evicted,
      truncated: truncation.truncated,
      windowSpanMs: truncation.windowSpanMs,
      truncationWarning: truncationWarning(truncation),
    },
    attribution: {
      attributed,
      orphans,
      coverage: Math.round(coverage * 10000) / 10000,
      note: `归属覆盖 ${(coverage * 100).toFixed(1)}%（${String(orphans)} 条孤儿为归属机制上线前的历史，不参与按门分组统计，且不回填）`,
    },
    gatePassRate: project(ewmaFromLedger(ledger)),
    gateRepairTime: project(kaplanMeier(episodes)),
    duration: project(durationQuantiles(durations)),
    inequality: project(giniReadout(durations)),
  };
}
