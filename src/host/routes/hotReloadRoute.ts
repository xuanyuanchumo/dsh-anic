/**
 * 热更新重载运维通道：`POST /anic/api/reload`（cycle-80 WS-1）。
 *
 * 为什么需要 HTTP 面（工具面已能重载）：重载是**运维动作**——CI/脚本在部署新 dist 后要能
 * 一句话触发，而不必进某个模型会话；也让「改完代码生效」在宿主外可被自动化。工具面与
 * 本路由共用 `reloadSelf` 同一实现（单一实现纪律，两套语义迟早漂移）。
 *
 * ## 状态码语义（与 `docs/agents/API参考-数据面.md` §6 的表**逐行一致**，测试断言同一张表）
 * | 码 | action | 含义 |
 * | 200 | scheduled   | 已受理并调度重载（重载本身异步，200 = 请求被接受） |
 * | 409 | unavailable | 当前 profile 无 hmr 服务（能力冲突；零写入，不假装成功） |
 * | 412 | refused     | 前置条件不成立：dist 已最新，或史账不可写（无审计证据则不重载） |
 * | 404 | —           | 解析不到工作区（与其余路由同口径） |
 * | 500 | —           | 重载编排抛错（响亮失败，不返回半截结论） |
 *
 * 注意：本路由**不**决定重载成败——宿主替换实例后由新实例的 finalizeInFlight 落定，
 * 证据在 `.cycles/reload-history.json`；这也是 200 而非 202 的原因（请求已受理，不是排队）。
 */
import { join } from 'node:path';
import { readBody, type RouteReq, type SendFn } from './routeContext.ts';
import { createScoped, newRequestId } from '../logger.ts';
import { reloadSelf, type ReloadResult } from '../runtime/hotReload.ts';
import { resolvePluginRoot } from '../pluginRoot.ts';

const log = createScoped('anic:reload');

/** 路由字面量（channelRegistry 声明与文档 docRef 都引用它）。 */
export const HOT_RELOAD_ROUTE = '/anic/api/reload';

/** action → HTTP 状态码（唯一映射表；文档与测试引用同一张）。 */
export const RELOAD_STATUS: Readonly<Record<ReloadResult['action'], number>> = {
  scheduled: 200,
  unavailable: 409,
  refused: 412,
};

export interface HotReloadRouteDeps {
  send: SendFn;
  /** 工作区解析（复用 routeContext 的既有实现，不新写一套）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
  /** 插件根解析器（默认 resolvePluginRoot；测试可注入夹具根）。 */
  resolveRoot?: () => string;
}

interface WebSlot {
  webServer?: {
    register(opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) | void;
  };
}

/** 注册热更新重载路由（返回 disposer 数组，与既有路由注册形态一致）。 */
export function registerHotReloadRoute(c: WebSlot, deps: HotReloadRouteDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const ws = c.webServer;
  if (!ws || typeof ws.register !== 'function') return disposers;

  const d = ws.register({
    kind: 'exact',
    path: HOT_RELOAD_ROUTE,
    handler: (req: unknown, res: unknown) => {
      const rid = newRequestId();
      const run = async (): Promise<void> => {
        const root = deps.getWorkspaceRoot(req);
        if (!root) {
          deps.send(res, 404, { error: 'no workspace' }, rid);
          return;
        }
        const body = await readBody((req ?? {}) as RouteReq);
        const rawReason = body.reason;
        const reason = typeof rawReason === 'string' && rawReason.trim() !== ''
          ? rawReason
          : 'POST /anic/api/reload (no reason supplied)';
        const requiredIds = Array.isArray(body.requiredIds)
          ? body.requiredIds.filter((x): x is string => typeof x === 'string')
          : undefined;
        const result = await reloadSelf(c, {
          cyclesDir: join(root, '.cycles'),
          pluginRoot: (deps.resolveRoot ?? resolvePluginRoot)(),
          reason,
          actor: 'http:POST /anic/api/reload',
          requiredIds,
          force: body.force === true,
        });
        deps.send(res, RELOAD_STATUS[result.action], { ...result, workspace: root, requestId: rid }, rid);
      };
      void run().catch((e: unknown) => {
        // 编排层抛错：响亮失败（500），不返回"看起来成功了"的半截结论。
        const message = e instanceof Error ? e.message : String(e);
        log.warn('reload route failed: ' + message);
        deps.send(res, 500, { error: 'RELOAD_FAILED', message, requestId: rid }, rid);
      });
    },
  });
  if (typeof d === 'function') disposers.push(d);
  return disposers;
}
