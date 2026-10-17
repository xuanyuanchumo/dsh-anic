/**
 * HITL 三段修复 —— 原生编排（R3 阶段 4 后半，对齐技能 hitl-audit.mjs:293-383）。
 *
 * 三段流程（Fix-First Strategy）：
 *   Phase 0 审计：跑 H1-H4（hitlAudit.ts 既有检查），每条结果落审计日志表行
 *   Phase 1 修复：仅对熔断检查点尝试自动修复（hitlFix.ts）
 *   Phase 2 重审：全部修复成功才重审熔断门；仍熔断 → incident 落盘 + 降级建议
 *
 * 判定语义（技能 exit 码逐字对齐）：
 *   全过（含修复后全过）→ pass（exit 0）
 *   有失败但无熔断       → fail（exit 1）
 *   修复尝试后仍熔断     → circuit（exit 2）+ suggestedNextStep=autonomy-fallback
 *
 * 诚实纪律：hitl-audit 本身不执行降级（技能同款——降级是 org-status
 * auto-fallback 的职责），incident 只陈述「已触发 + 建议回退」，不声称未发生的降级。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { latestCycleDir } from '../llm/gateEvidence.ts';
import { runHitlAudit, type HitlResult } from './hitlAudit.ts';
import { HITL_FIXERS, writeHitlIncident, type FixOutcome } from './hitlFix.ts';

export type HitlGateId = 'H1' | 'H2' | 'H3' | 'H4';
export type HitlVerdict = 'pass' | 'fail' | 'circuit';

export interface HitlCheckView {
  gate: HitlGateId;
  pass: boolean;
  circuit: boolean;
  detail: string;
}

export interface HitlFixView {
  gate: HitlGateId;
  success: boolean;
  action?: string;
  reason?: string;
}

export interface HitlThreePhaseResult {
  verdict: HitlVerdict;
  exitCode: 0 | 1 | 2;
  /** Phase 0 全部受检门的初始结果 */
  checks: HitlCheckView[];
  /** Phase 0 中熔断的门 */
  circuits: HitlGateId[];
  /** Phase 1 修复尝试（仅熔断门） */
  fixes: HitlFixView[];
  /** Phase 2 重审结果（仅全部修复成功时非空） */
  rechecks: HitlCheckView[];
  /** Phase 2 仍熔断门的 incident 落盘路径 */
  incidents: Array<{ gate: HitlGateId; path: string }>;
  /** 审计日志路径（无 cycle 目录时 null——技能 recordAuditResult 同款静默跳过） */
  auditLogPath: string | null;
  /** circuit 判定后的建议下一步（技能 exit 2 的 stdout 指引） */
  suggestedNextStep: 'autonomy-fallback' | null;
}

const ALL_GATES: HitlGateId[] = ['H1', 'H2', 'H3', 'H4'];

/** 审计日志表行落盘（技能 recordAuditResult:161-178 同构：只追加到已存在的审计日志，不存在则静默跳过）。 */
function recordAuditRow(auditLogPath: string, gate: HitlGateId, result: HitlResult): void {
  if (!existsSync(auditLogPath)) return; // 技能同款：审计日志不存在不创建（创建是 H3 fix 的职责）
  const timestamp = new Date().toISOString();
  const row = `\n| ${timestamp} | ${gate} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.detail} | ${result.circuit ? '熔断' : '正常'} |\n`;
  const content = readFileSync(auditLogPath, 'utf-8');
  if (content.includes('| 时间 | 检查点 | 结果 | 详情 | 状态 |')) {
    atomicWriteFileSync(auditLogPath, content + row);
  } else {
    const header = '\n## HITL 自动审计记录\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n';
    atomicWriteFileSync(auditLogPath, content + header + row);
  }
}

function toView(r: HitlResult): HitlCheckView {
  return { gate: r.check, pass: r.passed, circuit: r.circuit, detail: r.detail };
}

/**
 * 原生三段修复（native 引擎路径）。
 * gate='all' 或指定单门（技能 --gate 语义：只检查指定门）。
 */
export function runHitlThreePhaseNative(
  workspaceRoot: string,
  gate: 'all' | HitlGateId = 'all',
): HitlThreePhaseResult {
  const scoped = gate === 'all' ? ALL_GATES : [gate];
  const full = runHitlAudit(workspaceRoot);
  const phase0 = full.checks.filter((c) => scoped.includes(c.check));

  // 审计日志落点：最新 cycle 的 审计日志.md；无 cycle 目录 → 静默跳过（技能同款）。
  // latestCycleDir 返回完整路径——直接 join 文件名（同 gateEngine.ts:44 陷阱注记）
  const latest = latestCycleDir(join(workspaceRoot, '.cycles'));
  const auditLogPath = latest !== null ? join(latest, '审计日志.md') : null;

  // Phase 0：记录初始结果
  for (const c of phase0) {
    if (auditLogPath) recordAuditRow(auditLogPath, c.check, c);
  }

  const circuits = phase0.filter((c) => c.circuit);
  const anyCircuit = circuits.length > 0;
  const allPassed = phase0.every((c) => c.passed);

  // 无熔断：pass / fail 二元判定（技能 379-384 分支）
  if (!anyCircuit) {
    return {
      verdict: allPassed ? 'pass' : 'fail',
      exitCode: allPassed ? 0 : 1,
      checks: phase0.map(toView),
      circuits: [],
      fixes: [],
      rechecks: [],
      incidents: [],
      auditLogPath,
      suggestedNextStep: null,
    };
  }

  // Phase 1：对熔断门逐个尝试修复
  const fixes: HitlFixView[] = [];
  let allFixed = true;
  for (const c of circuits) {
    const outcome: FixOutcome = HITL_FIXERS[c.check](workspaceRoot, c);
    fixes.push({ gate: c.check, success: outcome.success, action: outcome.action, reason: outcome.reason });
    if (!outcome.success) allFixed = false;
  }

  // Phase 2：全部修复成功才重审熔断门（技能 354-374）
  const rechecks: HitlCheckView[] = [];
  const incidents: Array<{ gate: HitlGateId; path: string }> = [];
  let stillCircuit = false;

  if (allFixed) {
    const reFull = runHitlAudit(workspaceRoot);
    for (const c of circuits) {
      const re = reFull.checks.find((r) => r.check === c.check);
      if (!re) continue; // 不可达（runHitlAudit 恒产四门）；防御性跳过
      if (auditLogPath) recordAuditRow(auditLogPath, re.check, re);
      rechecks.push(toView(re));
      if (re.circuit) {
        stillCircuit = true;
        incidents.push({ gate: re.check, path: writeHitlIncident(workspaceRoot, re.check, re.detail) });
      }
    }
    if (!stillCircuit) {
      return {
        verdict: 'pass',
        exitCode: 0,
        checks: phase0.map(toView),
        circuits: circuits.map((c) => c.check),
        fixes,
        rechecks,
        incidents,
        auditLogPath,
        suggestedNextStep: null,
      };
    }
  }
  // 修复未全成功（技能同款：不重审、不落 incident——incident 只属 Phase 2 仍熔断门）
  // 或 Phase 2 重审后仍熔断 → circuit 判定

  return {
    verdict: 'circuit',
    exitCode: 2,
    checks: phase0.map(toView),
    circuits: circuits.map((c) => c.check),
    fixes,
    rechecks,
    incidents,
    auditLogPath,
    suggestedNextStep: 'autonomy-fallback',
  };
}
