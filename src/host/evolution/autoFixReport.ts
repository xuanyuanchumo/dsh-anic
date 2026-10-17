/**
 * autoFixReport —— 自动修复循环落盘三件（技能 auto-fix-loop.mjs 逐字对齐）。
 *
 * 从 autoFixEngine.ts 拆出（T3 ≤250 行）：
 *  - recordFixAttempt（mjs:142-158）：审计行只追加已存在文件，不建文件；
 *    表头列与 HITL 共用，但补头标题是「## 自动修复循环记录」
 *  - recordAutoFixIncident（mjs:160-169）：incident-auto-fix-fail-<ts>.md
 *  - generateFixReport（mjs:171-200）：test-reports/auto-fix-report.md
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { AutoFixFailure, FixAttempt } from './autoFixAnalyze.ts';

/** 失败项摘要（技能 mjs:146/187 的 `${f.detail || counts}` 语义——按变体取值）。 */
export function failureSummary(f: AutoFixFailure): string {
  return f.type === 'test-report-failure' ? `${f.failures} failures, ${f.errors} errors` : f.detail;
}

/** 审计行（技能 recordFixAttempt mjs:142-158 逐字：只追加已存在文件，不建文件）。 */
export function recordFixAttempt(cycleDir: string, attempt: number, failures: AutoFixFailure[], fixSuccess: boolean): void {
  const auditLogPath = join(cycleDir, '审计日志.md');
  const timestamp = new Date().toISOString();
  const status = fixSuccess ? 'PASS' : 'FAIL';
  const failSummary = failures.map((f) => `${f.type}: ${failureSummary(f)}`).join('; ');
  const entry = `\n| ${timestamp} | auto-fix-loop | ${status} | Attempt ${attempt}: ${failSummary} | ${fixSuccess ? '修复成功' : '修复失败'} |\n`;
  if (!existsSync(auditLogPath)) return;
  const content = readFileSync(auditLogPath, 'utf-8');
  if (content.includes('| 时间 | 检查点 | 结果 | 详情 | 状态 |')) {
    atomicWriteFileSync(auditLogPath, content + entry);
  } else {
    const header = `\n## 自动修复循环记录\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n`;
    atomicWriteFileSync(auditLogPath, content + header + entry);
  }
}

/** 熔断 incident（技能 recordCircuitBreaker mjs:160-169 逐字）。 */
export function recordAutoFixIncident(workspaceRoot: string, reason: string): string {
  const incidentsDir = join(workspaceRoot, '.cycles', 'incidents');
  if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incidentPath = join(incidentsDir, `incident-auto-fix-fail-${timestamp}.md`);
  const content = `# 事故记录：自动修复循环熔断\n\n## 基本信息\n| 字段 | 值 |\n|---|---|\n| 时间 | ${timestamp} |\n| 事件 | 自动修复循环达到重试上限 |\n| 原因 | ${reason} |\n\n## 影响范围\n- 熔断条件 CB1 触发：同一异常连续3次自动修复失败\n- 自主级别应回退：L4 → L3\n- 需要人类介入诊断\n\n## 恢复条件\n- 根因已定位且修复已验证\n- 人类确认问题已修复\n`;
  atomicWriteFileSync(incidentPath, content);
  return incidentPath;
}

/** 修复循环报告（技能 generateFixReport mjs:171-200 逐字）。 */
export function generateFixReport(cycleDir: string, attempts: FixAttempt[], finalSuccess: boolean): string {
  const reportDir = join(cycleDir, 'test-reports');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'auto-fix-report.md');
  const timestamp = new Date().toISOString();
  const status = finalSuccess ? 'SUCCESS' : 'FAILED';
  let content = `# 自动修复循环报告\n\n## 基本信息\n| 字段 | 值 |\n|---|---|\n| 时间 | ${timestamp} |\n| 循环 | ${cycleDir} |\n| 状态 | ${status} |\n| 尝试次数 | ${attempts.length} |\n\n## 尝试记录\n`;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    content += `\n### 尝试 ${i + 1}\n`;
    content += `- 状态: ${attempt.success ? '成功' : '失败'}\n`;
    content += `- 识别的失败项: ${attempt.failures.length}\n`;
    for (const f of attempt.failures) {
      content += `  - ${f.type}: ${failureSummary(f)}\n`;
    }
    if (attempt.fixAction) content += `- 修复动作: ${attempt.fixAction}\n`;
  }
  if (!finalSuccess) {
    content += `\n## 熔断\n自动修复循环达到重试上限，触发熔断条件 CB1。\n需运行 \`org-status.mjs --auto-fallback\` 回退自主级别。\n`;
  }
  atomicWriteFileSync(reportPath, content);
  return reportPath;
}
