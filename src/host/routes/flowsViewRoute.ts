/**
 * FlowTracker 有界视图只读端点（cycle-101 · dsh-context 模式消费面）。
 *
 * ## 为什么单独成文件
 *
 * flowsRoute.ts 已 260+ 行（T3 ≤250 守触线）；本端点与「流程运行入口」
 * 职责不同（只读投影 vs 写副作用运行），一域一文件纪律要求独立。
 *
 * ## 为什么需要这个端点
 *
 * `projectFlowTrackerView` 产出的有界视图此前只有工具面（anic_status）可达 ——
 * 客户端面板要么拉整包工具结果（含无关的 skillIntegrity/health 树），要么
 * 直读 700KB 的 flow-tracker.json。本端点只出**六个读数 + 窗口明细**，
 * 面板消费成本从 O(全量) 降到 O(窗口)。
 *
 * ## 契约
 *
 * GET /anic/api/flows/view?limit=N（N ∈ [1,500]，缺省 50）
 *   → 200 { view, distribution, marker }
 *   → 404 ANIC_ROUTE_NO_WORKSPACE（统一信封，fail-closed）
 * 无 .cycles / 无 flow-tracker → 空视图（total 0，**如实**，不伪造历史）。
 */
import { existsSync } from 'node:fs';
import { sendAnicError } from './envelope.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import {
  projectFlowTrackerView,
  projectStatusDistribution,
  renderFlowViewMarker,
} from '../flowTrackerProjection.ts';

/** 注册依赖（与 flowsRoute 同形，便于同源注入）。 */
export interface FlowsViewRouteDeps {
  getWorkspaceRoot: (req?: unknown) => string | null;
  /** 宿主路由注册（flowsRoute 的 reg 帮助同款：注册后返回 disposer）。 */
  reg: (path: string, handler: (req: unknown, res: unknown) => void) => void;
}

type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

// 路由路径常量：readmeNumbers 契约用「常量引用形态」计数（const X_ROUTE + path: X_ROUTE），
// 与仓内既有约定一致；同时让路径字符串只出现一次（改路径不必全仓 grep）。
export const FLOWS_VIEW_ROUTE = '/anic/api/flows/view';

/** 注册 GET /anic/api/flows/view（调用方提供 reg + send + 工作区解析）。 */
export function registerFlowsViewRoute(send: SendFn, deps: FlowsViewRouteDeps): void {
  const reg = deps.reg; // 取出帮助函数：与仓内既有 reg(<path>, handler) 形态一致（扫描器可识别）
  reg(FLOWS_VIEW_ROUTE, (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) {
      sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request');
      return;
    }
    const cyclesDir = `${root}/.cycles`;
    // URL 解析：req 在桩宿主与真宿主都带 url 字段（真宿主为 IncomingMessage.url）
    const urlText = (req as { url?: string }).url ?? '/';
    const limitRaw = Number(new URL(urlText, 'http://x').searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const state = existsSync(cyclesDir) ? loadFlowTracker(cyclesDir) : { flows: [], counter: 0 };
    const view = projectFlowTrackerView(state, { limit });
    send(res, 200, {
      view,
      distribution: projectStatusDistribution(view),
      marker: renderFlowViewMarker(view),
    });
  });
}
