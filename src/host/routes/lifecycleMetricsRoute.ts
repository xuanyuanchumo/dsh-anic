/**
 * 生命周期指标路由（cycle-90 · 从 `flowsRoute.ts` 拆出，守 T3 ≤250 行 · cycle-91 修 counter 口径）。
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
 *
 * ## ⚠️ cycle-91 修正：`counter` 的口径错误（截断徽标永不出现）
 *
 * **实测缺陷**：本路由此前把 `counter` 硬传为 `flows.length`：
 *
 * ```ts
 * truncationInfo({ flows, counter: flows.length })   // ⇒ evicted 恒为 0
 * ```
 *
 * `truncationInfo` 的 `everWritten = max(counter, flows.length)` ⇒ 传入
 * `counter === flows.length` 时 `evicted` **恒为 0** ⇒ **截断徽标永远不出现**。
 * cycle-90 收口台账声称「截断检测接线完成」——**判据层与单元层都绿，
 * 但集成层断了**：单元测试直接调 `buildLifecycleMetrics(flows, [], truncationInfo(...))`
 * 手工传 `counter: 50`，**绕过了路由层**，所以这个缺陷从未被任何用例覆盖。
 *
 * 这正是「单元绿、集成断」的典型形态 ⇒ 本轮补**路由级**回归（读真实路由）。
 *
 * **修法（口径分层，两个 counter 各司其职）**：
 *
 * | 计数器 | 来源 | 语义 | 用在哪 |
 * |---|---|---|---|
 * | `globalCounter` | 热窗口文件的 `counter` | **全工作区**累计写入数 | `everWritten`（有多少条曾经写过） |
 * | `retained` | 工作区过滤后的条数 | **本工作区**当前保留数 | `retained`（现在看得到多少条） |
 *
 * `evicted = max(0, globalCounter - retained)`：全局写过多少、本工作区还剩多少。
 * 这个差值**近似**"本工作区被淘汰了多少"（多项目共用一个 tracker 文件时是
 * **上界**，不是精确值）——因此读数里必须标注口径，不能当成精确淘汰数。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllFlowRecords, loadFlowTracker } from '../runtime/flowTracker.ts';
import { HISTORY_FILE } from '../runtime/flowTrackerStore.ts';
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
    // cycle-91：读**全量样本**（append-only 历史 ∪ 热窗口）⇒ 统计口径不再
    // 被"最近 200 条"的滚动淘汰截断（治本，见 flowTrackerStore 头注）。
    const all = existsSync(cyclesDir) ? loadAllFlowRecords(cyclesDir) : [];
    // 按工作区过滤（与 matrix 路由同纪律）。
    const flows = filterByWorkspace(all, root);
    // 账本：**只读**该工作区的（账本是工作区事实）。
    const ledger = existsSync(cyclesDir) ? loadLedger(cyclesDir) : [];
    // cycle-91 修 counter 口径：全局累计写入数（不是过滤后的条数）。
    const globalCounter = existsSync(cyclesDir) ? loadFlowTracker(cyclesDir).counter : 0;
    // 样本完整性**证明**：历史层可用 ⇒ 曾写过的记录一条不缺。
    // （`loadAllFlowRecords` 合并了历史 ∪ 热窗口；只要历史文件在，样本就是全的。）
    const historyAvailable = existsSync(join(cyclesDir, HISTORY_FILE));
    const truncation = truncationInfo(
      { flows, counter: globalCounter },
      flows.length,
      undefined,
      historyAvailable,
    );
    send(res, 200, buildLifecycleMetrics(flows, ledger, truncation));
  });
  return disposers;
}
