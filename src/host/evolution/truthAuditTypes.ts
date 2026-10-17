/**
 * 真实性审计共享类型（D-1408，cycle-14）。
 *
 * 原先三个 interface 定义在 truthAudit.ts、检查函数拆在 truthAuditChecks.ts——
 * 检查函数回引类型形成 truthAudit ↔ truthAuditChecks 循环 import（纯 Node
 * importGraph 环检测在自家仓的首次真实命中；旧 madge 实现会把它吞成 SKIP）。
 * 类型下沉到本第三模块，两边各自单向导入，环即断开。
 */

export interface AuditFinding {
  check: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface TruthAuditResult {
  dimension: string;
  passed: boolean;
  score: number;
  findings: AuditFinding[];
}

export interface TruthAuditSummary {
  results: TruthAuditResult[];
  overallScore: number;
  allPassed: boolean;
  totalFindings: number;
  failCount: number;
}
