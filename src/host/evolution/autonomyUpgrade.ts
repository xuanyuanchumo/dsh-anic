/**
 * 自主级**升级**路径（cycle-77 T4）—— 把「人类授权的 L4 激活」做成机器可判定的事实。
 *
 * 被守卫缺陷（实测）：本插件只有 `anic_autonomy_downgrade`（降级），升级按设计
 * 需要人类，于是**根本没有升级入口**——用户要求「以 L4 全自主模式驱动自举循环」时，
 * 唯一做法是手改 `.cycles/config.yml`：无前置判定、无回读断言、无审计记录。
 * 结果是「人类授权的 L4」与「偷偷改配置」在磁盘上**无法区分**。
 *
 * 修法：把升级做成**前置条件表 + 写后回读 + 结构化留痕**三件套：
 *   P1 config 存在且能解析出当前档（否则拒绝并点名）；
 *   P2 目标档合法且与当前档**相邻**（禁止跳档 L2→L4）；
 *   P3 无 tripped breaker（有熔断时不升级——否则与人机共治的降级逻辑互相打脸）；
 *   P4 信任分满足 `trustModel.UPGRADE_THRESHOLDS`。**人类显式授权可豁免本条**：
 *      信任分不足是「机器证据不足」，而人类显式承担是另一种合法证据源；豁免事实
 *      必须写进 history（`trustExemption`），不是静默放宽；
 *   P5 目标 L4 时**必须** `humanAuthorized: true`（升级到最高自主级不接受机器自证）。
 * 拒绝路径**不写任何文件**，返回点名缺哪条（`missingPreconditions`）与当时证据。
 * 成功路径先改 config，再回读断言 observed===intent，最后才追加 history——
 * 回读不一致时返回 `upgrade-failed` 且**不写**「已升级」记录（记录与效果不得解耦）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areAdjacentBands, appendHistory, MAX_HISTORY_ENTRIES } from './autonomyHistory.ts';
import { collectAutonomyEvidence, latestCycleNumber } from './autonomyEvidence.ts';
import { parseConfiguredAutonomyLevel, rewriteAutonomyLevel } from './autonomyActions.ts';
import { UPGRADE_THRESHOLDS, type AutonomyBand } from './trustModel.ts';
import type { AutonomyUpgradeResult, UpgradeOptions } from './autonomyUpgradeTypes.ts';

/** 升级目标只允许 L3/L4（与工具 schema enum 同源；运行时再判一次防绕过）。 */
export function isAllowedUpgradeTarget(target: string): target is 'L3' | 'L4' {
  return target === 'L3' || target === 'L4';
}

/**
 * 执行一次自主级升级（全部前置条件机器判定）。
 *
 * 返回值只陈述**回读到的**事实：拒绝零写入、失败不写成功记录。
 */
export function upgradeAutonomy(workspaceRoot: string, options: UpgradeOptions): AutonomyUpgradeResult {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const configPath = join(cyclesDir, 'config.yml');
  const missing: AutonomyUpgradeResult['missingPreconditions'] = [];
  const base = {
    target: options.target,
    threshold: null as number | null,
    trust: { avg: 0, verdict: 'no-evidence' as AutonomyUpgradeResult['trust']['verdict'] },
    trippedBreakers: [] as string[],
    authorization: null as AutonomyUpgradeResult['authorization'],
    historyRecorded: false,
    historyPath: null as string | null,
    configPath,
  };

  if (!existsSync(configPath)) {
    return {
      ...base, action: 'refused', from: null, observed: null,
      missingPreconditions: [{ code: 'config_missing', detail: `${configPath} not found` }],
      reason: 'config file missing',
    };
  }
  const currentBand = parseConfiguredAutonomyLevel(readFileSync(configPath, 'utf-8'));
  if (currentBand === null) {
    return {
      ...base, action: 'refused', from: null, observed: null,
      missingPreconditions: [{ code: 'current_band_unknown', detail: 'no autonomy_level in config.yml' }],
      reason: 'no autonomy_level in config',
    };
  }
  const evidence = collectAutonomyEvidence(workspaceRoot, currentBand);
  const thresholdKey = `${currentBand}_to_${options.target}`;
  const threshold = UPGRADE_THRESHOLDS[thresholdKey] ?? null;
  const humanAuthorized = options.humanAuthorized === true;
  const trustEnough = threshold !== null && evidence.trust.avg >= threshold;
  const trustVerdict: AutonomyUpgradeResult['trust']['verdict'] =
    evidence.ledgerEntries === 0 ? 'no-evidence'
      : trustEnough ? 'sufficient'
        : humanAuthorized ? 'exempt-by-human' : 'insufficient';

  // ── 前置条件表：逐条判定，拒绝时点名（顺序即优先级，便于人读） ──
  if (options.reason.trim() === '') {
    missing.push({ code: 'reason_required', detail: 'reason must be a non-empty string' });
  }
  if (!isAllowedUpgradeTarget(options.target)) {
    missing.push({ code: 'target_not_allowed', detail: `target "${options.target}" is not L3/L4` });
  } else if (!areAdjacentBands(currentBand, options.target)) {
    missing.push({
      code: 'target_not_adjacent',
      detail: `cannot jump ${currentBand} -> ${options.target} (only adjacent single-step upgrades)`,
    });
  }
  if (evidence.trippedBreakers.length > 0) {
    missing.push({
      code: 'breaker_tripped',
      detail: `tripped breakers: ${evidence.trippedBreakers.map((b) => b.id).join(', ')}`,
    });
  }
  // 阈值只在「相邻且合法」时有定义（UPGRADE_THRESHOLDS 无 L2_to_L4 之类键）：
  // 无定义时**不追加** trust_below_threshold，否则拒绝理由会写成
  // 「trust < threshold n/a」——用一个不存在的阈值控诉，是误导而不是证据。
  if (threshold !== null && !trustEnough && !humanAuthorized) {
    missing.push({
      code: 'trust_below_threshold',
      detail: `trust avg ${String(evidence.trust.avg)} < threshold ${String(threshold)} for ${thresholdKey}`
        + (evidence.ledgerEntries === 0 ? ' (no ledger evidence)' : ''),
    });
  }
  // L3→L4 追加人类授权要求（从 L2 等其它档出发时由相邻性先拒，不重复控诉）
  if (currentBand === 'L3' && options.target === 'L4' && !humanAuthorized) {
    missing.push({
      code: 'human_authorization_required',
      detail: 'L3 -> L4 requires humanAuthorized=true (highest autonomy cannot be self-granted)',
    });
  }

  if (missing.length > 0) {
    // 拒绝路径：零写入（不碰 config，不碰 history）
    return {
      ...base,
      action: 'refused',
      from: currentBand,
      observed: null,
      missingPreconditions: missing,
      threshold,
      trust: { avg: evidence.trust.avg, verdict: trustVerdict },
      trippedBreakers: evidence.breakers,
      reason: `refused: ${missing.map((m) => m.code).join(', ')}`,
    };
  }

  // ── 写入 + Post-Verify（observed===intent 才算成功） ──
  // 写盘异常必须是**结构化失败**而不是把异常抛到工具边界：工具调用方要能分辨
  // 「拒绝（没动）」与「写失败（可能动了）」，两者对工作区事实的影响不同。
  const toBand = options.target as AutonomyBand;
  let applied: { ok: boolean; observedLevel: AutonomyBand | null; reason: string };
  try {
    applied = rewriteAutonomyLevel(configPath, currentBand, toBand);
  } catch (e) {
    return {
      ...base,
      action: 'upgrade-failed',
      from: currentBand,
      observed: null,
      missingPreconditions: [],
      threshold,
      trust: { avg: evidence.trust.avg, verdict: trustVerdict },
      trippedBreakers: evidence.breakers,
      reason: `config write threw: ${(e as Error).message}`,
    };
  }
  if (!applied.ok) {
    return {
      ...base,
      action: 'upgrade-failed',
      from: currentBand,
      observed: applied.observedLevel,
      missingPreconditions: [],
      threshold,
      trust: { avg: evidence.trust.avg, verdict: trustVerdict },
      trippedBreakers: evidence.breakers,
      reason: `post-verify failed: ${applied.reason}`,
    };
  }

  const authorization: AutonomyUpgradeResult['authorization'] = humanAuthorized ? 'human' : 'system';
  let historyRecorded = false;
  let historyPath: string | null = null;
  if (options.record !== false) {
    const atCycle = latestCycleNumber(cyclesDir);
    const appended = appendHistory(cyclesDir, {
      from: currentBand,
      to: toBand,
      at: new Date().toISOString(),
      actor: options.actor ?? 'anic_autonomy_upgrade',
      reason: options.reason.trim(),
      authorization,
      evidence: {
        trust: evidence.trust,
        breakers: evidence.breakers,
        gates: evidence.gates,
        recommendedBand: evidence.recommendedBand,
      },
      // 人类豁免信任阈值时把「豁免了什么」写进账：否则事后看 avg<85 会像 bug
      ...(trustVerdict === 'exempt-by-human' && threshold !== null
        ? { trustExemption: { avg: evidence.trust.avg, threshold } }
        : {}),
      ...(atCycle !== undefined ? { atCycle } : {}),
    });
    historyRecorded = appended.ok;
    historyPath = appended.path;
    if (!appended.ok) {
      // history 写失败不回滚 config（已发生的事实不伪造），但动作整体如实降级为失败：
      // 无审计记录的升级在 P0「不可审计」语境下不算成功。
      return {
        ...base,
        action: 'upgrade-failed',
        from: currentBand,
        observed: applied.observedLevel,
        missingPreconditions: [{ code: 'history_unrecorded', detail: `history append failed: ${appended.error ?? ''}` }],
        threshold,
        trust: { avg: evidence.trust.avg, verdict: trustVerdict },
        trippedBreakers: evidence.breakers,
        authorization,
        historyPath,
        reason: `config upgraded to ${toBand} but history not recorded: ${appended.error ?? 'unknown'}`,
      };
    }
  }

  return {
    ...base,
    action: 'upgraded',
    from: currentBand,
    observed: applied.observedLevel,
    missingPreconditions: [],
    threshold,
    trust: { avg: evidence.trust.avg, verdict: trustVerdict },
    trippedBreakers: evidence.breakers,
    authorization,
    historyRecorded,
    historyPath,
    reason: historyRecorded
      ? `upgraded ${currentBand} -> ${observedOrNull(applied.observedLevel)} (post-verify ok, history recorded)`
      // record=false 时如实标记审计缺口，不把「无记录」说成正常完成
      : `upgraded ${currentBand} -> ${observedOrNull(applied.observedLevel)} (post-verify ok, AUDIT GAP: record=false)`,
  };
}

/** 回读档位渲染（null 不伪造成字符串 "null"）。 */
function observedOrNull(b: AutonomyBand | null): string {
  return b ?? 'none';
}

/** history 有界上限的再导出：工具响应里回显「保留策略」而不是假装全量。 */
export const UPGRADE_HISTORY_LIMIT = MAX_HISTORY_ENTRIES;
