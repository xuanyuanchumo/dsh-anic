/**
 * 真实性审计：自举的四项基础目标（用户 m04764）。
 * T1 真实性（文件存在）/ T2 准确性（计数与版本）/ T3 结构性（模块限制）/ T4 逻辑性（注册与导入）。
 * 四维检查函数拆至 truthAuditChecks.ts 以满足 250 行模块限制；
 * 共享类型拆至 truthAuditTypes.ts 以断开与检查模块的循环 import（D-1408）。
 */
import type {
  AuditFinding,
  TruthAuditResult,
  TruthAuditSummary,
} from './truthAuditTypes.ts';

import {
  auditTruthfulness,
  auditAccuracy,
  auditStructure,
  auditLogic,
} from './truthAuditChecks.ts';

// 类型从此处再导出，消费方（dualBootstrap.ts 等）的导入路径保持稳定。
export type { AuditFinding, TruthAuditResult, TruthAuditSummary };

export { auditTruthfulness, auditAccuracy, auditStructure, auditLogic };

export function runTruthAudit(pluginDir: string): TruthAuditSummary {
  const results: TruthAuditResult[] = [
    auditTruthfulness(pluginDir),
    auditAccuracy(pluginDir),
    auditStructure(pluginDir),
    auditLogic(pluginDir),
  ];
  const overallScore = Math.round(
    results.reduce((sum, r) => sum + r.score, 0) / results.length,
  );
  const failCount = results.reduce(
    (sum, r) => sum + r.findings.filter((f) => f.status === 'fail').length,
    0,
  );
  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
  return {
    results,
    overallScore,
    allPassed: failCount === 0,
    totalFindings,
    failCount,
  };
}
