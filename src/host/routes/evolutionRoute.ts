/**
 * M5 进化引擎路由 — 信任度/自主级别/技术债务查询与操作。
 */

import { anicError } from './envelope.ts';
import { join } from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import {
  buildTrustScores,
  recommendBand,
  type AutonomyBand,
  type LedgerEntryForTrust,
} from '../evolution/trustModel.ts';
import {
  checkBreakers,
  decideAction,
  downgradeBand,
  type BreakerInput,
} from '../evolution/autonomyGovernor.ts';
import { generateTechDebt, type EvalResult } from '../evolution/patchEngine.ts';
import { runAutonomyFallback } from '../evolution/autonomyActions.ts';
import { listTechDebt, markTechDebtConsumed } from '../evolution/techDebtQueue.ts';
// cycle-89：技术债**生命周期**分诊（stale 自动关闭）—— 债务必须有终态，否则只增不减。
// cycle-108：分诊新增**评估维度**判据（doc 26 §3 B1）—— 维度债务的裁决者是评估报告本身；
// 无这份事实时旧行为不变（保持 unverifiable，不猜）。
import { triageTechDebt, applyTriage } from '../evolution/techDebtTriage.ts';
import { readDebtFacts } from '../evolution/debtFacts.ts';
import { analyzeSkillHealth } from '../runtime/continuousLearning.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import { newRequestId } from '../logger.ts';
import { resolveWorkspaceRoots } from '../snapshotRoute.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

function query(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v ?? undefined;
}

/** 注册进化引擎路由（信任分/自主级别/熔断/技术债务）。 */
export function registerEvolutionRoute(ctx: SnapshotCtx, send: SendFn): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws) return [];

  const disposers: Array<(() => void) | null> = [];
  const reg = (path: string, method: string, handler: (req: RouteReq, res: unknown) => void): void => {
    const d = ws.register({ kind: 'exact', path, handler: handler as (req: unknown, res: unknown) => void });
    disposers.push(typeof d === 'function' ? d : null);
  };

  // GET /anic/api/trust — 信任分（从账本条目构建）
  reg('/anic/api/trust', 'GET', (req: RouteReq, res: unknown) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const entriesRaw = query(url, 'entries');
    let entries: LedgerEntryForTrust[] = [];
    if (entriesRaw) {
      try { entries = JSON.parse(entriesRaw) as LedgerEntryForTrust[]; } catch { /* empty */ }
    }
    const scores = buildTrustScores(entries);
    const result = [...scores.values()];
    send(res, 200, { trustScores: result, count: result.length });
  });

  // GET /anic/api/autonomy — 自主级别推荐
  reg('/anic/api/autonomy', 'GET', (req: RouteReq, res: unknown) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const bandRaw = query(url, 'band') ?? 'L2';
    const band: AutonomyBand = /^L[1-4]$/.test(bandRaw) ? (bandRaw as AutonomyBand) : 'L2';
    const trustScore = parseInt(query(url, 'trust') ?? '50', 10);
    const recommended = recommendBand(band, trustScore);
    send(res, 200, { current: band, trustScore, recommended });
  });

  // POST /anic/api/breakers — 熔断检查
  reg('/anic/api/breakers', 'POST', (req: RouteReq, res: unknown) => {
    void readBody(req).then((parsed) => {
    const body: BreakerInput = {
      consecutiveFixFails: Number(parsed.consecutiveFixFails ?? 0),
      hasDoubt: Boolean(parsed.hasDoubt),
      userDataUnisolated: Boolean(parsed.userDataUnisolated),
      destructiveNoRollback: Boolean(parsed.destructiveNoRollback),
      perfUnrecovered: Boolean(parsed.perfUnrecovered),
      humanRequestsL3: Boolean(parsed.humanRequestsL3),
      unattendedHours: Number(parsed.unattendedHours ?? 0),
      contextUsagePercent: Number(parsed.contextUsagePercent ?? 0),
      totalRetries: Number(parsed.totalRetries ?? 0),
      totalBreakerTrips: Number(parsed.totalBreakerTrips ?? 0),
    };
    const breakers = checkBreakers(body);
    const bandRaw = query(new URL(req.url ?? '', 'http://localhost'), 'band') ?? 'L2';
    const band: AutonomyBand = /^L[1-4]$/.test(bandRaw) ? (bandRaw as AutonomyBand) : 'L2';
    const action = decideAction(band, breakers);
    const downgraded = action === 'downgrade' ? downgradeBand(band) : band;
    send(res, 200, { breakers, action, downgradedBand: downgraded });
    });
  });

  // GET /anic/api/tech-debt/list — 列出 .cycles/tech-debt/ 全部提案（G-C3 消费侧读面）。
  // 读面用独立子路径而非与 POST 生成面共用 /anic/api/tech-debt：webServer 的 exact
  // 表对同 path 双注册（GET+POST 各一条）的覆盖语义未在官方文档钉死，分路径零歧义。
  // open = 未消费提案（人/上游 agent 执行修复的工作队列）；
  // resolved = 已消费（带 consumedAt/consumedBy 审计字段）；
  // skipped = 非 TechDebtEntry 形态文件（fix-loop 数组已展开，自由形态如实跳过）。
  reg('/anic/api/tech-debt/list', 'GET', (req: RouteReq, res: unknown) => {
    let root: string | null = null;
    try { root = resolveWorkspaceRoots(ctx, req); } catch { root = null; }
    if (!root) {
      send(res, 500, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable'));
      return;
    }
    const listing = listTechDebt(join(root, '.cycles'));
    send(res, 200, {
      open: listing.open,
      openCount: listing.open.length,
      resolvedCount: listing.resolved.length,
      skipped: listing.skipped,
    });
  });

  // POST /anic/api/tech-debt — 从评估结果生成技术债务（生成侧，既有语义）
  reg('/anic/api/tech-debt', 'POST', (req: RouteReq, res: unknown) => {
    void readBody(req).then((parsed) => {
    const results = Array.isArray(parsed.results) ? (parsed.results as EvalResult[]) : [];
    const entries = generateTechDebt(results);
    send(res, 200, { techDebt: entries, count: entries.length });
    });
  });

  // POST /anic/api/tech-debt/triage — 技术债**分诊**：按当前健康读数裁决每条提案。
  //
  // 为什么需要这个端点（cycle-88 根因分析）：health-* 提案由每日评估自动生成，
  // 问题修掉后**永不关闭** —— 于是同一条「gate-check 成功率 63%」在 8 个日期各挂一条，
  // 面板看起来「问题很多」，而其中大部分早已不成立。分诊给每条提案一个**终态**：
  // stale（条件不复现 → 自动关闭，带证据）/ reproduced（复现 → 保留）/
  // unverifiable（机器无法判定 → 保留待人工）。
  //
  // 边界（R-31）：本端点**只做记账**，不执行任何修复。机器能裁决的是
  // 「测量条件是否复现」（可复算事实），不能裁决「产品上该不该修」（人的判断）。
  reg('/anic/api/tech-debt/triage', 'POST', (req: RouteReq, res: unknown) => {
    void readBody(req).then((parsed) => {
    let root: string | null = null;
    try { root = resolveWorkspaceRoots(ctx, req); } catch { root = null; }
    if (!root) {
      send(res, 500, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable'));
      return;
    }
    const cyclesDir = join(root, '.cycles');
    const listing = listTechDebt(cyclesDir);
    const trackerState = loadFlowTracker(cyclesDir);
    const health = analyzeSkillHealth(trackerState);
    // cycle-108：读当前评估事实（最新活跃循环的报告 + 账本门裁决）。读不到 ⇒ 维度债务
    // 仍 unverifiable，旧判据照常生效——事实缺失不得让分诊器"猜通过"。
    const facts = readDebtFacts(cyclesDir);
    const decisions = triageTechDebt(listing.open, health, facts);
    const apply = parsed.apply !== false; // 默认**执行**分诊（否则端点是空壳）
    const result = apply
      ? applyTriage(cyclesDir, decisions, typeof parsed.actor === 'string' ? parsed.actor : 'anic:tech-debt-triage')
      : { marked: 0, notFound: [], errors: [] };
    send(res, 200, {
      ok: true,
      applied: apply,
      total: decisions.length,
      marked: result.marked,
      errors: result.errors,
      // cycle-108：把"维度判据用了哪份事实"一并回给调用方——只说结论不说依据，
      // 复核者无法判断"这条关闭是不是读了另一轮的旧报告"。
      facts: {
        cycle: facts.cycle,
        reportPath: facts.reportPath,
        digest: facts.digest,
        dimensions: facts.dimensions,
        gates: facts.gates,
        gatesAllPass: facts.gatesAllPass,
      },
      decisions: decisions.map((d) => ({ id: d.id, verdict: d.verdict, evidence: d.evidence })),
      byVerdict: {
        stale: decisions.filter((d) => d.verdict === 'stale').length,
        reproduced: decisions.filter((d) => d.verdict === 'reproduced').length,
        unverifiable: decisions.filter((d) => d.verdict === 'unverifiable').length,
      },
    });
    });
  });

  // POST /anic/api/tech-debt/consume — 标记提案已消费（G-C3 消费侧写面）。
  // 语义：修复已由人/上游完成，这里只做记账（resolved=true + 审计字段）。
  // R-31 红线不破：本路由绝不执行修复，只记录消费事实。
  reg('/anic/api/tech-debt/consume', 'POST', (req: RouteReq, res: unknown) => {
    void readBody(req).then((parsed) => {
    let root: string | null = null;
    try { root = resolveWorkspaceRoots(ctx, req); } catch { root = null; }
    if (!root) {
      send(res, 500, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable'));
      return;
    }
    const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((v): v is string => typeof v === 'string') : [];
    const consumedBy = typeof parsed.consumedBy === 'string' && parsed.consumedBy.length > 0
      ? parsed.consumedBy.slice(0, 200)
      : 'unknown';
    if (ids.length === 0) {
      send(res, 400, anicError('ANIC_ROUTE_BAD_REQUEST', 'ids[] required (proposal ids to mark consumed)'));
      return;
    }
    const result = markTechDebtConsumed(join(root, '.cycles'), ids, consumedBy);
    send(res, 200, result);
    });
  });

  // POST /anic/autonomy/downgrade — 证据化自主级回退（R3 阶段 1 余量）。
  // 与 POST /anic/api/breakers 的纯决策视图不同：这是技能 cmdAutoFallback 的插件等价物，
  // 写入 config.yml + Post-Verify 回读 + 事故留痕（autonomyActions.ts）。
  // 拒绝（无熔断证据 / L1/L2 地板 / config 缺失）一律 200 + action 字段区分——
  // 调用本身被正确执行，结局是「维持」，不是 HTTP 层错误。
  reg('/anic/autonomy/downgrade', 'POST', (req: RouteReq, res: unknown) => {
    const requestId = newRequestId();
    let root: string | null = null;
    try { root = resolveWorkspaceRoots(ctx, req); } catch { root = null; }
    if (!root) {
      send(res, 500, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable'), requestId);
      return;
    }
    const result = runAutonomyFallback(root);
    send(res, 200, result, requestId);
  });

  return disposers;
}
