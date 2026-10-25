/**
 * M10-c 模块引擎接入：将自举编排器输出馈入 evolution/governance 模块引擎进行深度分析。
 *
 * 各流程插件化后拥有专属的流程状态流转机（FlowTracker，M10-a）与对应的模块引擎
 * （本文件）：eval 结果 → patchEngine 产 tech-debt；gate 结果 → hitlAudit 产审计发现。
 *
 * 此模块是编排器（bootstrapOrchestrator）与模块引擎（evolution/governance）之间的
 * 薄集成层——编排器驱动脚本执行，本层将脚本输出馈入原生引擎做深度分析。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  generateTechDebt,
  writeTechDebt,
  type EvalResult,
  type TechDebtEntry,
} from '../evolution/patchEngine.ts';
import { runHitlAudit, type HitlResult } from '../governance/hitlAudit.ts';
import { runFactBaseVerify, type FactBaseResult } from '../governance/factBaseVerify.ts';
import { runSelfBootstrapCycle, type BootstrapCycleResult } from './bootstrapOrchestrator.ts';
import { BOOTSTRAP_STEP_TIMEOUT_MS } from './bootstrapBudget.ts';

export interface EngineInsights {
  /** eval 结果 → patchEngine 产 tech-debt 条目 */
  techDebt: TechDebtEntry[];
  /** tech-debt 文件路径 */
  techDebtFiles: string[];
  /** gate 结果 → hitlAudit 产审计发现 */
  hitlChecks: HitlResult[];
  hitlAllPassed: boolean;
  /** fact-base 验证结果 */
  factBase: FactBaseResult;
  /** 综合风险评分（0-1，越高越危险） */
  riskScore: number;
}

/**
 * 将自举循环结果馈入模块引擎进行深度分析。
 *
 * @param result 自举编排器输出
 * @param workspace 工作区路径
 * @returns 引擎洞察（tech-debt + HITL + fact-base + 风险评分）
 */
export function analyzeBootstrapWithEngines(
  result: BootstrapCycleResult,
  workspace: string,
): EngineInsights {
  const cyclesDir = join(workspace, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });

  // ── 1. eval 结果 → patchEngine 产 tech-debt ──
  const evalResults: EvalResult[] = result.rounds.map((r) => ({
    dimension: 'E4',
    passed: r.gateVerdict === 'PASS' || r.gateVerdict === 'approve',
    score: r.evalScore,
    detail: `round ${r.round}: eval=${r.evalScore.toFixed(2)}, gate=${r.gateVerdict}, fix=${r.fixApplied ?? 'none'}`,
  }));
  const techDebt = generateTechDebt(evalResults);
  const techDebtFiles = writeTechDebt(techDebt, cyclesDir);

  // ── 2. gate 结果 → hitlAudit 产审计发现 ──
  const hitlAuditResult = runHitlAudit(workspace);

  // ── 3. fact-base 验证 ──
  const factBase = runFactBaseVerify(workspace);

  // ── 4. 综合风险评分 ──
  const debtRisk = techDebt.length > 0
    ? Math.min(techDebt.filter((d) => d.severity === 'critical').length / 3
      + techDebt.filter((d) => d.severity === 'high').length / 5, 1)
    : 0;
  const hitlRisk = hitlAuditResult.allPassed ? 0 : 0.3;
  // 分母只取**可核**声明（verified + absent）：`unscannable` 是「核不了」而不是
  // 「缺失」，把它算进分母会让「文档里没有可核锚点」变成风险分（cycle-38 修：
  // v1 用 missing/total，而 total 里有 72% 是无锚点声明，风险分实为噪声）。
  // 一条都不可核 → 该项风险记为 0 并在 factBase.unscannable 里如实暴露，不猜。
  const verifiable = factBase.verified + factBase.missing;
  const factRisk = verifiable > 0 ? (factBase.missing / verifiable) * 0.4 : 0;
  const riskScore = Math.min(debtRisk + hitlRisk + factRisk, 1);

  return {
    techDebt,
    techDebtFiles,
    hitlChecks: hitlAuditResult.checks,
    hitlAllPassed: hitlAuditResult.allPassed,
    factBase,
    riskScore,
  };
}

/**
 * 增强版自举循环：编排器 + 模块引擎。
 *
 * 先运行脚本编排器（M10-b），再将结果馈入模块引擎（M10-c）做深度分析。
 * 返回编排器结果 + 引擎洞察。
 */
export function runBootstrapWithEngines(
  workspace: string,
  maxRounds = 3,
  // cycle-77（F-06）：第三处裸 60000 收敛——它会把「不传第三参」的调用静默降级到 60s，
  // 与 BOOTSTRAP_STEP_TIMEOUT_MS(240000) 反向漂移（生产路径总是显式传值，故此前不可达，
  // 但不可达的第二默认源仍是隐患：任何新调用方都会继承错默认）。
  timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,
): { cycle: BootstrapCycleResult; insights: EngineInsights } {
  const cycle = runSelfBootstrapCycle(workspace, maxRounds, timeoutMs);
  const insights = analyzeBootstrapWithEngines(cycle, workspace);
  return { cycle, insights };
}
