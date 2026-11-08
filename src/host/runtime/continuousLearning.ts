/**
 * 持续学习层（M10-e）。
 *
 * 分析 FlowTracker 历史数据，识别模式并生成改进建议。
 * 为大模型自举提供反馈闭环：eval 结果 → 模式识别 → 改进建议 → 下一轮自举。
 *
 * 设计约束：
 * - 纯函数分析（无副作用，无 IO）——输入 FlowTrackerState，输出 SkillHealthReport
 * - 零外部依赖（仅 node:path 用于 workspace 显示截断）
 * - 建议基于阈值，阈值在此文件内集中声明（单一事实源）
 */
import type { FlowTrackerState, FlowRecord } from './flowTracker.ts';
import { classifyFlowOutcome } from './healthVerdicts.ts';
import { suggestFromHealth } from './healthSuggestions.ts';

// 转出口：契约测试从本模块取 classifyFlowOutcome（拆文件不该让调用面改 import）。
export { classifyFlowOutcome } from './healthVerdicts.ts';
export type { FlowOutcomeClass } from './healthVerdicts.ts';

// ── 阈值常量（单一事实源） ──

/** 成功率低于此值标记为 degraded。 */
const DEGRADED_SUCCESS_RATE = 0.8;
/** 超时率高于此值标记为 slow。 */
const SLOW_TIMEOUT_RATE = 0.2;
/** 平均耗时高于此值标记为 expensive。 */
const EXPENSIVE_DURATION_MS = 30000;
/** 样本数低于此值不评估（统计无意义）。 */
const MIN_SAMPLE = 3;
/** workspace 显示截断长度。 */
const WS_DISPLAY_MAX = 60;
/** 近期窗口大小：健康分级只看最近 N 条（cycle-53 T-5301——修复应被健康面承认）。 */
const RECENT_WINDOW = 8;
/**
 * 近期窗口时间上限（cycle-57 T-5702）：窗口条目还须 startedAt 距 now ≤ 7 天。
 * 动机（本仓实证）：flow-tracker 只记网关工具调用，脚本直跑不进账——若某脚本
 * 修复后不再经工具调用，计数窗口（last 8）里的旧失败**永远出不了窗**，面板
 * 永久 degraded。「近期」必须同时是时间上的近；时间窗空 = 近 7 天无调用 =
 * 无法判定当前状态（insufficient），而非拿全史冒充近期。7 天取「近期=一周」
 * 的朴素语义（非按当日面板表现调参——今日 3-5 天前的失败仍在窗内，属诚实）。
 */
const RECENT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// ── 类型定义 ──
export type HealthLevel = 'healthy' | 'degraded' | 'slow' | 'expensive' | 'insufficient' | 'unused';

export interface ScriptHealth {
  /** 脚本名。 */
  script: string;
  /** 健康等级。 */
  level: HealthLevel;
  /** 总调用次数。 */
  total: number;
  /** 成功率（0-1）。 */
  successRate: number;
  /** 超时率（0-1）。 */
  timeoutRate: number;
  /** 平均耗时（ms）。 */
  avgDurationMs: number;
  /** 近期窗口成功率（0-1；最近 RECENT_WINDOW 条且距 now ≤ 7 天——cycle-53/57。undefined=近 7 天无调用，当前状态不可判定）。 */
  recentSuccessRate?: number;
  /**
   * 有效负裁决次数（cycle-85 · O-84-01）：裁决类脚本"正确地拒绝了"的次数。
   * 它**不是**失败——把它计入失败率会让"守卫生效"看起来像"工具坏了"。
   */
  validVerdicts: number;
  /** 调用方用法错误次数（cycle-88）：不计入成功/失败分母（不是对工具的测量）。 */
  usageErrors: number;
  /**
   * 有效成功率 = (DONE + 有效负裁决) / (total - usage)。
   * 健康分级用的就是它；`successRate` 保留原始口径（白盒：两个数都可见）。
   */
  effectiveSuccessRate: number;
  /** 近期窗口的有效成功率（无近期样本时 undefined，与 recentSuccessRate 同窗）。 */
  recentEffectiveRate?: number;
  /**
   * 近期窗口超时率（cycle-112 · 与 recentSuccessRate 同窗：最近 N 条且 7 天内）。
   *
   * 为什么新增：分级里的 `slow` 此前读**全史** `timeoutRate`，而 degraded 读近期窗口
   * ——两套时间口径。真机实证：auto-fix-loop 5/6 次调用在 `durationMs=240020` 被
   * 调用方预算掐断（根因是工具默认超时 240s < 脚本合法上限，cycle-112 已修），
   * 但即便修复后连续成功，全史 5/6=83% 仍让它**永久 slow**——正是 cycle-57 修过的
   * 「旧失败永不出窗」同根模式，只是超时维度漏了。现在分级读近期超时率，
   * `timeoutRate` 保留全史口径供白盒对照（两个数都在 payload 里，不藏历史）。
   */
  recentTimeoutRate?: number;
  /** 最近一次调用时间。 */
  lastInvoked?: string;
}

export type SuggestionSeverity = 'info' | 'warn' | 'critical';

export interface ImprovementSuggestion {
  /** 建议 ID。 */
  id: string;
  /** 严重程度。 */
  severity: SuggestionSeverity;
  /** 关联脚本。 */
  script: string;
  /** 建议描述。 */
  description: string;
  /** 建议动作。 */
  action: string;
}

export interface SkillHealthReport {
  /** 按脚本分组的健康报告。 */
  scripts: ScriptHealth[];
  /** 改进建议。 */
  suggestions: ImprovementSuggestion[];
  /** 全局成功率（原始口径：DONE / total）。 */
  overallSuccessRate: number;
  /** 全局有效成功率（cycle-85：含有效负裁决；健康分级用它）。 */
  overallEffectiveRate: number;
  /** 全局调用方用法错误次数（cycle-88，不计入分母）。 */
  totalUsageErrors: number;
  /** 全局有效负裁决次数（"正确地拒绝"了多少次）。 */
  totalValidVerdicts: number;
  /** 总调用次数。 */
  totalInvocations: number;
  /** 报告生成时间。 */
  generatedAt: string;
}

// ── 纯函数实现 ──

/** 计算单个脚本的健康指标（nowMs 供测试注入时钟；缺省由调用方取 Date.now()）。 */
function computeScriptHealth(script: string, flows: FlowRecord[], nowMs: number): ScriptHealth {
  const total = flows.length;
  const done = flows.filter((f) => f.status === 'DONE').length;
  const timeout = flows.filter((f) => f.status === 'TIMEOUT').length;
  // cycle-85 · O-84-01：有效负裁决单列——它既不是"成功完成"，也绝不是"故障"。
  const validVerdicts = flows.filter((f) => classifyFlowOutcome(f) === 'verdict').length;
  // cycle-88：用法错误单列——**调用方**的失误不参与对工具的测量（分母里剔除）。
  const usageErrors = flows.filter((f) => classifyFlowOutcome(f) === 'usage').length;
  const completed = flows.filter((f) => f.durationMs !== undefined);
  const avgDurationMs = completed.length > 0
    ? Math.round(completed.reduce((sum, f) => sum + (f.durationMs ?? 0), 0) / completed.length)
    : 0;
  // 分母剔除用法错误：它们不是对工具的测量（没开始干活就被参数挡下）。
  // measured === 0 ⇒ 没有任何一次真实执行，比率无意义 → 由调用方按 insufficient 处理。
  const measured = total - usageErrors;
  const successRate = measured > 0 ? done / measured : 0;
  const effectiveSuccessRate = measured > 0 ? (done + validVerdicts) / measured : 0;
  const timeoutRate = measured > 0 ? timeout / measured : 0;

  // cycle-53 T-5301 + cycle-57 T-5702：近期窗口——最近 RECENT_WINDOW 条**且**
  // startedAt 距 now ≤ 7 天（RECENT_MAX_AGE_MS）。计数窗与时间窗取交集：
  // - 计数窗防陈年调用在低频脚本里独占「近期」语义（cycle-53 根因）；
  // - 时间窗防「修复后不再经工具调用→旧失败永不出窗→面板永久 degraded」
  //   （cycle-57 根因，本仓 gate-check/quick-validate/init-cycle 三脚本实证：
  //   最后失败 10-18/10-20，修复后 1-2 天内成功后即再无网关调用，计数窗里
  //   3-5 天前的失败持续压顶 degraded/critical）。
  // 时间窗空 = 近 7 天无调用 = 当前状态不可判定 → recentSuccessRate:
  // undefined + level 'insufficient'（不拿全史冒充近期，不伪造恢复）。
  const inAge = flows.filter((f) => {
    const t = f.startedAt ? Date.parse(f.startedAt) : NaN;
    return Number.isFinite(t) && nowMs - t <= RECENT_MAX_AGE_MS && nowMs - t >= 0;
  });
  // cycle-57：按时间升序排序再取尾部——FlowRecord 追加序不保证时间序（跨天多轮
  // 交错写入时追加序≠时间序；slice(-N) 在乱序数组上会取到「最晚追加」而非
  // 「最近发生」——用例实证 3F(10-18)+8D(10-14..21) 追加序尾 8 条含 1 条 F）。
  const timed = inAge
    .map((f) => ({ f, t: f.startedAt ? Date.parse(f.startedAt) : 0 }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.f);
  const recentFlows = timed.slice(-RECENT_WINDOW);
  const recentDone = recentFlows.filter((f) => f.status === 'DONE').length;
  const recentVerdicts = recentFlows.filter((f) => classifyFlowOutcome(f) === 'verdict').length;
  const recentUsage = recentFlows.filter((f) => classifyFlowOutcome(f) === 'usage').length;
  const recentTimeouts = recentFlows.filter((f) => f.status === 'TIMEOUT').length;
  const recentMeasured = recentFlows.length - recentUsage;
  const recentSuccessRate = recentMeasured > 0 ? recentDone / recentMeasured : undefined;
  const recentEffectiveRate = recentMeasured > 0
    ? (recentDone + recentVerdicts) / recentMeasured
    : undefined;
  // cycle-112：近期超时率与成功率同窗（分级用；全史 timeoutRate 仅作白盒对照）。
  const recentTimeoutRate = recentMeasured > 0 ? recentTimeouts / recentMeasured : undefined;
  const lastInvoked = flows[flows.length - 1]?.startedAt;

  let level: HealthLevel;
  if (total < MIN_SAMPLE) level = 'insufficient';
  // cycle-112：slow 判定改用**近期窗口**超时率（与 degraded 同口径）。全史口径
  // 会让「预算不足被掐断」的旧记录永久压顶——修复后无法被承认（cycle-57 同根）。
  else if (recentTimeoutRate !== undefined && recentTimeoutRate > SLOW_TIMEOUT_RATE) level = 'slow';
  // cycle-53 T-5301：分级看近期窗口——修复后的连续成功应恢复 healthy。
  // cycle-57 T-5702：时间窗空 → insufficient（当前状态不可判定）。
  // cycle-85 · O-84-01：分级改用 **有效成功率**（DONE + 有效负裁决）。
  //   "门禁正确地拒绝了"不是设备故障；用原始 DONE 率分级会把守卫生效报成宕机。
  else if (recentEffectiveRate === undefined) level = 'insufficient';
  else if (recentEffectiveRate < DEGRADED_SUCCESS_RATE) level = 'degraded';
  else if (avgDurationMs > EXPENSIVE_DURATION_MS) level = 'expensive';
  else level = 'healthy';

  return {
    script, level, total, successRate, timeoutRate, avgDurationMs, lastInvoked,
    recentSuccessRate, validVerdicts, usageErrors, effectiveSuccessRate, recentEffectiveRate,
    recentTimeoutRate,
  };
}

/** 截断 workspace 路径用于显示。 */
function truncateWs(ws: string): string {
  return ws.length > WS_DISPLAY_MAX ? `...${ws.slice(-WS_DISPLAY_MAX)}` : ws;
}

/**
 * 分析 FlowTracker 状态，生成技能健康报告 + 改进建议。
 *
 * 纯函数：无副作用，无 IO。输入状态，输出报告。
 */
export function analyzeSkillHealth(state: FlowTrackerState, nowMs: number = Date.now()): SkillHealthReport {
  const flows = state.flows;
  const scriptNames = [...new Set(flows.map((f) => f.script))];

  const scripts = scriptNames
    .map((name) => computeScriptHealth(name, flows.filter((f) => f.script === name), nowMs))
    .sort((a, b) => b.total - a.total);

  const suggestions = scripts
    .map(suggestFromHealth)
    .filter((s): s is ImprovementSuggestion => s !== null);

  const totalInvocations = flows.length;
  const totalDone = flows.filter((f) => f.status === 'DONE').length;
  const overallSuccessRate = totalInvocations > 0 ? totalDone / totalInvocations : 0;
  // cycle-85 · O-84-01：全局口径同样给"有效"数——否则摘要头部读起来仍像全线故障。
  const totalVerdicts = flows.filter((f) => classifyFlowOutcome(f) === 'verdict').length;
  const totalUsage = flows.filter((f) => classifyFlowOutcome(f) === 'usage').length;
  const measuredTotal = totalInvocations - totalUsage;
  const overallEffectiveRate = measuredTotal > 0
    ? (totalDone + totalVerdicts) / measuredTotal
    : 0;

  return {
    scripts,
    suggestions,
    overallSuccessRate,
    overallEffectiveRate,
    totalValidVerdicts: totalVerdicts,
    totalUsageErrors: totalUsage,
    totalInvocations,
    generatedAt: new Date().toISOString(),
  };
}


// 摘要格式化拆到 healthSummary.ts（cycle-88：本文件 266 行超 250 纪律）。
// 转出口保持 anic_status / 测试的 import 面不变。
export { formatHealthSummary } from './healthSummary.ts';
