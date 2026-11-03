/**
 * `POST /anic/api/config/paths` 的路由骨架（cycle-83）。
 *
 * 单独成文件的理由：configRoute.ts 已承载 GET/POST 主端点（含骨架与错误码），
 * 再加两条端点就会越过 250 行；而这三条端点共享**同一份** deps 形状，
 * 拆开只需把 `WsLike` 与 `SendFn` 从主文件导出复用（不是复制）。
 *
 * 语义（与 config 端点逐条对齐）：
 * - `{patch, dryRun}`，dryRun 只算不写；
 * - patch 非对象 → 400 且**零写入**；
 * - 无工作区 → 404（绝不猜一个默认工作区写进去）；
 * - 真写的回读断言在 applyPathOverrides 内部（写后重新解析整份表）。
 */
import { sendAnicError } from './envelope.ts';
import { createScoped, newRequestId } from '../logger.ts';
import { buildPathPostBody } from './configRouteEdits.ts';
import type { ConfigRouteDeps, WsLike } from './configRoute.ts';
import { readBody, type RouteReq } from './routeContext.ts';

const log = createScoped('anic:route:config');

export const CONFIG_PATHS_ROUTE = '/anic/api/config/paths';

/** 注册路径覆盖端点（GET 返回当前表 + 覆盖视图；POST 写）。 */
export function registerConfigRoutePaths(ctx: unknown, deps: ConfigRouteDeps): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: WsLike }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const dispose = ws.register({
    kind: 'exact',
    path: CONFIG_PATHS_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const method = (req as { method?: string }).method ?? 'GET';
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable', { requestId });
        return;
      }
      // GET：只回覆盖视图（路径表本身在 /anic/api/config 的 paths 里——
      // 两处返回同一张表就等于两个真相源，客户端从哪读都可能读到旧的）。
      if (method === 'GET') {
        try {
          const out = buildPathPostBody(root, { patch: {}, dryRun: true });
          deps.send(res, 200, { ...(out.payload as Record<string, unknown>), readonly: true }, requestId);
        } catch (e) {
          log.error(`paths GET failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          sendAnicError(deps.send, res, 'ANIC_PATHS_READ_FAILED', e instanceof Error ? e.message : String(e), { requestId });
        }
        return;
      }
      if (method !== 'POST') {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_METHOD', 'GET or POST only', { requestId });
        return;
      }
      void readBody(req as RouteReq).then((body) => {
        try {
          const out = buildPathPostBody(root, body);
          if (out.status >= 400) log.warn(`paths POST rejected: ${out.status}`, requestId);
          deps.send(res, out.status, out.payload, requestId);
        } catch (e) {
          log.error(`paths POST failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          sendAnicError(deps.send, res, 'ANIC_PATHS_WRITE_FAILED', e instanceof Error ? e.message : String(e), { requestId });
        }
      });
    },
  });
  return typeof dispose === 'function' ? [dispose] : [];
}
