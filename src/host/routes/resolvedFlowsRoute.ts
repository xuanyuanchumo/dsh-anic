/**
 * **开关解析态**路由（cycle-91）—— `GET /anic/api/flows/resolved`。
 *
 * ## 为什么要这个端点（实测缺陷）
 *
 * `resolveFlows` 的**三层合并**（user > workspace > deployment）此前**只在
 * 宿主侧**被读（`routeContext.ts` 的 `loadFlows()`），而客户端只读
 * **user 层**（`prefsDrawer.ts` 传的是 `renderPrefsDrawer({}, ...)`）。
 *
 * ⇒ 实测后果：
 * - 抽屉显示的 `enabled` **恒为 true**（workspace 层开关不在抽屉里）；
 * - 工作区 `.cycles/config.yml` 写 `flow.selfInit: false` ⇒ 抽屉显示
 *   「☑ 自举命令」⇒ 用户点「自举」⇒ 宿主返回 **403
 *   `ANIC_ROUTE_SELF_INIT_DISABLED`** ⇒ **界面与真相相反**；
 * - 三个 workspace 层开关（`flow.gateRecord` / `flow.budgetEnforce` /
 *   `flow.agentsOrchestration`）在界面上完全不可见。
 *
 * ## 端点契约
 *
 * ```
 * GET /anic/api/flows/resolved
 * → { flows: { [id]: { enabled, source } }, warnings: string[], userWritable: { [id]: boolean } }
 * ```
 *
 * ## 为什么**不复用** `GET /anic/flows/status`
 *
 * `/anic/flows/status` 是**流程状态机**的状态（IDLE/RUNNING/PASSED…），
 * 与**功能开关**是**正交**的两回事。它的 `descriptorView` 里没有
 * `resolveFlows` 的开关态 ⇒ 复用它会让两个语义混在一个响应里。
 *
 * ## 隔离纪律（fail-closed）
 *
 * 拿不到工作区 → 500，**绝不**返回全项目的开关状态。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFlows, isUserWritable, FLOW_IDS } from '../../shared/flows.ts';
import { loadWorkspaceConfig } from '../config.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface ServerContext {
  webServer?: {
    register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
  };
}

interface ResolvedRouteDeps {
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 开关解析态的响应体。 */
export interface ResolvedFlowsView {
  /** 每个开关的生效态与来源层。 */
  flows: Record<string, { enabled: boolean; source: string | null }>;
  /** 三层合并过程中的告警（未知键 / 非布尔值 / 层不支持）。 */
  warnings: string[];
  /** 每个开关在**用户层**是否可写（面板据此禁用 checkbox）。 */
  userWritable: Record<string, boolean>;
  /** 开关总数（客户端可据此校验是否漏渲染）。 */
  total: number;
}

/** 注册开关解析态路由。 */
export function registerResolvedFlowsRoute(
  ctx: ServerContext,
  send: SendFn,
  deps: ResolvedRouteDeps,
): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws?.register) return [];
  const disposers: Array<(() => void) | null> = [];
  // 用 `reg('<path>', handler)` 形态（与 flowsRoute.ts 同款）。
  //
  // ⚠️ 为什么不用 `ws.register!({ kind, path, handler })`：
  // 闭环体检的路由族扫描器认的「形态 A」正则是
  // `/(?:webServer\s*\.\s*)?register\s*\(\s*\{/` ——
  // **`register` 与 `(` 之间不允许有 `!`**（非空断言）。
  // 用 `ws.register!(` ⇒ 扫描器看不见这条注册 ⇒ 该路由被判「幽灵消费」
  // ⇒ 闭环体检整族红。
  // ⇒ 路由注册一律走 `reg(path, handler)` 形态，**与扫描器判据同源**。
  const reg = (path: string, handler: (req: unknown, res: unknown) => void): void => {
    const d = ws.register!({ kind: 'exact', path, handler });
    if (typeof d === 'function') disposers.push(d);
  };
  reg('/anic/api/flows/resolved', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
    const cyclesDir = join(root, '.cycles');
    // 工作区层：读 `.cycles/config.yml` 的 `anic.flow.*` 段（唯一入口 loadWorkspaceConfig）。
    const workspaceLayer = existsSync(cyclesDir)
      ? loadWorkspaceConfig(cyclesDir).values.flowOverrides
      : {};
    // deployment 层：宿主 bundle 配置（当前无注入点 ⇒ 空对象；见下方注释）。
    // ⚠️ 为什么现在传空对象而不是省略：`resolveFlows` 的层序是
    //   deployment → workspace → user，越具体越优先。省略 deployment 与
    //   传空对象**结果相同**，但传空对象让「这一层目前无来源」成为**显式事实**，
    //   而不是"忘了传"。将来接入部署层时，只需改这一处。
    const deploymentLayer: Record<string, unknown> = {};
    // user 层：客户端 localStorage，**服务端读不到** ⇒ 用户层由客户端本地合并。
    // 端点只返回**服务端能知道的层**（workspace + deployment）。
    const resolved = resolveFlows({ workspace: workspaceLayer, deployment: deploymentLayer });
    const flows: Record<string, { enabled: boolean; source: string | null }> = {};
    const userWritable: Record<string, boolean> = {};
    for (const id of FLOW_IDS) {
      const st = resolved.flows[id];
      flows[id] = { enabled: st?.enabled ?? true, source: st?.source ?? null };
      userWritable[id] = isUserWritable(id);
    }
    const view: ResolvedFlowsView = {
      flows,
      warnings: resolved.warnings,
      userWritable,
      total: FLOW_IDS.length,
    };
    send(res, 200, view);
  });
  return disposers;
}
