/**
 * 健康面改进建议（cycle-85 从 continuousLearning 拆出）。
 *
 * ## 为什么建议要同时给两个口径
 *
 * cycle-85 · O-84-01 之前，建议直接用**原始成功率**：
 * `gate-check 近期成功率 25%（critical）→ 检查 stderr，定位失败原因`。
 * 而真实情况是它每次都在**正确地拒绝放行**——按这条建议去查 stderr，
 * 永远查不到东西（因为根本没有错误），只会浪费下一轮迭代。
 *
 * 现在：严重度按**有效**成功率（含有效负裁决）定，描述里把
 * 「有效 X% / 原始 Y% / 有效负裁决 N 次」三个数一起给出。任何只报一个数的
 * 形态都会在某个方向上误导，而白盒的要求是读者自己能判断。
 *
 * 类型从 `continuousLearning.ts` **type-only** 引入（运行时不构成环，
 * `skillConvergenceContract` 已把类型导入/再导出与真运行时环分开判定）。
 */
import type { HealthLevel, ImprovementSuggestion, ScriptHealth } from './continuousLearning.ts';

/** 建议面需要的最小健康字段（结构子集，避免整包耦合）。 */
export type SuggestableHealth = Pick<
  ScriptHealth,
  'script' | 'level' | 'total' | 'successRate' | 'timeoutRate' | 'avgDurationMs' | 'validVerdicts'
> & Pick<ScriptHealth, 'recentSuccessRate' | 'recentEffectiveRate'>;

/** 「近期成功率展示串」：undefined=近 7 天无调用。 */
export function recentView(h: SuggestableHealth): string {
  if (h.recentEffectiveRate === undefined) return '近 7 天无调用';
  const eff = (h.recentEffectiveRate * 100).toFixed(0);
  const raw = h.recentSuccessRate === undefined ? '—' : `${(h.recentSuccessRate * 100).toFixed(0)}%`;
  const verdictNote = h.validVerdicts > 0 ? `，其中有效负裁决 ${String(h.validVerdicts)} 次` : '';
  return `有效 ${eff}%（原始成功 ${raw}，全史 ${(h.successRate * 100).toFixed(0)}%，${String(h.total)} 次调用${verdictNote}）`;
}

/** 根据健康指标生成改进建议（null = 该等级不需要建议）。 */
export function suggestFromHealth(h: SuggestableHealth & { level: HealthLevel }): ImprovementSuggestion | null {
  if (h.level === 'insufficient' || h.level === 'unused') return null;

  if (h.level === 'degraded') {
    return {
      id: `fix-${h.script}`,
      // cycle-53：按近期窗口定严重度（历史差但近期已恢复的不该再 critical）。
      // cycle-85：按**有效**成功率定（有效负裁决不算故障）。
      severity: (h.recentEffectiveRate ?? 0) < 0.5 ? 'critical' : 'warn',
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
      description: `${h.script} 超时率 ${(h.timeoutRate * 100).toFixed(0)}%（${String(h.total)} 次调用）`,
      action: '考虑增加 timeout 或优化脚本执行效率',
    };
  }
  if (h.level === 'expensive') {
    return {
      id: `perf-${h.script}`,
      severity: 'info',
      script: h.script,
      description: `${h.script} 平均耗时 ${String(h.avgDurationMs)}ms`,
      action: '考虑缓存结果或拆分为更小步骤',
    };
  }
  return null;
}
