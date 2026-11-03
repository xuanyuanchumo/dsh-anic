/**
 * 配置与路径的 HTTP 面（cycle-82 起；cycle-83 增两个写面）。
 *
 * ## 端点一览（全部挂在同一个 register 里，接线点只有一个）
 *
 * - `GET  /anic/api/config`           事实 + schema + 路径表 + 备份摘要
 * - `POST /anic/api/config`           `{patch, dryRun}` 改 config.yml
 * - `POST /anic/api/config/paths`     `{patch, dryRun}` 改 `.cycles/paths.json`（cycle-83）
 * - `POST /anic/api/config/rollback`  `{backup, dryRun}` 恢复到某份 .bak（cycle-83）
 *
 * ## 为什么路径改走**独立端点**而不是塞进 GET 的 probePath
 *
 * `?probePath=` 是「校验这一条路径能不能用」（只读一次问答）；改覆盖表是**写**，
 * 语义、鉴权意图与提示都不同。而 `POST /anic/api/config` 的 patch 键是**字段 id**
 * （`project.name` 这种），路径覆盖的键是**路径 id**（`evals` 这种）——两套命名空间
 * 塞进一个 body 会让「这个键到底改了配置还是改了路径」变成猜谜。
 *
 * ## 为什么注册保持在同一函数（Lead 接线点不变）
 *
 * `src/host/routes/index.ts` 由 Lead 维护（本任务禁改）。三条端点共用同一个
 * `getWorkspaceRoot` 与同一份 send，拆成三个 register 只会让 index.ts 多三行
 * 而收益为零——它们本来就是同一个域（「工作区配置与路径」）的三个动作。
 *
 * ## 响应体构造在 configRouteBody / configRouteEdits 两个文件里
 *
 * 本文件只做**路由骨架**（方法分派、错误包装、requestId）。响应体是纯函数、
 * 可单独测（contract 直接 import 它断言形状），拆开后两端都不越过 250 行。
 */
import { sendAnicError } from './envelope.ts';
import { createScoped, newRequestId } from '../logger.ts';
import { registerConfigRoutePaths, CONFIG_PATHS_ROUTE } from './configRoutePaths.ts';
import { registerConfigRouteRollback, CONFIG_ROLLBACK_ROUTE } from './configRouteRollback.ts';
import { buildGetBody, buildPostBody } from './configRouteBody.ts';
import { readBody, type RouteReq } from './routeContext.ts';

const log = createScoped('anic:route:config');

export const CONFIG_ROUTE = '/anic/api/config';

/** cycle-83 的两个新写面常量（**单一来源**在两个子文件里，这里只再导出）。 */
export { CONFIG_PATHS_ROUTE, CONFIG_ROLLBACK_ROUTE };

export { buildGetBody, buildPostBody, readConfigValues, rawHash } from './configRouteBody.ts';

interface SendFn { (res: unknown, status: number, body: unknown, requestId?: string): void }
/** 子路由文件复用的宿主 webServer 最小表面（只导出**类型**，实现仍在各文件）。 */
export interface WsLike {
  register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
}

export interface ConfigRouteDeps {
  send: SendFn;
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/**
 * 注册配置路由族。
 *
 * 三条端点共享同一个 workspace 解析与 send；每条各自 try/catch，因为
 * 「读配置失败」与「回滚失败」的错误码必须能分开定位（一条 500 说清哪个动作挂了）。
 */
export function registerConfigRoute(ctx: unknown, deps: ConfigRouteDeps): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: WsLike }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const disposers: Array<(() => void) | null> = [];

  const dispose = ws.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const method = (req as { method?: string }).method ?? 'GET';
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable', { requestId });
        return;
      }
      if (method === 'GET') {
        try {
          const url = (req as { url?: string }).url ?? '';
          const query = new URLSearchParams(url.split('?')[1] ?? '');
          deps.send(res, 200, buildGetBody(root, query.get('probePath')), requestId);
        } catch (e) {
          log.error(`config GET failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          sendAnicError(deps.send, res, 'ANIC_CONFIG_READ_FAILED', e instanceof Error ? e.message : String(e), { requestId });
        }
        return;
      }
      if (method !== 'POST') {
        sendAnicError(deps.send, res, 'ANIC_ROUTE_METHOD', 'GET or POST only', { requestId });
        return;
      }
      // 真实宿主 body 是流式的（P0-BODY）——必须 readBody，直接读 req.body 会静默丢参数。
      void readBody(req as RouteReq).then((body) => {
        try {
          const out = buildPostBody(root, body);
          if (out.status >= 400) log.warn(`config POST rejected: ${out.status}`, requestId);
          deps.send(res, out.status, out.payload, requestId);
        } catch (e) {
          log.error(`config POST failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          sendAnicError(deps.send, res, 'ANIC_CONFIG_WRITE_FAILED', e instanceof Error ? e.message : String(e), { requestId });
        }
      });
    },
  });
  if (typeof dispose === 'function') disposers.push(dispose);

  disposers.push(...registerConfigRoutePaths(ctx, deps));
  disposers.push(...registerConfigRouteRollback(ctx, deps));
  return disposers;
}
