/**
 * 自主级变更证据采集（cycle-77 T4）—— history 记录里 `evidence` 的唯一生产者。
 *
 * 为什么单独一层：变更记录不只要写「谁在何时改档」，还要能**复算**「凭什么」。
 * 若升级工具与降级路径各算一份证据，两边必然漂移（本仓既有先例：双份解析器
 * 恒定漂移）；故两类变更共用本模块，且与 org-status 的信任度算法同源
 * （`buildTrustScores` / `recommendBand` / `checkBreakers`），不另立第二套口径。
 *
 * 诚实性约束（与 breakerSignals 同纪律）：
 *   - 账本缺失 → 信任分不是「0 分」而是「无证据」；此处如实给 avg=0 且 gates={}，
 *     由调用方在拒绝理由里区分「无账本」与「有账本但分低」。
 *   - `gates` 只收录账本里**真实出现过**的 gate 最新裁决，缺失的 G2/G3 不补默认值。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLedger } from '../runtime/ledger.ts';
import { buildTrustScores, recommendBand, type AutonomyBand } from './trustModel.ts';
import { checkBreakers } from './autonomyGovernor.ts';
import { collectBreakerSignals } from './breakerSignals.ts';
import type { AutonomyEvidenceSnapshot } from './autonomyHistory.ts';

/** 证据采集结果（快照 + 供前置条件判定用的原始数）。 */
export interface AutonomyEvidence extends AutonomyEvidenceSnapshot {
  /** 账本条目总数（0 = 无信任证据，与「有账本但全 FAIL」不同）。 */
  ledgerEntries: number;
  /** 触发的熔断详情（结构给前置条件判定用；breakers 只有 id）。 */
  trippedBreakers: Array<{ id: string; detail: string }>;
}

/** 取账本逐 gate 最新裁决（按时间序取最后一条；空 gate 名不计入）。 */
export function latestGateVerdicts(ledger: Array<{ gate: string; result: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ledger) {
    if (typeof e.gate === 'string' && e.gate !== '') out[e.gate] = e.result;
  }
  return out;
}

/** 工作区最新 cycle 号（无 `.cycles/cycles` 或无非数字目录 → undefined）。 */
export function latestCycleNumber(cyclesDir: string): number | undefined {
  const dir = join(cyclesDir, 'cycles');
  if (!existsSync(dir)) return undefined;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return undefined; }
  let max = 0;
  for (const name of names) {
    const m = /^cycle-(\d+)$/.exec(name);
    if (m?.[1] === undefined) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : undefined;
}

/**
 * 采集一次自主级变更的证据快照。
 *
 * @param workspaceRoot 工作区根（含 `.cycles/`）
 * @param currentBand 判定 recommendedBand 的基准档（写入前的真实档）
 */
export function collectAutonomyEvidence(workspaceRoot: string, currentBand: AutonomyBand): AutonomyEvidence {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const ledger = loadLedger(cyclesDir);
  const scores = buildTrustScores(ledger);
  const gates: Record<string, number> = {};
  for (const [gate, score] of scores) gates[gate] = score.trustScore;
  const passed = ledger.filter((e) => e.result === 'PASS').length;
  const avg = ledger.length > 0 ? Math.round((passed / ledger.length) * 100) : 0;

  const breakerResults = checkBreakers(collectBreakerSignals(workspaceRoot));
  const tripped = breakerResults.filter((b) => b.tripped);

  return {
    trust: { avg, gates },
    breakers: tripped.map((b) => b.id),
    gates: latestGateVerdicts(ledger),
    recommendedBand: recommendBand(currentBand, avg),
    ledgerEntries: ledger.length,
    trippedBreakers: tripped.map((b) => ({ id: b.id, detail: b.detail })),
  };
}
