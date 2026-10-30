/**
 * 跨工作区自举路由（cycle-89 · 「举他」）—— `POST /anic/self/bootstrap-other`。
 *
 * ## 端点契约
 *
 * ```
 * POST /anic/self/bootstrap-other
 * { "targetWorkspace": "D:/projects/other", "action": "evaluate" | "gate-check" | "init" }
 * ```
 *
 * 响应包含 **源零写入凭据**：`sourceFingerprint`（调用前）与 `sourceFingerprintAfter`
 * （调用后）—— 两者相同即证明源工作区未被触碰。**不**返回「我保证没写」这种自述。
 *
 * ## 为什么指纹只覆盖 `.cycles/**`
 *
 * 见 `runtime/crossBootstrap.ts` 的说明：整个工作区指纹会把 `node_modules/`
 * 算进来，既慢又会被无关改动污染断言。而跨项目自举**只可能**写 `.cycles/**`，
 * 覆盖它就足够精确地证明「源没被写」。
 *
 * ## 三个动作
 *
 * - `init`：在目标上初始化 `.cycles/` 骨架（不跑评估）。目标没装技能时也能跑
 *   —— 这正是「先把流程搭起来」的语义。
 * - `evaluate`：在目标上跑一次 eval-runner。
 * - `gate-check`：在目标上跑一次 gate-check。
 *
 * 默认 `evaluate`。
 */
import path from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { resolveWorkspaceRoots } from '../snapshotRoute.ts';
import { readBody, type RouteReq } from './routeContext.ts';
import type { SendFn } from './selfBootstrapShared.ts';
import {
  resolveCrossTarget,
  fingerprintCycles,
  sameFingerprint,
} from '../runtime/crossBootstrap.ts';
import { runEvalTracked, runGateTracked } from './selfBootstrapRunners.ts';
import { loadBootstrapState, saveBootstrapState, type BootstrapState } from '../selfBootstrap.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 动作白名单（闭合枚举——不接受任意字符串，避免拼错就静默走默认分支）。 */
const CROSS_ACTIONS = ['init', 'evaluate', 'gate-check'] as const;
type CrossAction = (typeof CROSS_ACTIONS)[number];

/** 注册跨项目自举路由。 */
export function registerCrossBootstrapRoute(
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
    reg('/anic/self/bootstrap-other', (req, res) => {
      void readBody(req).then((body) => {
        // 源工作区 = 宿主当前工作区（我们要证明「它没被写」）。
        let sourceRoot: string | null = null;
        try {
          sourceRoot = resolveWorkspaceRoots(ctx);
        } catch {
          sourceRoot = null;
        }
        const targetWorkspace = typeof body['targetWorkspace'] === 'string' ? body['targetWorkspace'] : '';
        const resolved = resolveCrossTarget(targetWorkspace, sourceRoot);
        if (!resolved.ok) {
          // 400/404/412 三选一由 failure.error 决定：**语义不同，修复动作也不同**。
          const code = resolved.failure.error === 'ANIC_CROSS_TARGET_MISSING' ? 404
            : resolved.failure.error === 'ANIC_CROSS_NO_SKILL' ? 412
              : 400;
          send(res, code, { error: resolved.failure });
          return;
        }
        const target = resolved.target;
        const actionRaw = typeof body['action'] === 'string' ? body['action'] : 'evaluate';
        const action = (CROSS_ACTIONS as readonly string[]).includes(actionRaw)
          ? actionRaw as CrossAction
          : 'evaluate';

        // 源指纹（调用前）—— 断言凭据的「前」。
        const sourceCyclesDir = sourceRoot ? path.join(sourceRoot, '.cycles') : null;
        const before = sourceCyclesDir ? fingerprintCycles(sourceCyclesDir, sourceRoot ?? undefined) : null;

        if (action === 'init') {
          // 初始化目标骨架：只建目录，不写内容。
          if (!existsSync(target.targetCyclesDir)) {
            mkdirSync(target.targetCyclesDir, { recursive: true });
          }
          const after = sourceCyclesDir ? fingerprintCycles(sourceCyclesDir, sourceRoot ?? undefined) : null;
          send(res, 200, {
            ok: true,
            action,
            target: { root: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsSource: target.scriptsSource },
            sourceUnchanged: before !== null && after !== null ? sameFingerprint(before, after) : null,
            sourceFingerprint: before,
            sourceFingerprintAfter: after,
          });
          return;
        }

        // 目标 `.cycles` 必须已存在 —— 评估脚本要求工作区已初始化。
        // 缺失时给**可执行**建议，而不是含糊的失败。
        if (!existsSync(target.targetCyclesDir)) {
          send(res, 412, {
            error: {
              code: 'ANIC_CROSS_TARGET_NOT_INITIALIZED',
              message: `target workspace has no .cycles/: ${target.targetRoot}`,
              remedy: `先对目标执行 action:"init"（POST /anic/self/bootstrap-other），或在目标项目运行 init-workflow`,
            },
          });
          return;
        }

        const trackTarget = { roots: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsDir: target.scriptsDir };
        const state = loadBootstrapState(target.targetCyclesDir);

        if (action === 'evaluate') {
          const { result, flowId, score, outcome, phase } = runEvalTracked(trackTarget, state);
          saveBootstrapState(target.targetCyclesDir, phase.state);
          const after = sourceCyclesDir ? fingerprintCycles(sourceCyclesDir, sourceRoot ?? undefined) : null;
          send(res, 200, {
            ok: true,
            action,
            target: { root: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsSource: target.scriptsSource },
            flowId,
            score,
            outcome,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, 4000),
            stderr: result.stderr.slice(0, 2000),
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            status: phase.state.status,
            sourceUnchanged: before !== null && after !== null ? sameFingerprint(before, after) : null,
            sourceFingerprint: before,
            sourceFingerprintAfter: after,
          });
          return;
        }

        // gate-check
        const { result, flowId, verdict, outcome } = runGateTracked(trackTarget, ['--gate', 'all', '--quality', '--record']);
        saveBootstrapState(target.targetCyclesDir, {
          ...state,
          lastGateVerdict: verdict,
          history: [...state.history, {
            round: state.round,
            evalScore: state.lastEvalScore,
            gateVerdict: verdict,
            fixApplied: null,
            timestamp: new Date().toISOString(),
          }],
        } as BootstrapState);
        const after = sourceCyclesDir ? fingerprintCycles(sourceCyclesDir, sourceRoot ?? undefined) : null;
        send(res, 200, {
          ok: true,
          action,
          target: { root: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsSource: target.scriptsSource },
          flowId,
          verdict,
          outcome,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 4000),
          stderr: result.stderr.slice(0, 2000),
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          sourceUnchanged: before !== null && after !== null ? sameFingerprint(before, after) : null,
          sourceFingerprint: before,
          sourceFingerprintAfter: after,
        });
      });
    }),
  ];
}
