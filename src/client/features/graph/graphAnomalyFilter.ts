/**
 * 「仅看异常」筛选（cycle-90 · P0-2）——失败/存疑的快捷开关。
 *
 * ## 为什么复用 `graphFilter` 而不是另写一套
 *
 * `graphFilter.ts` 已经实现了：类型筛选、裁决筛选、文本查询的**交集**语义，
 * 以及"筛选不删节点、只改 opacity/pointer-events"的纪律，另写一套会出现两个
 * 真相：用户同时用"仅看异常"与"只看门禁"时，两个开关的交互顺序无法预测。
 *
 * 所以本文件只做一件事：**把"仅看异常"翻译成既有 `FilterState` 的裁决集合**。
 * 具体地，它等价于 `verdicts: ['fail', 'doubt']`。
 *
 * ## 为什么异常 = 失败 + 存疑（而不是只有失败）
 *
 * 门禁的裁决有五态：`pass` / `fail` / `doubt` / `pending` / `skip`。
 * 用户点"仅看异常"时的心智是「把**没问题**的滤掉」——那么"待定"（还没裁决）
 * 与"跳过"也是没问题吗？本仓的取舍：
 * - `fail`（失败）**必算**异常；
 * - `doubt`（存疑）**算**异常——它是"结论不可信"，人工复查的价值最高；
 * - `pending`（待定）**不算**——它是"还没跑"，不是"跑出问题"；
 * - `skip`（跳过）不算——它是"有意不做"。
 *
 * 这个取舍写在这里而不是散落在按钮的 `onClick` 里，是为了让"异常"的定义
 * **只有一个来源**（`ANOMALY_VERDICTS`），将来要改只改一处。
 */
import type { FilterState } from './graphFilter.ts';

/**
 * 异常裁决集合（规范键，来自 `graphFilter.verdictKeyOf` 的归一口径）。
 *
 * 与裁决下拉的 `multiple` 选中态共用同一套键（`pass`/`fail`/`doubt`/`pending`/`skip`/`none`）。
 */
export const ANOMALY_VERDICTS: readonly string[] = ['fail', 'doubt'];

/**
 * 打开「仅看异常」后的筛选状态。
 *
 * 语义选择：打开时**替换**裁决筛选（而不是并集）——用户点"仅看异常"的心智是
 * 「我现在只想看异常」，若与既有的裁决选择并集，"只看失败" + "仅看异常" 会变成
 * "失败 ∪ (失败∪存疑)" = 失败，用户会困惑于"存疑怎么不见了"。
 * 替换的代价是用户原来的裁决选择被冲掉 —— 但那正是"仅看异常"作为一个
 * **快捷方式**应有的行为（它等价于手动在裁决下拉里勾这两个）。
 *
 * 类型筛选与文本查询**保留**：它们是正交维度（"只看门禁类型里的异常"是
 * 完全合理的需求）。
 */
export function withAnomalyOnly(filter: FilterState, on: boolean): FilterState {
  return {
    ...filter,
    verdicts: on ? [...ANOMALY_VERDICTS] : [],
  };
}

/** 筛选状态当前是否等价于「仅看异常」（按钮的选中态判定）。 */
export function isAnomalyOnly(filter: FilterState): boolean {
  if (filter.verdicts.length !== ANOMALY_VERDICTS.length) return false;
  return ANOMALY_VERDICTS.every((v) => filter.verdicts.includes(v));
}
