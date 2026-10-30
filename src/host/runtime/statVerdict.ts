/**
 * 统计读数的**判据类型**（cycle-90）—— 「算得出」与「不该算」必须能区分。
 *
 * ## 为什么需要这一层
 *
 * 本仓的诚实标注纪律（INV-27「宁可诚实缺席，不可伪造」）此前只落在
 * 「有没有数据」上（`0` 而不是 `NaN`）。但统计读数有**第三种**状态：
 *
 * ```
 * 有数据且可判定 → ok
 * 有数据但样本不足 → insufficient-data   ← 最容易被伪装成 ok 的那一种
 * 数据形态不适用 → not-applicable        ← 模型选择错误，不是数据问题
 * ```
 *
 * 把后两者混进 `ok`（给一个数）就是**统计上的撒谎**；
 * 混进 `0` 则是**数值上的撒谎**（0 是个合法的读数）。
 *
 * ## 为什么不用 `null`
 *
 * `null` 不能区分「算出来是 null」与「算不出来」。而面板要显示的是
 * 「样本不足（n=7 < 20），不可判定」—— 用户需要知道**为什么**没有数字，
 * 才能判断要不要补数据。
 *
 * ## 与既有纪律的同源
 *
 * `flowJoin.ts` 的「取不到就如实标 orphan，绝不按现值回填」是同一族纪律：
 * **缺失要显式，不能伪装成有**。本模块把那条纪律**类型化**，
 * 让每个统计模块的「不可判定」路径都有同一个出口。
 */
import type { FlowTrackerState } from './flowTracker.ts';

/** 判据结果（成功时携带读数，失败时携带**原因**）。 */
export type Verdict<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'insufficient-data' | 'not-applicable'; detail: string };

/** 成功便捷构造。 */
export function ok<T>(value: T): Verdict<T> {
  return { ok: true, value };
}

/** 样本不足便捷构造。 */
export function insufficient<T>(detail: string): Verdict<T> {
  return { ok: false, reason: 'insufficient-data', detail };
}

/** 不适用便捷构造。 */
export function notApplicable<T>(detail: string): Verdict<T> {
  return { ok: false, reason: 'not-applicable', detail };
}

/** 取读数（不可判定时返回 null —— 调用方据此决定显示形态）。 */
export function valueOf<T>(v: Verdict<T>): T | null {
  return v.ok ? v.value : null;
}

/**
 * 样本量门槛判据（所有统计模块共用）。
 *
 * @param n       实际样本量
 * @param minimum 门槛值
 * @param what    样本是什么（进 detail，让用户知道该补什么）
 */
export function requireSamples(n: number, minimum: number, what: string): Verdict<never> | null {
  if (n >= minimum) return null;
  return insufficient<never>(`样本不足（n=${String(n)} < ${String(minimum)}，${what}），不可判定`);
}

/**
 * 数据窗口的**截断信息**（cycle-90；**cycle-91 判据改「样本域」**）。
 *
 * ## 为什么要检测它
 *
 * `flow-tracker.json` 的容量上限是 200 条，**滚动淘汰最旧的**。
 * 一旦发生淘汰，保留窗口就**偏向近期** ⇒「近期表现优于历史」可能是
 * **假象**而不是真实改善。
 *
 * ⚠️ **cycle-91 起这个风险已被治本**（append-only 历史，见
 * `flowTrackerStore.ts`）：被淘汰的记录**仍在历史里**，统计样本不缺。
 * 本模块的判据因此改为**样本域**（见下）。
 *
 * ## 判据：窗口域 → 样本域（cycle-91 实测驱动的变更）
 *
 * **旧判据**：`everWritten = max(counter, flows.length)`、
 * `evicted = everWritten - flows.length`，其中 `flows` 是**热窗口**。
 * ⇒ `evicted` 表达的是「**展示窗口**丢了多少条」。
 *
 * **但统计偏差问的是另一个问题**：「**统计样本**有没有缺？」
 * append-only 历史落地后，两者**会分叉**：热窗口丢 50 条，历史保全 ⇒
 * 统计样本**一条不缺** ⇒ **指标口径没偏**。
 *
 * 若仍用旧判据，徽标会在「指标完全可信」时报警——**假警告**。
 * 假警告 ⇒ 告警疲劳 ⇒ 用户从此无视所有徽标——本仓纪律反对这个。
 *
 * **新判据**：
 * ```
 * everWritten = max(counter, sampleCount)      // 曾写过多少
 * retained    = sampleCount                    // 现在能拿到多少样本
 * evicted     = max(0, everWritten - retained) // 样本缺了多少
 * truncated   = evicted > 0
 * ```
 *
 * ## 处置纪律
 *
 * 样本缺失（`evicted > 0`）时，**所有跨窗口读数**（分位数、控制图、
 * 生存曲线）必须挂「样本有缺口」徽标 —— **不允许静默展示**。
 */
export interface TruncationInfo {
  /** 历史上一共写入过多少条（含已被淘汰的）。 */
  everWritten: number;
  /** 当前**统计样本**有多少条（cycle-91：全量样本，不只是热窗口）。 */
  retained: number;
  /** 统计样本**缺失**了多少条（0 = 完整）。 */
  evicted: number;
  /** 统计样本是否有缺失（`evicted > 0`）。 */
  truncated: boolean;
  /** 样本窗口的时间跨度（毫秒）；不足 2 条时为 null（跨不了窗口）。 */
  windowSpanMs: number | null;
  /**
   * **样本完整性是否已被确认**（cycle-91 新增）。
   *
   * `truncated` 是**事实**（样本确实少了 N 条）；`sampleComplete` 是**证明**
   * （读侧确认过「历史层可用 ⇒ 样本一条不缺」）。
   *
   * 两者何时分叉：热窗口滚掉了 50 条，但历史层可用 ⇒ 实际样本**一条不缺**
   * ⇒ `truncated=false` 且 `sampleComplete=true`。
   */
  sampleComplete: boolean;
  /** 统计样本缺失条数（0 = 完整）。 */
  sampleMissing: number;
}

/**
 * 计算截断信息（cycle-91：判据从「窗口域」改为「**样本域**」）。
 *
 * @param state       flow-tracker 状态（`counter` = 单调累计写入数）
 * @param sampleCount **实际可用样本数**（cycle-91：全量历史 ∪ 热窗口，
 *   且已按工作区过滤）。缺省时用 `state.flows.length`（旧行为，兼容既有调用方）。
 * @param nowIso      可选的「现在」（ISO 串）；省略则不计算窗口尾部时间
 * @param sampleComplete 样本完整性是否**已被确认**（读侧证明过历史层可用）
 */
export function truncationInfo(
  state: FlowTrackerState,
  sampleCount?: number,
  nowIso?: string,
  sampleComplete = false,
): TruncationInfo {
  const retained = sampleCount ?? state.flows.length;
  const everWritten = Math.max(state.counter, retained);
  const evicted = Math.max(0, everWritten - retained);
  let windowSpanMs: number | null = null;
  const first = state.flows[0];
  const last = state.flows[retained - 1];
  if (first !== undefined && last !== undefined) {
    const start = Date.parse(first.startedAt);
    // 有 nowIso 时窗口延伸到「现在」；否则延伸到**最后一条记录**。
    const end = nowIso !== undefined ? Date.parse(nowIso) : Date.parse(last.startedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      // ⚠️ **单条记录 ⇒ 跨度 0，但 0 不是「跨度」** —— 它表示「跨不了窗口」。
      // 显示成「0 毫秒的窗口」会让人以为「这段时间里没有任何活动」，
      // 而真相是「样本不足以谈窗口」。⇒ 单条时返回 null。
      windowSpanMs = retained < 2 ? null : end - start;
    }
  }
  return {
    everWritten,
    retained,
    evicted,
    truncated: evicted > 0,
    windowSpanMs,
    sampleComplete,
    sampleMissing: evicted,
  };
}

/**
 * 跨窗口读数的**截断告警**（供面板显示）。
 *
 * ## 两种徽标（cycle-91：按「样本是否完整」分流）
 *
 * | 状态 | 文案 | 含义 |
 * |---|---|---|
 * | 样本**不**完整 | 「⚠ 统计样本有缺口（缺 N 条）」 | 指标口径**真的**偏了 |
 * | 样本完整、仅展示窗口被裁 | 「展示窗口为最近 N 条（历史已保全，指标口径不受影响）」 | 口径没偏，只是视图有限 |
 *
 * **为什么不能合并成一条**：旧文案「数据窗口已截断 ⇒ 勿据此断言历史更差」
 * 在样本完整时是**假的**（历史保全 ⇒ 指标没偏）。挂一个假警告 ⇒
 * 告警疲劳 ⇒ 用户从此无视所有徽标。
 *
 * @returns 无需告警 → null；否则一句可直接显示的话
 */
export function truncationWarning(info: TruncationInfo): string | null {
  if (info.sampleComplete) {
    // 样本完整：只在展示窗口确实被裁时给一句**非警告**的说明。
    if (!info.truncated) return null;
    return `展示窗口为最近 ${String(info.retained)} 条（历史已保全，指标口径不受影响）`;
  }
  if (!info.truncated) return null;
  return `⚠ 数据窗口已截断（丢弃 ${String(info.evicted)} 条最旧记录）—— 近期指标偏向近期，勿据此断言历史更差`;
}
