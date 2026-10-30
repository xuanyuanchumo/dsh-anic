/**
 * 健康摘要格式化（cycle-88 从 continuousLearning 拆出）。
 *
 * 拆分原因：usage 三分法（done/verdict/usage）让主文件越过 250 行纪律；
 * 摘要是**纯展示层**（无计算），独立成文件后两边都更专注。
 * 摘要同时输出「原始 / 有效 / 有效负裁决 / 用法错误」四个数——只报一个
 * 都会在某个方向误导（cycle-85/88 的两次误判都是"只看一个数"造成的）。
 */
import type { SkillHealthReport } from './continuousLearning.ts';

/** 格式化健康报告为可读摘要（供 anic_status 返回）。 */
export function formatHealthSummary(report: SkillHealthReport): string {
  const lines: string[] = [];
  lines.push(`技能健康报告（${report.generatedAt}）`);
  lines.push(`总调用 ${report.totalInvocations} 次，全局成功率 ${(report.overallSuccessRate * 100).toFixed(0)}%`
    + `（有效 ${(report.overallEffectiveRate * 100).toFixed(0)}%，含有效负裁决 ${report.totalValidVerdicts} 次`);
  const usageLine = report.totalUsageErrors > 0
    ? `，调用方用法错误 ${report.totalUsageErrors} 次不计入）`
    : '）';
  lines[lines.length - 1] += usageLine;
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
    // cycle-85：有效负裁决次数单独列出——它是"守卫生效"的证据，不是故障。
    const verdictView = s.validVerdicts > 0 ? `，有效负裁决 ${s.validVerdicts}` : '';
    const usageView = s.usageErrors > 0 ? `，用法错误 ${s.usageErrors}（不计入）` : '';
    lines.push(`${icon} ${s.script}: ${s.level}（${s.total} 次，${rateView}${verdictView}${usageView}）`);
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
