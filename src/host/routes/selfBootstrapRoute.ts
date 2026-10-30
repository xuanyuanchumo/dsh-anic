/**
 * Self-bootstrap routes — dsh-anic evaluates itself using the skill.
 * M7: self/evaluate + self/iterate + self/gate-check + self/status
 *
 * cycle-72 三处 P0 修复：
 *   - 前置守卫：缺 .cycles 前置时返回专用错误码，**不**折叠成 evalScore 0/FAIL
 *     （两轮自举恒 0 分的根因）；
 *   - 取证补齐：三个端点全部经 FlowTracker 记账（此前 grep startFlow 零命中）；
 *   - 三态裁决：区分「质量失败」与「根本没跑成」，后者不产 0 分 tech-debt 提案。
 *
 * 拆分（T3 250 行上限）：共享靶标解析/守卫 → selfBootstrapShared.ts；
 * 记账执行体 → selfBootstrapRunners.ts；iterate 端点 → selfBootstrapIterate.ts。
 * 本文件只负责注册与轻端点装配。
 */

import type { SnapshotCtx } from '../snapshotRoute.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import { loadBootstrapState, saveBootstrapState, initialBootstrapState, type BootstrapState } from '../selfBootstrap.ts';
import { collectProjectFacts } from '../runtime/bootstrapFacts.ts';
import { applyPhase } from '../runtime/bootstrapPhase.ts';
import { runEvalTracked, runGateTracked } from './selfBootstrapRunners.ts';
import { handleSelfIterate, ITERATE_GATE_ARGS } from './selfBootstrapIterate.ts';
import {
  type SendFn,
  resolveSelfTarget,
  guardPreconditions,
} from './selfBootstrapShared.ts';

/** gate-check 独立端点的参数（与 iterate 内的口径同一常量，避免两处分叉）。 */
const GATE_ENDPOINT_ARGS = ITERATE_GATE_ARGS;

/** 注册自举路由（evaluate/gate-check/iterate/status）。 */
export function registerSelfBootstrapRoutes(
  ctx: SnapshotCtx,
  send: SendFn,
): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws?.register) return [];

  const reg = (p: string, handler: (req: RouteReq, res: unknown) => void) => {
    const d = ws.register!({ kind: 'exact', path: p, handler: handler as (req: unknown, res: unknown) => void });
    return typeof d === 'function' ? d : null;
  };

  return [
    // POST /anic/self/evaluate — run eval-runner on dsh-anic itself
    reg('/anic/self/evaluate', (_req, res) => {
      const target = resolveSelfTarget(ctx, send, res);
      if (!target) return;
      if (!guardPreconditions(target, send, res)) return;

      const state = loadBootstrapState(target.cyclesDir);
      const { result, flowId, score, outcome, phase } = runEvalTracked(target, state);

      send(res, 200, {
        exitCode: result.exitCode,
        score,
        // cycle-72 三态：state 区分 'failed'（质量未过）与 'not-run'（脚本没跑成），
        // reason 只在 not-run 时出现。可观测面上两者必须可分开——这是验收面。
        outcome,
        flowId,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        status: phase.state.status,
        rejected: phase.rejected,
      });
    }),

    // POST /anic/self/gate-check — run gate-check on dsh-anic itself
    reg('/anic/self/gate-check', (_req, res) => {
      const target = resolveSelfTarget(ctx, send, res);
      if (!target) return;
      if (!guardPreconditions(target, send, res)) return;

      const { result, flowId, verdict, outcome } = runGateTracked(target, GATE_ENDPOINT_ARGS);
      const state = loadBootstrapState(target.cyclesDir);
      const phase = applyPhase(target.cyclesDir, state, 'eval-done', { lastGateVerdict: verdict });

      send(res, 200, {
        exitCode: result.exitCode,
        verdict,
        outcome,
        flowId,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        timedOut: result.timedOut,
        status: phase.state.status,
        rejected: phase.rejected,
      });
    }),

    // POST /anic/self/iterate — full micro-iteration (eval→gate→tech-debt)
    reg('/anic/self/iterate', (req, res) => {
      void readBody(req).then((body) => {
        const maxRounds = typeof body.maxRounds === 'number' ? body.maxRounds : 3;

        const target = resolveSelfTarget(ctx, send, res);
        if (!target) return;
        if (!guardPreconditions(target, send, res)) return;

        handleSelfIterate(target, send, res, maxRounds);
      });
    }),

    // GET /anic/self/status — bootstrap state（含 cycle-89 facts/stale/restartCount）
    reg('/anic/self/status', (_req, res) => {
      const target = resolveSelfTarget(ctx, send, res);
      if (!target) return;
      const state = loadBootstrapState(target.cyclesDir);
      send(res, 200, state);
    }),

    // POST /anic/self/restart — 重置事实基线并重启自举（cycle-89）
    // 经状态机 `reset` 触发词回 IDLE（不丢 history），写入新 facts，restartCount++。
    reg('/anic/self/restart', (req, res) => {
      void readBody(req).then((body) => {
        const target = resolveSelfTarget(ctx, send, res);
        if (!target) return;
        if (!guardPreconditions(target, send, res)) return;

        const reason = typeof body['reason'] === 'string' ? body['reason'] : 'restart';
        const prev = loadBootstrapState(target.cyclesDir);
        // 经状态机 reset 回 IDLE（保留 history + maxRounds，不丢审计轨迹）
        const next: BootstrapState = { ...initialBootstrapState(prev.maxRounds), history: prev.history };
        // 采集当前项目事实并写入状态
        const facts = collectProjectFacts(target.roots);
        const prevRaw = prev as unknown as Record<string, unknown>;
        const restartCount = (typeof prevRaw['restartCount'] === 'number'
          ? prevRaw['restartCount'] as number : 0) + 1;
        const enriched = {
          ...next,
          facts,
          factsAt: new Date().toISOString(),
          stale: false,
          staleReasons: [],
          restartCount,
          restartReason: reason,
          restartedFrom: prev.status,
        };
        saveBootstrapState(target.cyclesDir, enriched);
        send(res, 200, { ok: true, from: prev.status, state: enriched });
      });
    }),
  ];
}
