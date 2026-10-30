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
 * 数据窗口的**截断信息**（cycle-90）。
 *
 * ## 为什么要检测它
 *
 * `flow-tracker.json` 的容量上限是 200 条，**滚动淘汰最旧的**。
 * 一旦发生淘汰，保留窗口就**偏向近期** ⇒「近期表现优于历史」可能是
 * **假象**而不是真实改善。
 *
 * 实测当前 `flows.length === counter === 105` ⇒ **尚未淘汰过一条**，
 * 但上限仍在，且每 95 次调用就会触发第一次淘汰 —— 所以**必须**实现检测，
 * 不能等它发生。
 *
 * ## 处置纪律
 *
 * `evicted > 0` 时，**所有跨窗口读数**（分位数、控制图、生存曲线）必须挂
 * 「窗口已截断」徽标 —— **不允许静默展示**。
 */
export interface TruncationInfo {
  /** 历史上一共写入过多少条（含已被淘汰的）。 */
  everWritten: number;
  /** 当前保留了多少条。 */
  retained: number;
  /** 被淘汰了多少条。 */
  evicted: number;
  /** 是否发生过淘汰。 */
  truncated: boolean;
  /** 保留窗口的时间跨度（毫秒）；不足 2 条时为 null（跨不了窗口）。 */
  windowSpanMs: number | null;
}

/**
 * 计算截断信息。
 *
 * @param state flow-tracker 状态（`counter` 是单调累计值，`flows.length` 是保留数）
 * @param nowIso 可选的「现在」（ISO 串）；省略则不计算窗口尾部时间
 */
export function truncationInfo(state: FlowTrackerState, nowIso?: string): TruncationInfo {
  const everWritten = Math.max(state.counter, state.flows.length);
  const retained = state.flows.length;
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
  return { everWritten, retained, evicted, truncated: evicted > 0, windowSpanMs };
}

/**
 * 跨窗口读数的**截断告警**（供面板显示）。
 *
 * @returns 未截断 → null；已截断 → 一句可直接显示的话
 */
export function truncationWarning(info: TruncationInfo): string | null {
  if (!info.truncated) return null;
  return `⚠ 数据窗口已截断（丢弃 ${String(info.evicted)} 条最旧记录）—— 近期指标偏向近期，勿据此断言历史更差`;
}
