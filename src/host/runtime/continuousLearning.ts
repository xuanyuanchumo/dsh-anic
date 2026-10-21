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
  /** 全局成功率。 */
  overallSuccessRate: number;
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
  const completed = flows.filter((f) => f.durationMs !== undefined);
  const avgDurationMs = completed.length > 0
    ? Math.round(completed.reduce((sum, f) => sum + (f.durationMs ?? 0), 0) / completed.length)
    : 0;
  const successRate = total > 0 ? done / total : 0;
  const timeoutRate = total > 0 ? timeout / total : 0;

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
  const recentSuccessRate = recentFlows.length > 0 ? recentDone / recentFlows.length : undefined;
  const lastInvoked = flows[flows.length - 1]?.startedAt;

  let level: HealthLevel;
  if (total < MIN_SAMPLE) level = 'insufficient';
  else if (timeoutRate > SLOW_TIMEOUT_RATE) level = 'slow';
  // cycle-53 T-5301：分级看近期窗口（recentSuccessRate）——修复后的连续成功
  // 应恢复 healthy，而非被历史失败永久钉死在 degraded/critical。
  // cycle-57 T-5702：时间窗空 → insufficient（当前状态不可判定）。
  else if (recentSuccessRate === undefined) level = 'insufficient';
  else if (recentSuccessRate < DEGRADED_SUCCESS_RATE) level = 'degraded';
  else if (avgDurationMs > EXPENSIVE_DURATION_MS) level = 'expensive';
  else level = 'healthy';

  return { script, level, total, successRate, timeoutRate, avgDurationMs, lastInvoked, recentSuccessRate };
}

/** suggestFromHealth 的「近期成功率展示串」：undefined=近 7 天无调用。 */
function recentView(h: ScriptHealth): string {
  return h.recentSuccessRate === undefined
    ? '近 7 天无调用'
    : `${(h.recentSuccessRate * 100).toFixed(0)}%（全史 ${(h.successRate * 100).toFixed(0)}%，${h.total} 次调用）`;
}

/** 根据健康指标生成改进建议。 */
function suggestFromHealth(h: ScriptHealth): ImprovementSuggestion | null {
  if (h.level === 'insufficient' || h.level === 'unused') return null;

  if (h.level === 'degraded') {
    return {
      id: `fix-${h.script}`,
      // cycle-53：critical 也看近期窗口——历史失败率 0% 但近期已恢复的脚本
      // 不该再打 critical（建议仍可生成，严重度按近期实际定）。
      // cycle-57：recentSuccessRate 已收窄非 undefined（degraded 分支保证）。
      severity: (h.recentSuccessRate ?? 0) < 0.5 ? 'critical' : 'warn',
      script: h.script,
      description: `${h.script} 近期成功率 ${recentView(h)}`,
      action: '检查 stderr 日志，定位失败原因，修复后重跑 eval',
    };
  }
  if (h.level === 'slow') {
    return {
      id: `speed-${h.script}`,
      severity: 'warn',
      script: h.script,
      description: `${h.script} 超时率 ${(h.timeoutRate * 100).toFixed(0)}%（${h.total} 次调用）`,
      action: '考虑增加 timeout 或优化脚本执行效率',
    };
  }
  if (h.level === 'expensive') {
    return {
      id: `perf-${h.script}`,
      severity: 'info',
      script: h.script,
      description: `${h.script} 平均耗时 ${h.avgDurationMs}ms`,
      action: '考虑缓存结果或拆分为更小步骤',
    };
  }
  return null;
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

  return {
    scripts,
    suggestions,
    overallSuccessRate,
    totalInvocations,
    generatedAt: new Date().toISOString(),
  };
}

/** 格式化健康报告为可读摘要（供 anic_status 返回）。 */
export function formatHealthSummary(report: SkillHealthReport): string {
  const lines: string[] = [];
  lines.push(`技能健康报告（${report.generatedAt}）`);
  lines.push(`总调用 ${report.totalInvocations} 次，全局成功率 ${(report.overallSuccessRate * 100).toFixed(0)}%`);
  lines.push('');
  for (const s of report.scripts) {
    const icon = s.level === 'healthy' ? '✅' : s.level === 'insufficient' ? '⚪' : '⚠️';
    // cycle-53：近史/全史分离展示——两量纲并存（近期=当前状态，全史=累计统计）。
    // cycle-57：recentSuccessRate 可 undefined（近 7 天无调用）——显示「无近期数据」。
    const recentPct = s.recentSuccessRate === undefined ? '无近期数据' : `${(s.recentSuccessRate * 100).toFixed(0)}%`;
    const overallPct = (s.successRate * 100).toFixed(0);
    // cycle-57 修：数值相等判定（旧代码拿 '100%' 与 '100' 做字符串比较——恒不等，
    // 单值形态永不出现，m-b「近期=全史」也打双量纲）。undefined 时恒双形态。
    const sameRate = s.recentSuccessRate !== undefined && (s.recentSuccessRate * 100).toFixed(0) === overallPct;
    const rateView = sameRate ? `${overallPct}%` : `近期 ${recentPct}/全史 ${overallPct}%`;
    lines.push(`${icon} ${s.script}: ${s.level}（${s.total} 次，${rateView}）`);
  }
  if (report.suggestions.length > 0) {
    lines.push('');
    lines.push('改进建议：');
    for (const s of report.suggestions) {
      lines.push(`  [${s.severity}] ${s.description} → ${s.action}`);
    }
  }
  return lines.join('\n');
}
