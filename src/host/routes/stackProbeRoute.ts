/**
 * 栈探测路由（F3，M2-a）。
 *
 * GET /anic/api/stack-probe  探测工作区技术栈并返回建议配置
 */
import { type SnapshotCtx } from '../snapshotRoute.ts';
import { probeStack, configToYaml } from '../runtime/stackProbe.ts';

type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

interface RouteDeps {
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；cycle-22 全路由带 req 统一）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 注册栈探测路由（GET /anic/api/stack-probe）。 */
export function registerStackProbeRoute(ctx: unknown, deps: RouteDeps): (() => void) | null {
  const c = ctx as SnapshotCtx;
  if (!c.webServer || typeof c.webServer.register !== 'function') return null;
  const { send, getWorkspaceRoot } = deps;

  const d = c.webServer.register({ kind: 'exact', path: '/anic/api/stack-probe', handler: (req: unknown, res: unknown) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const result = probeStack(root);
    send(res, 200, { ...result, configYaml: configToYaml(result.config) });
  }});

  return typeof d === 'function' ? d : null;
}
