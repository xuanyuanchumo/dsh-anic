/**
 * 自举分区的**数据腿**（cycle-89）——GET 轮询 target + POST 重启动作。
 *
 * ## 为什么轮询而不是一次性拉取
 *
 * 自举是**长事务**：一次 eval-runner 要跑整条测试金字塔（实测 ~70s）。状态从
 * `EVALUATING` → `GATE_CHECKING` → …→ `CONVERGED/EXHAUSTED` 的变化恰好发生在这
 * 70s 里。一次性拉取会让面板显示"我点评估那一刻"的状态，用户永远看不到它在跑——
 * 那不是观测，是快照归档。
 *
 * ## 为什么 POST 不在 target 里
 *
 * `PanelFetchTarget` 的语义是幂等 GET（ETag/304/退避都建立在这个前提上）。
 * 重启是**变更操作**，必须显式点击触发、失败要可见、成功要立刻刷新事实。
 * 混进轮询 = 每 4 秒重启一次自举。
 *
 * ## 接口形状
 *
 * 服务端 `GET /anic/self/status` 直接回 BootstrapState（含 cycle-89 新字段
 * facts/stale/restartCount）。客户端守卫见 `bootstrapTypes.isBootstrap`。
 */
import type { PanelFetchTarget, FetchFailure } from '../../components/usePanelFetch.ts';
import type { PanelActions } from '../../components/panelActions.ts';
import type { BootstrapJson } from './bootstrapTypes.ts';
import { isBootstrap } from './bootstrapTypes.ts';

/** 自举状态端点（既有路由，cycle-89 起响应增 facts/stale/restartCount）。 */
export const BOOTSTRAP_STATUS_URL = '/anic/self/status';
/** 重启端点（cycle-89 新增）。 */
export const BOOTSTRAP_RESTART_URL = '/anic/self/restart';

/**
 * 构造自举状态的 4s 轮询 target。
 *
 * `fail` 收**原始 FetchFailure**（不是字符串）：三分类文案由 `classifyFailure`
 * 统一裁决——若这里先拼成字符串，HTTP 500 与网络异常在面板上会长得一样。
 */
export function bootstrapTarget(
  apply: (v: BootstrapJson) => void,
  fail: (f: FetchFailure) => void,
  recover: () => void,
): PanelFetchTarget {
  return {
    url: BOOTSTRAP_STATUS_URL,
    guard: isBootstrap,
    apply: (v) => { apply(v as BootstrapJson); },
    onFail: fail,
    onRecover: recover,
  };
}

/** 重启结果（网络/HTTP/业务拒绝都归一到一条形状，渲染层只需读 ok/error）。 */
export interface RestartResult { ok: boolean; error: string | null; from?: string }

/**
 * 重启自举（重置事实基线）。
 *
 * 三条失败语义必须分开（否则用户只能看到"失败"两个字）：
 *  - **网络**：宿主没起来 / 路由没注册；
 *  - **HTTP 非 2xx**：服务端拒绝（如 `.cycles/` 缺失 412、进行中 409）；
 *  - **业务 ok=false**：服务端明确说不行，带原因。
 *
 * @param workspace 目标工作区（省略 = 宿主当前工作区）。多项目面板必须传，
 *   否则会在别的项目的 `.cycles/` 上重启（这是「串味」最难排查的一种）。
 */
export async function restartBootstrap(workspace?: string, reason = 'panel: reset facts baseline'): Promise<RestartResult> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (typeof workspace === 'string' && workspace !== '') headers['X-ANIC-Workspace'] = workspace;
    const res = await fetch(BOOTSTRAP_RESTART_URL, { method: 'POST', headers, body: JSON.stringify({ reason }) });
    const json: unknown = await res.json().catch(() => null);
    const body = (typeof json === 'object' && json !== null ? json : {}) as { ok?: boolean; error?: string; from?: string };
    if (res.status >= 400 || body.ok === false) {
      return { ok: false, error: body.error ?? `HTTP ${String(res.status)}`, from: body.from };
    }
    return { ok: true, error: null, from: body.from };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 重启后立刻重拉一次状态（不靠下一个 4s 拍——用户点了按钮就期待马上看到变化）。 */
export async function refreshBootstrapFact(apply: (v: BootstrapJson) => void, workspace?: string): Promise<void> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (typeof workspace === 'string' && workspace !== '') headers['X-ANIC-Workspace'] = workspace;
    const res = await fetch(BOOTSTRAP_STATUS_URL, { headers });
    const json: unknown = await res.json().catch(() => null);
    if (isBootstrap(json)) apply(json);
  } catch { /* 拉不到就等轮询——不把"刷新失败"升级成"重启失败" */ }
}
