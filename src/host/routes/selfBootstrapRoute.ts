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
import { loadBootstrapState, saveBootstrapState, initialBootstrapState, BOOTSTRAP_SETTLED, type BootstrapState } from '../selfBootstrap.ts';
import {
  activeVsArchived,
  collectProjectFacts,
  diffFacts,
  factsDigest,
  readStoredFacts,
} from '../runtime/bootstrapFacts.ts';
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

/**
 * 存档时刻（`factsAt`，restart 写入的**装配层**字段，不属于状态机语义）。
 *
 * 为什么不在路由里 `as` 强转整个 state：状态文件是共享载荷，别的模块/旧版本写
 * 进去的键形状不保证。取不到就 `null`——面板据此显示「存档时刻不可用」，
 * 而不是拿一个假时间当证据。
 */
function archiveAtOf(state: unknown): string | null {
  if (state === null || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)['factsAt'];
  return typeof v === 'string' ? v : null;
}

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
    reg('/anic/self/evaluate', (req, res) => {
      const target = resolveSelfTarget(ctx, send, res, req);
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
    reg('/anic/self/gate-check', (req, res) => {
      const target = resolveSelfTarget(ctx, send, res, req);
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

        const target = resolveSelfTarget(ctx, send, res, req);
        if (!target) return;
        if (!guardPreconditions(target, send, res)) return;

        handleSelfIterate(target, send, res, maxRounds);
      });
    }),

    // GET /anic/self/status — bootstrap state + **当前项目事实**（cycle-95 O-94-04）
    //
    // 缺陷（本端点存在的唯一修复理由）：这里过去只 `loadBootstrapState` 然后 send，
    // 于是磁盘上 2026-10-28 的 `EXHAUSTED / evalScore 0 / 根因指向 cycle-83` 被当成
    // **当前事实**返回，而同一仓 10-30 的评估与门禁实际全 PASS。判断依据比现实更旧。
    //
    // 修法：每次请求内联采集当前事实并做陈旧判定（不落盘、不新增端点）——
    // 状态文件保留历史结论（这是审计轨迹），而 `facts/stale` 如实标注它是否还作数。
    // 复用 resolveSelfTarget 给出的 `roots`：workspace 解析全插件只有一条口径
    // （多会话/请求头纠偏都在那里），此处另算一遍会绕过它。
    reg('/anic/self/status', (req, res) => {
      const target = resolveSelfTarget(ctx, send, res, req);
      if (!target) return;
      const state = loadBootstrapState(target.cyclesDir);
      const current = collectProjectFacts(target.roots);
      // 存档侧事实：形状守卫读（旧状态文件没有 facts ⇒ null ⇒ 必判陈旧）。
      const diff = diffFacts(readStoredFacts(state), current);
      // 分列口径只从这里出（activeVsArchived 是唯一实现）；evaluationInput = 活跃面。
      const split = activeVsArchived(current);
      send(res, 200, {
        ...state,
        // 存档事实与当前事实**分开给**：面板要能说清"结论旧在哪"，
        // 合并成一个字段就再也分不出来了。
        facts: current,
        factsDigest: factsDigest(current),
        // 存档时刻（restart 写入的装配层字段；取不到就是 null，不猜）。
        factsAt: archiveAtOf(state),
        stale: diff.stale,
        staleReasons: diff.changed,
        // `BOOTSTRAP_SETTLED` 的**唯一真实消费面**（cycle-95 接线）。
        // 为什么需要在响应里给出：面板的重启按钮此前靠客户端自己维护一份"终态词表"，
        // 而终态集合的权威是宿主状态机（BOOTSTRAP_SETTLED）。两份词表一分叉，
        // 就会出现「宿主认为是中间态、面板认为可重启」的按钮——点下去打断正在跑的
        // 评估，正是面板注释里写死要避免的事故。给出 `settled` 让客户端**读权威**，
        // 而不是抄一份。
        settled: BOOTSTRAP_SETTLED.includes(state.status),
        // 归档是历史：评估/门禁/重启只应看 `evaluationInput`（= 活跃面）。
        activeVsArchived: split,
      });
    }),

    // POST /anic/self/restart — 重置事实基线并重启自举（cycle-89）
    // 经状态机 `reset` 触发词回 IDLE（不丢 history），写入新 facts，restartCount++。
    reg('/anic/self/restart', (req, res) => {
      void readBody(req).then((body) => {
        const target = resolveSelfTarget(ctx, send, res, req);
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
          // 摘要与分列一并存档：只存 facts 的话，下一次 status 仍然要自己重算，
          // 而"这次重启把哪些循环当成了评估输入"就再也无法核对（审计缺口）。
          factsDigest: factsDigest(facts),
          factsAt: new Date().toISOString(),
          // evaluationInput 只含**活跃**循环：归档不属于本轮评估的输入面。
          // 重启是"重新开跑"的起点，若这里把归档也算进去，同一个缺陷会从写侧复发。
          evaluationInput: activeVsArchived(facts).evaluationInput,
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
