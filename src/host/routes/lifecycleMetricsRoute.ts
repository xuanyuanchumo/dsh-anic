/**
 * 生命周期指标路由（cycle-90 · 从 `flowsRoute.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 端点契约
 *
 * ```
 * GET /anic/api/flows/lifecycle
 * → { window, attribution, gatePassRate, gateRepairTime, duration, inequality }
 * ```
 *
 * 三个数学模型（KM 生存分析 / EWMA 控制图 / 分位数+Gini）的读数在此汇合，
 * 且**诚实边界一起返回**（截断徽标 / 归属覆盖率 / 不可判定原因）。
 *
 * ## 隔离纪律（fail-closed）
 *
 * 拿不到工作区 → 500，**绝不**返回全项目的流；读数全部按工作区过滤后的
 * 记录计算（与 `/anic/api/flows/matrix` 同纪律）。
 */
import { existsSync } from 'node:fs';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import { loadLedger } from '../runtime/ledger.ts';
import { truncationInfo } from '../runtime/statVerdict.ts';
import { buildLifecycleMetrics } from '../runtime/lifecycleMetrics.ts';
import { filterByWorkspace } from '../flows/flowWorkspaceScope.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface ServerContext {
  webServer?: {
    register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
  };
}

interface MetricsRouteDeps {
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 注册生命周期指标路由。 */
export function registerLifecycleMetricsRoute(
  ctx: ServerContext,
  send: SendFn,
  deps: MetricsRouteDeps,
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
  // （客户端引用了未注册端点）⇒ 闭环体检整族红。
  // ⇒ 路由注册一律走 `reg(path, handler)` 形态，**与扫描器判据同源**。
  const reg = (path: string, handler: (req: unknown, res: unknown) => void): void => {
    const d = ws.register!({ kind: 'exact', path, handler });
    if (typeof d === 'function') disposers.push(d);
  };
  reg('/anic/api/flows/lifecycle', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
    const cyclesDir = `${root}/.cycles`;
    const all = existsSync(cyclesDir) ? loadFlowTracker(cyclesDir).flows : [];
    // 按工作区过滤（与 matrix 路由同纪律）。
    const flows = filterByWorkspace(all, root);
    // 账本：**只读**该工作区的（账本是工作区事实）。
    const ledger = existsSync(cyclesDir) ? loadLedger(cyclesDir) : [];
    send(res, 200, buildLifecycleMetrics(flows, ledger, truncationInfo({ flows, counter: flows.length })));
  });
  return disposers;
}
