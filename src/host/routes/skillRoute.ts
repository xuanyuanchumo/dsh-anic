/**
 * Skill invocation routes — generic skill script calling + cross-project evaluation.
 * M8: skill/invoke + skill/list + evaluate + iterate
 */

import { sendAnicError, anicError } from './envelope.ts';
import { join } from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import { resolveWorkspaceRoots, sendJson } from '../snapshotRoute.ts';
import {
  isAllowedScript,
  listSkillScripts,
  resolveSkillScriptsDir,
  validateWorkspace,
  invokeSkillScript,
} from '../skillInvoker.ts';
import { parseEvalScore, parseGateVerdict } from '../runtime/scriptParsers.ts';
import { appendCrossProjectHistory } from '../crossProjectHistory.ts';
import { defaultSkillTimeout, resolveSkillInvokeTimeout, resolveBootstrapStepTimeout, skillTimeoutCap } from '../runtime/bootstrapBudget.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

/** 跨项目结果回写插件工作区自举历史（G-C5；失败响亮降级不阻断主结果）。 */
function syncCrossProjectHistory(
  ctx: SnapshotCtx,
  req: unknown,
  kind: 'evaluate' | 'iterate',
  targetWorkspace: string,
  evalScore: number | null,
  gateVerdict: string | null,
): { bootstrapSync: 'ok' } | { bootstrapSync: 'failed'; bootstrapSyncReason: string } {
  try {
    const ownRoots = resolveWorkspaceRoots(ctx, req);
    if (!ownRoots) return { bootstrapSync: 'failed', bootstrapSyncReason: 'own workspace unresolvable' };
    const r = appendCrossProjectHistory(join(ownRoots, '.cycles'), {
      timestamp: new Date().toISOString(),
      kind,
      workspace: targetWorkspace,
      evalScore,
      gateVerdict,
    });
    if (!r.ok) return { bootstrapSync: 'failed', bootstrapSyncReason: r.reason };
    return { bootstrapSync: 'ok' };
  } catch (e) {
    return { bootstrapSync: 'failed', bootstrapSyncReason: e instanceof Error ? e.message : String(e) };
  }
}

/** 注册技能调用路由（list/invoke/evaluate/iterate）。 */
export function registerSkillRoutes(
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
    // GET /anic/skill/list — list available skill scripts
    reg('/anic/skill/list', (_req, res) => {
      send(res, 200, { scripts: listSkillScripts() });
    }),

    // POST /anic/skill/invoke — invoke a skill script on a workspace
    reg('/anic/skill/invoke', (req, res) => {
      void readBody(req).then((body) => {
      const script = typeof body.script === 'string' ? body.script : '';
      const args: string[] = Array.isArray(body.args) ? (body.args as string[]) : [];
      const workspace = typeof body.workspace === 'string' ? body.workspace : resolveWorkspaceRoots(ctx, req);
      // cycle-99c：默认 30s 与上限同源 bootstrapBudget（旧字面量 120000 是第四份
      // 分叉默认——工具网关 60s / bootstrap 240s / HTTP 120s 各说各话）。
      // 同步入口 invokeSkillScript 内部还会再过 resolveSkillInvokeTimeout 收口。
      // cycle-112：默认/上限按脚本分档（auto-fix-loop 长跑预算；其余不变）。
      const timeout = typeof body.timeout === 'number' && body.timeout > 0
        ? resolveSkillInvokeTimeout(body.timeout, skillTimeoutCap(script))
        : resolveSkillInvokeTimeout(defaultSkillTimeout(script), skillTimeoutCap(script));
      if (!script || !isAllowedScript(script)) {
        sendAnicError(send, res, 'ANIC_SKILL_UNKNOWN_SCRIPT', `Unknown script: ${script}. Allowed: ${listSkillScripts().join(', ')}`);
        return;
      }

      const wsCheck = validateWorkspace(workspace);
      if (!wsCheck.ok) {
        sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', wsCheck.error ?? 'workspace validation failed');
        return;
      }

      const scriptsDir = resolveSkillScriptsDir(workspace);
      if (!scriptsDir) {
        sendAnicError(send, res, 'ANIC_SKILL_UNKNOWN_SCRIPT', 'skill scripts not found in workspace (run anic_install first)');
        return;
      }

      const result = invokeSkillScript(scriptsDir, script, args, workspace, timeout);
      send(res, 200, {
        script: result.script,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 8000),
        stderr: result.stderr.slice(0, 4000),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      });
    }),

    // POST /anic/evaluate — cross-project evaluation
    reg('/anic/evaluate', (req, res) => {
      void readBody(req).then((body) => {
      const workspace = typeof body.workspace === 'string' ? body.workspace : resolveWorkspaceRoots(ctx, req);
      const dimensions = typeof body.dimensions === 'string' ? body.dimensions : undefined;

      const wsCheck = validateWorkspace(workspace);
      if (!wsCheck.ok) { sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', wsCheck.error ?? 'workspace validation failed'); return; }

      const scriptsDir = resolveSkillScriptsDir(workspace);
      if (!scriptsDir) { sendAnicError(send, res, 'ANIC_SKILL_UNKNOWN_SCRIPT', 'skill scripts not found (run anic_install first)'); return; }

      const args = dimensions ? ['--dimensions', dimensions] : [];
      // cycle-99c：跨项目 eval-runner 预算同源自举每步预算（旧 60000 实测必超时）。
      const result = invokeSkillScript(scriptsDir, 'eval-runner', args, workspace, resolveBootstrapStepTimeout());

      // G-C5：跨项目评估摘要回写插件自身 self-bootstrap.json（增强非依赖）
      const sync = syncCrossProjectHistory(ctx, req, 'evaluate', workspace, parseEvalScore(result), null);

      send(res, 200, {
        workspace,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 8000),
        stderr: result.stderr.slice(0, 4000),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...sync,
      });
      });
    }),

    // POST /anic/iterate — cross-project iteration
    reg('/anic/iterate', (req, res) => {
      void readBody(req).then((body) => {
      const workspace = typeof body.workspace === 'string' ? body.workspace : resolveWorkspaceRoots(ctx, req);

      const wsCheck = validateWorkspace(workspace);
      if (!wsCheck.ok) { sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', wsCheck.error ?? 'workspace validation failed'); return; }

      const scriptsDir = resolveSkillScriptsDir(workspace);
      if (!scriptsDir) { sendAnicError(send, res, 'ANIC_SKILL_UNKNOWN_SCRIPT', 'skill scripts not found (run anic_install first)'); return; }

      // Run eval + gate（cycle-99c：两段预算同源自举每步预算）
      const evalResult = invokeSkillScript(scriptsDir, 'eval-runner', [], workspace, resolveBootstrapStepTimeout());
      const gateResult = invokeSkillScript(
        scriptsDir, 'gate-check',
        ['--gate', 'all', '--quality', '--record'],
        workspace, resolveBootstrapStepTimeout(),
      );

      // G-C5：跨项目迭代摘要回写（eval 分数 + 门禁裁决）
      const sync = syncCrossProjectHistory(
        ctx, req, 'iterate', workspace,
        parseEvalScore(evalResult),
        parseGateVerdict(gateResult),
      );

      send(res, 200, {
        workspace,
        eval: {
          exitCode: evalResult.exitCode,
          stdout: evalResult.stdout.slice(0, 4000),
          timedOut: evalResult.timedOut,
        },
        gate: {
          exitCode: gateResult.exitCode,
          stdout: gateResult.stdout.slice(0, 4000),
          timedOut: gateResult.timedOut,
        },
        ...sync,
      });
      });
    }),
  ];
}
