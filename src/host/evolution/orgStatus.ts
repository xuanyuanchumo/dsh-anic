/**
 * 组织状态聚合（原生实现，替代技能 org-status.mjs）。
 * 汇总 trust + autonomy + breakers + cycles + band → 全景状态。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceConfig } from '../config.ts';
import { loadLedger } from '../runtime/ledger.ts';
import { buildTrustScores, recommendBand, type AutonomyBand, type LedgerEntryForTrust } from './trustModel.ts';
import { checkBreakers, decideAction, type BreakerInput } from './autonomyGovernor.ts';
import { loadBandHistory, detectTrend, detectWeViolations, type WeViolation } from './bandDetector.ts';
import { collectBreakerSignals } from './breakerSignals.ts';

export interface OrgStatus {
  cycles: { total: number; latest: string | null; converged: number; failed: number };
  ledger: { entries: number; valid: boolean };
  trust: { scores: Record<string, { score: number; approve: number; total: number }>; recommendedBand: string };
  autonomy: { currentBand: string; configuredBand: string; breakers: string[]; action: string };
  band: { current: string; trend: string; weViolations: WeViolation[]; recent: number[] };
  flows: { selfInit: boolean; agentsOrchestration: boolean };
  timestamp: string;
}

export function runOrgStatus(workspaceRoot: string, options: {
  currentBand?: string;
  breakersInput?: Partial<BreakerInput>;
  currentScore?: number;
  flows?: { selfInit: boolean; agentsOrchestration: boolean };
}): OrgStatus {
  const cyclesDir = join(workspaceRoot, '.cycles');

  // Cycles
  const cyclesDir2 = join(cyclesDir, 'cycles');
  let cycleDirs: string[] = [];
  if (existsSync(cyclesDir2)) {
    cycleDirs = readdirSync(cyclesDir2).filter((d) => /^cycle-\d+$/.test(d));
  }
  const converged = cycleDirs.filter((d) => existsSync(join(cyclesDir2, d, '交付清单.md'))).length;
  const failed = cycleDirs.filter((d) => existsSync(join(cyclesDir2, d, '审计日志.md')) &&
    readFileSync(join(cyclesDir2, d, '审计日志.md'), 'utf-8').includes('FAIL')).length;
  const latestCycle = cycleDirs.length > 0 ? (cycleDirs[cycleDirs.length - 1] ?? null) : null;

  // Ledger
  let ledgerEntries = 0;
  let ledgerValid = true;
  const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
  const ledger: LedgerEntryForTrust[] = existsSync(ledgerPath) ? loadLedger(cyclesDir) : [];
  ledgerEntries = ledger.length;
  ledgerValid = ledger.every((e, i) => i === 0 || e.gate !== '');

  // Trust
  const trustScoresMap = buildTrustScores(ledger);
  const trustScores: Record<string, { score: number; approve: number; total: number }> = {};
  for (const [gate, ts] of trustScoresMap) {
    trustScores[gate] = { score: ts.trustScore, approve: ts.approveCount, total: ts.totalDecisions };
  }
  const avgTrust = ledger.length > 0
    ? Math.round(ledger.filter((e) => e.result.toLowerCase() === 'pass' || e.result.toLowerCase() === 'approve').length / ledger.length * 100)
    : 0;
  // P1（autonomy 双投影矛盾）：currentBand 缺省时经 INV-25 唯一 loader 读
  // `.cycles/config.yml` 的 `macro_cycle.autonomy_level`，而不是静默兜底 'L2'。
  // 此前同页两个投影会同时显示「autonomy L4」（snapshotCore 读配置）与
  // 「当前: L2」（本函数硬编码）—— 同一工作区、同一时刻、两个真相。
  // 显式传入 currentBand 的调用方（测试/降级路径）仍然优先。
  const configuredBand = loadWorkspaceConfig(cyclesDir).values.autonomyLevel;
  const band = (options.currentBand ?? configuredBand) as AutonomyBand;
  const recommendedBand = recommendBand(band, avgTrust);

  // Autonomy
  //
  // R3 阶段 1（已修）：此前 `DEFAULT_BREAKER_INPUT` 全零 —— checkBreakers 的 8 条
  // 判定从未在真实工作区触发过（纯函数 + 恒零输入 = 永不熔断）。现在由
  // collectBreakerSignals 从真实文件采集（incidents/账本/band-history/config.yml，
  // 对齐技能侧 org-status.mjs:25-82 CB1-CB8），显式 options.breakersInput 仍可
  // 覆盖（测试与持有更丰富信号的调用方优先）。
  const breakerInput: BreakerInput = { ...collectBreakerSignals(workspaceRoot), ...options.breakersInput };
  const breakerResults = checkBreakers(breakerInput);
  const action = decideAction(band, breakerResults);

  // Band
  const bandHistory = loadBandHistory(workspaceRoot);
  const bandCurrent = bandHistory.length > 0 ? (bandHistory[bandHistory.length - 1]?.band ?? 'normal') : 'normal';
  // P3（已修）：trend 原为硬编码 'stable' —— bandDetector.detectTrend 早已实现
  // 却从未被接线（R3 双真相源审计 #10）。现在从真实 band-history 分数序列推导。
  const bandTrend = detectTrend(bandHistory.map((e) => e.score));
  // WE 8 规则（cycle-7 移植）的可观测面：org 面板此前只显示 current/trend，
  // 违例事实被采集却不可见 —— 动态白盒要求「能涉及的方面都可见」。
  const weViolations = detectWeViolations(bandHistory.map((e) => e.score));
  // cycle-20（P2 仪表带）：最近 12 个分数点——趋势火花线的数据面。
  // 空历史 → 空数组（客户端省略火花线，不伪造平线）。
  const recentScores = bandHistory.slice(-12).map((e) => e.score);

  return {
    cycles: { total: cycleDirs.length, latest: latestCycle, converged, failed },
    ledger: { entries: ledgerEntries, valid: ledgerValid },
    trust: { scores: trustScores, recommendedBand },
    autonomy: { currentBand: band, configuredBand, breakers: breakerResults.filter((b) => b.tripped).map((b) => b.id), action },
    band: { current: bandCurrent, trend: bandTrend, weViolations, recent: recentScores },
    flows: options.flows ?? { selfInit: true, agentsOrchestration: true },
    timestamp: new Date().toISOString(),
  };
}
