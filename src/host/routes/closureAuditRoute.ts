/**
 * 闭环体检路由：注册↔生产↔消费 三态矩阵的 HTTP 只读查询面（cycle-72 T-7207）。
 *
 * GET /anic/api/closure-audit[?workspace=<abs>]
 *   → 200 { generatedAt, totals, clusters, unconsumed, ghost, notes, scannedFiles, workspace, scanTarget, requestId }
 *   → 500 { error: 'PLUGIN_ROOT_UNRESOLVED' }（根未解析时响亮失败，不审计错误目录）
 *
 * 口径（与前端分区、契约测试同源，杜绝「声明与实现漂移」）：
 *   - 体检目标是**插件自身**（工具/词表/路由三族的定义都在插件源码里）。
 *     workspace 参数只用于回显与「当前工作区」语义对齐，不改变扫描根——
 *     否则客户端面板会得到一份与仓库真相对不上的清单。
 *   - 只读：不写工作区、不改源码（R-31 纪律）。
 *   - 响应体不含绝对本地路径（rootDir 不出去），客户端投影见 toClosureView。
 *
 * 复用：HTTP 查询面与面板数据面共用 registryClosure 的同一份扫描实现
 * （单一实现纪律 G-SINGLE——面板与契约测试不得各写一套扫描器）。
 */
import { resolvePluginRoot } from '../pluginRoot.ts';
import { runClosureAudit, toClosureView, assertClustersPresent } from '../closureAudit/registryClosure.ts';
import { createScoped } from '../logger.ts';

const log = createScoped('closureAudit');

type Req = { url?: string };
type Res = unknown;

/** 提取查询串里的 workspace（仅用于回显；缺失/非法 → null）。 */
function workspaceOf(url: string | undefined): string | null {
  if (typeof url !== 'string') return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const ws = params.get('workspace');
  return ws !== null && ws.length > 0 ? ws : null;
}

export interface ClosureAuditRouteDeps {
  /** 发送函数（routeContext.makeSend 注入；桩宿主可用最小实现）。 */
  send: (res: Res, status: number, body: unknown, requestId?: string) => void;
  /** 插件根解析器（默认 resolvePluginRoot；测试可注入夹具根）。 */
  resolveRoot?: () => string;
}

/** 注册闭环体检路由（返回 disposer 数组，与既有路由注册形态一致）。 */
export function registerClosureAuditRoute(
  c: { webServer?: { register(opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) | void } },
  deps: ClosureAuditRouteDeps,
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  if (!c.webServer || typeof c.webServer.register !== 'function') return disposers;

  const d = c.webServer.register({
    kind: 'exact',
    path: '/anic/api/closure-audit',
    handler: (req: unknown, res: unknown) => {
      const url = (req as Req | undefined)?.url;
      const requestId = 'closure-' + String(Date.now());
      const resolveRoot = deps.resolveRoot ?? resolvePluginRoot;
      const rootDir = resolveRoot();
      if (rootDir === '') {
        // 根未解析（异常安装形态）——响亮失败，不返回错误目录的结论
        deps.send(res, 500, {
          error: 'PLUGIN_ROOT_UNRESOLVED',
          message: 'dsh-anic plugin root not found (marker package.json missing)',
          requestId,
        }, requestId);
        return;
      }
      try {
        const summary = runClosureAudit(rootDir);
        assertClustersPresent(summary.clusters);
        const view = toClosureView(summary);
        deps.send(res, 200, {
          ...view,
          scannedFiles: summary.scannedFiles,
          // 体检根语义：扫描始终针对插件自身；本字段仅回显客户端声明的工作区。
          workspace: workspaceOf(url),
          scanTarget: 'plugin',
          requestId,
        }, requestId);
      } catch (e) {
        // 扫描失败（读盘异常/格式漂移）——响亮失败，不返回半截清单
        const message = e instanceof Error ? e.message : String(e);
        log.warn('closure audit failed: ' + message);
        deps.send(res, 500, { error: 'CLOSURE_AUDIT_FAILED', message, requestId }, requestId);
      }
    },
  });
  if (typeof d === 'function') disposers.push(d);
  return disposers;
}
