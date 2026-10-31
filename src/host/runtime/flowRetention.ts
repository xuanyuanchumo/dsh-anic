/**
 * 热窗口保留策略 + **淘汰水位线**（cycle-94 · 采纳 dsh-context 的水位线设计）。
 *
 * ## 被修的缺陷（本仓自己文档里已识别、但一直未闭环）
 *
 * `flowTrackerStore.ts:20` 与 `flowTracker.ts:17` 都写着同一句话：
 *
 * > 静默截断：读侧不比对 counter 就看不出丢过。
 *
 * cycle-90 因此加了 `truncationInfo`（`statVerdict.ts:142`）并在**生命周期指标路由**
 * 接上了。但那只覆盖了「`/anic/api/flows/lifecycle` 这一个出口」——
 * **快照、org-status、skill-health、anic_status 这些出口仍然静默**：它们的读侧
 * 拿到的就是热窗口，读侧无从判断「我看到的是全部，还是被裁过的最近 200 条」。
 *
 * ## 两层修复（缺一层都还是假的）
 *
 * ### 第一层：淘汰必须**上报水位线**（不是只上报条数）
 *
 * dsh-context 的做法（`lib/index.d.ts:227-235`）不是「丢了几条」，而是四个
 * **floor**（被裁掉的**最大序号**）。差别是决定性的：
 *
 * | 只报条数 | 报 floor |
 * |---|---|
 * | 「丢了 42 条」 | 「丢到 #158 为止」 |
 * | 无法与账本/审计对上 | 可与 `flowId` 时间戳、账本 seq 直接对账 |
 * | 下次再丢 3 条 → 45（不可比） | 下次 floor 从 158 → 161（**单调，可比**） |
 *
 * ⇒ floor 是**单调不减**的量，读侧只要记住上一次的 floor 就能判断「这期间又丢了吗」，
 * 而条数不是单调的（每次写都会变）。这就是为什么必须记 floor 而不是 count。
 *
 * ### 第二层：淘汰**不能**裁掉进行中的流程（`running` 永不淘汰）
 *
 * dsh-context 的 `st`（offset 14482）里 commands 段有一条硬规则：
 * **`running` 状态永不淘汰**。理由是它承载的信息别处没有：
 *
 * > 正在跑的命令是唯一能解释「现在卡在哪」的证据。
 *
 * 对 dsh-anic 尤其致命：热窗口按**条数**淘汰（200 条），而一条 flow 可能是
 * 一个 40 分钟的 auto-fix 循环 —— 一次 bootstrap 连跑 15 个脚本就吃掉 15 条。
 * 容量触顶时若按「最旧的先丢」裁，**正在 INVOKING/RUNNING 的那条若恰好最旧
 * （超时任务正是最旧的）就会被丢掉** ⇒ 面板上「正在跑什么」直接消失，
 * 而它恰恰是最需要被看见的那一条。
 *
 * ## 为什么"按语义单位裁剪"本轮**没有**做
 *
 * 研究建议按 invocation（一次 `anic_skill` 调用）整组保留/整组淘汰。
 * 实测本仓 `FlowRecord` **没有** `invocationId` 字段（`flowTrackerTypes.ts:26-61`），
 * 而 `flowId` 的形态是 `${script}-${iso}-${counter}` —— 反推不出去哪次调用。
 * 补一个字段意味着改 `startFlow` 的签名与全部调用点（技能网关、编排器、两个路由），
 * **在没有真实收益证据前那是过度设计**。本轮先把水位线做对；按 invocation 裁剪
 * 登记为待办。
 *
 * ## 边界
 *
 * 纯函数、零 IO。本模块不读盘也不写盘 —— 淘汰决策与水位线计算都可独立单测。
 */
import type { EvictionWatermark, FlowRecord } from './flowTrackerTypes.ts';

export type { EvictionWatermark } from './flowTrackerTypes.ts';

/** 空水位线（从未淘汰过）。 */
export const EMPTY_WATERMARK: EvictionWatermark = {
  evictedThrough: null,
  evictedTotal: 0,
  evictedNow: 0,
  overCapacity: false,
};

/** 淘汰结果：保留的记录 + 本次水位线。 */
export interface TrimResult {
  kept: FlowRecord[];
  watermark: EvictionWatermark;
}

/** 进行中的状态集合（这些流程**永不淘汰**，见文件头第二层）。 */
export const LIVE_STATUSES: readonly FlowRecord['status'][] = ['INVOKING', 'RUNNING'];

/**
 * 「捞回」进行中流程的**上界**（见 `trimWithWatermark` 头注「为什么必须有上界」）。
 *
 * 32 的依据：宿主准入闸是 2 活跃，编排器串行步骤最多 15 个/轮，两者叠加的
 * 真实并发远小于 32。这个数不是"调大一点更安全"的旋钮——它的作用是**给
 * 崩溃残留的僵尸记录封顶**，调大只会把无界增长推迟。
 */
export const MAX_LIVE_RESCUE = 32;

/** 是否进行中（`status` 缺失按非进行中处理——旧记录都是终态）。 */
export function isLive(f: FlowRecord): boolean {
  return LIVE_STATUSES.includes(f.status);
}

/**
 * 合并两条水位线（**取更靠后**，不累加）。
 *
 * ## 为什么不累加（这是个真实的踩坑点）
 *
 * `evictedTotal` 由 `trimWithWatermark` 在**每次淘汰时**负责累加
 * （`prev.evictedTotal + 本次裁掉数`）。若本函数再累加一次
 * `next.evictedNow`，同一个数字会被数两遍 ⇒ 读数**虚高**，而虚高的水位线
 * 比没有更糟：它会让读侧误以为丢了更多数据。
 *
 * ⇒ 本函数的语义是「两个来源各报了一条水位线，取更保守的那条」：
 *   floor 取更靠后的时间戳，total 取**较大值**（不是和）。
 * 这样无论调用顺序如何，结果都是**单调且不虚高**的。
 *
 * 使用场景：重启后从磁盘读到的历史水位线，与本次内存里算出的新水位线对账。
 */
export function mergeWatermarks(prev: EvictionWatermark | undefined, next: EvictionWatermark): EvictionWatermark {
  const p = prev ?? EMPTY_WATERMARK;
  const a = p.evictedThrough;
  const b = next.evictedThrough;
  // ISO 8601 定长（UTC、同格式）⇒ 字符串序 = 时间序；任一为 null 时取另一边。
  const through = a === null ? b : b === null ? a : (a >= b ? a : b);
  return {
    evictedThrough: through,
    evictedTotal: Math.max(p.evictedTotal, next.evictedTotal),
    evictedNow: next.evictedNow,
    overCapacity: p.overCapacity || next.overCapacity,
  };
}

/**
 * 按容量裁剪热窗口，**进行中的流程豁免（但有上界）**。
 *
 * 算法（O(n)，单趟）：
 *   1. 若 `flows.length <= max` → 原样返回（零分配，且 prev 累计量原样带过）。
 *   2. 从**尾部**向前保留 `max` 条（尾部 = 最近，与旧 `slice(-max)` 同语义）。
 *   3. 被排除的区间里有进行中的流程 → **捞回来**。但捞回数量有上界
 *      `maxLiveRescue`（见下「为什么必须有上界」），超出部分按最旧优先放弃。
 *   4. `overCapacity` 如实上报「窗口超限了」。
 *
 * ## 为什么必须给"捞回"设上界（这条是实测发现，不是防御性设计）
 *
 * 「running 永不淘汰」这个规则来自 dsh-context，但**它没有面对崩溃残留**：
 * 一个进程被 kill / 宿主重启时，最后一条 `INVOKING` 记录**永远不会被
 * `finishFlow` 走到**，于是它永久停在 `INVOKING`。
 *
 * 若"进行中永不淘汰"是无条件的，这类僵尸记录**只增不减** ⇒ 热窗口无界增长
 * ⇒ 持久化文件无限膨胀、面板越读越慢。这比它要修的缺陷更严重。
 *
 * 实测触发路径：`tests/unit/flowTracker.test.ts` 里 205 条全 INVOKING 的记录
 * 本该裁到 200，却一条没裁（205）——那条既有断言恰好把这个 bug 抓住了。
 *
 * ⇒ 引入有界豁免：**最多捞回 `maxLiveRescue` 条**，且优先保留**最新的**
 * （最新的最可能是真在跑的；最旧的僵尸最可能是崩溃残留）。超出上界的
 * live 记录与普通记录一样被裁掉，并计入水位线（诚实：它确实被裁了）。
 *
 * ## 为什么上界是常量而不是参数
 *
 * 真实并发上限是 2 活跃（宿主准入）+ 少量编排器串行步骤。设 32 已远超任何
 * 真实并发，同时把僵尸累积压到 O(1)。做成参数会让"调大一点"成为逃避
 * 内存问题的手段；常量 + `overCapacity` 读数让问题**可见**。
 */
export function trimWithWatermark(
  flows: readonly FlowRecord[],
  max: number,
  prev?: EvictionWatermark,
): TrimResult {
  // 下限 1：`max=0` 会把窗口清空（连"正在跑什么"都看不到）。
  // 容量配错是配置问题，不该表现为"面板永远空白"——那比不裁剪更糟。
  const limit = Math.max(1, Math.floor(max));
  const n = flows.length;
  if (n <= limit) {
    // 未触顶：没有淘汰发生。prev 的累计量必须原样保留（跨次调用单调）。
    const carried = prev ?? EMPTY_WATERMARK;
    return {
      kept: flows.slice(),
      watermark: { ...carried, evictedNow: 0, overCapacity: false },
    };
  }

  const cutIndex = n - limit;
  const evicted = flows.slice(0, cutIndex);
  const keptTail = flows.slice(cutIndex);

  // 捞回被裁区间里仍在进行的流程 —— 但**有上界**（见函数头「为什么必须有上界」）。
  // 取**最新的** `maxLiveRescue` 条：最新的最可能是真在跑，最旧的僵尸最可能是崩溃残留。
  const liveInEvicted = evicted.filter(isLive);
  const rescued = liveInEvicted.length <= MAX_LIVE_RESCUE
    ? liveInEvicted
    : liveInEvicted.slice(liveInEvicted.length - MAX_LIVE_RESCUE);
  const rescuedIds = new Set(rescued.map((f) => f.flowId));
  const kept = rescued.length === 0 ? keptTail : [...rescued, ...keptTail];

  // 水位线 = 真正被裁掉的那些里最大的时间戳。
  // 被捞回的**不算**被裁（它们还在窗口里）；超出上界而放弃的 live 记录**算**
  // 被裁（诚实：它确实离开了窗口，读侧必须知道）。
  const trulyEvicted = evicted.filter((f) => !rescuedIds.has(f.flowId));
  let through: string | null = null;
  for (const f of trulyEvicted) {
    if (through === null || f.startedAt > through) through = f.startedAt;
  }

  const carried = prev ?? EMPTY_WATERMARK;
  const prevThrough = carried.evictedThrough;
  const merged = prevThrough === null ? through : through === null ? prevThrough : (prevThrough >= through ? prevThrough : through);
  return {
    kept,
    watermark: {
      evictedThrough: merged,
      evictedTotal: Math.max(carried.evictedTotal, 0) + trulyEvicted.length,
      evictedNow: trulyEvicted.length,
      overCapacity: kept.length > limit,
    },
  };
}
