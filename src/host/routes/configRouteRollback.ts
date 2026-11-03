/**
 * `POST /anic/api/config/rollback` 的路由骨架（cycle-83）。
 *
 * ## 为什么回滚是独立端点而不是 config 的一个 patch 特例
 *
 * 回滚的输入是**备份文件名**，不是字段键值对；它一次改的字段数是未知的
 * （由备份与当前的差异决定）。塞进 `POST /config` 会让 patch 的形状守卫
 * 出现「有时是字段表、有时是文件名」的二义，而那正是最容易被误用的接口形态。
 *
 * ## dryRun 必须支持
 *
 * 回滚是覆盖面最大的写（一次可能改十几个字段）。没有 dryRun 就是让用户盲点，
 * 而「盲点之后发现回错了」的代价是又一轮回滚。语义与 config 端点一致：
 * dryRun 返回 diff 与 stats，真写返回 applied + 安全备份路径。
 *
 * ## 只接受文件名，不接受路径
 *
 * planRollback 里的判据：无 `..`、无路径分隔符、必须命中 `listBackups()` 清单
 * （前缀 + 目录内实际存在）。接受路径就等于开一个任意文件读取入口。
 */
import { sendAnicError } from './envelope.ts';
import { createScoped, newRequestId } from '../logger.ts';
import { buildRollbackPostBody } from './configRouteEdits.ts';
import type { ConfigRouteDeps, WsLike } from './configRoute.ts';
import { readBody, type RouteReq } from './routeContext.ts';

const log = createScoped('anic:route:config');

export const CONFIG_ROLLBACK_ROUTE = '/anic/api/config/rollback';

/** 注册回滚端点。GET 返回备份清单（含 diff 摘要）；POST 执行/预览回滚。 */
export function registerConfigRouteRollback(ctx: unknown, deps: ConfigRouteDeps): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: WsLike }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const dispose = ws.register({
    kind: 'exact',
    path: CONFIG_ROLLBACK_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const method = (req as { method?: string }).method ?? 'POST';
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable', { requestId });
        return;
      }
      if (method !== 'POST') {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_METHOD', 'POST only', { requestId });
        return;
      }
      void readBody(req as RouteReq).then((body) => {
        try {
          const out = buildRollbackPostBody(root, body);
          if (out.status >= 400) log.warn(`rollback POST rejected: ${out.status}`, requestId);
          deps.send(res, out.status, out.payload, requestId);
        } catch (e) {
          log.error(`rollback POST failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          sendAnicError(deps.send, res, 'ANIC_CONFIG_WRITE_FAILED', `ROLLBACK_FAILED: ${e instanceof Error ? e.message : String(e)}`, { requestId });
        }
      });
    },
  });
  return typeof dispose === 'function' ? [dispose] : [];
}
