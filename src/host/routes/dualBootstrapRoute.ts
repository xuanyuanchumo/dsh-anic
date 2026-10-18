/**
 * 双向自举路由：插件自举 + 技能自举 + 跨向提案。
 * POST /anic/self/dual-evaluate   — 同时评估插件和技能
 * POST /anic/self/dual-advance    — 推进一轮双向自举
 * GET  /anic/self/dual-status     — 查看双向自举状态
 *
 * getWorkspaceRoot(req)（cycle-22）：X-ANIC-Workspace 头参与解析（多会话纠偏）——
 * dual-advance 是写侧路由（落 dual-bootstrap 状态）。
 */
import { join } from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { newRequestId } from '../logger.ts';
import {
  type DualBootstrapState,
  type BootstrapTarget,
  loadDualBootstrapState,
  evaluatePluginSelf,
  evaluateSkillSelf,
  advanceDualBootstrap,
} from '../dualBootstrap.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface RouteDeps {
  ctx: SnapshotCtx;
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；cycle-22 全路由带 req 统一）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
  pluginDir: string;
}

/** 注册双向自举路由（dual-evaluate/dual-advance/dual-status）。 */
export function registerDualBootstrapRoute(deps: RouteDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const ws = deps.ctx.webServer;
  if (!ws) return disposers;

  const reg = (method: string, path: string, handler: (req: unknown, res: unknown) => void): void => {
    const d = ws.register({ kind: 'exact', path, handler });
    if (typeof d === 'function') disposers.push(d);
    void method;
  };

  reg('POST', '/anic/self/dual-evaluate', (req, res) => {
    const requestId = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) { deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } }, requestId); return; }
    // P0-DIR-ROOT：根未解析时响亮失败——evaluatePluginSelf('') 会审计 cwd（错误目录）
    if (!deps.pluginDir) { deps.send(res, 500, { error: { code: 'ANIC_PLUGIN_ROOT_UNRESOLVED', message: 'dsh-anic plugin root not found' } }, requestId); return; }
    const cyclesDir = join(root, '.cycles');
    const pluginEval = evaluatePluginSelf(deps.pluginDir);
    const skillEval = evaluateSkillSelf(cyclesDir);
    deps.send(res, 200, { plugin: pluginEval, skill: skillEval }, requestId);
  });

  reg('POST', '/anic/self/dual-advance', (req, res) => {
    const requestId = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) { deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } }, requestId); return; }
    if (!deps.pluginDir) { deps.send(res, 500, { error: { code: 'ANIC_PLUGIN_ROOT_UNRESOLVED', message: 'dsh-anic plugin root not found' } }, requestId); return; }
    const cyclesDir = join(root, '.cycles');
    const state = loadDualBootstrapState(cyclesDir);
    const pluginEval = evaluatePluginSelf(deps.pluginDir);
    const skillEval = evaluateSkillSelf(cyclesDir);
    const target: BootstrapTarget = pluginEval.score <= skillEval.score ? 'plugin' : 'skill';
    const evalScore = target === 'plugin' ? pluginEval.score : skillEval.score;
    const gateVerdict = evalScore >= 70 ? 'PASS' : evalScore >= 40 ? 'doubt' : 'FAIL';
    const newState = advanceDualBootstrap(cyclesDir, state, target, evalScore, gateVerdict);
    deps.send(res, 200, { newState, evaluated: target, evalScore, gateVerdict }, requestId);
  });

  reg('GET', '/anic/self/dual-status', (req, res) => {
    const requestId = newRequestId();
    const root = deps.getWorkspaceRoot(req);
    if (!root) { deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } }, requestId); return; }
    const cyclesDir = join(root, '.cycles');
    const state = loadDualBootstrapState(cyclesDir);
    deps.send(res, 200, state, requestId);
  });

  return disposers;
}
