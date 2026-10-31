/**
 * **披露运行时读数**路由（cycle-93）—— `GET /anic/api/disclosure`。
 *
 * ## 为什么需要这个端点（修 O-92-02 / O-92-04 的根本困难）
 *
 * cycle-92 修掉了披露自锁，但留下两个**无法查证**的项：
 * - O-92-02「按需解锁是否真的生效」；
 * - O-92-04「`tools/change` 是否真的发出」。
 *
 * 两者的共同根因**不是"没做真机验证"**，而是**披露状态没有任何出口**：
 * 状态存在内存里，只在 `log.info` 出现过一次；`P8` 探针只查**静态可激活性**。
 *
 * ⇒ 本端点把那部分状态做成**一问一答的读数**：
 * ```
 * GET /anic/api/disclosure
 * → { trackedAgents, agents: [{ denyCount, unlocked, restricted, … }],
 *     toolsChangeEmits, fullyMaskedAgents, generatedAt }
 * ```
 *
 * ## 它能回答什么 / 不能回答什么（诚实边界）
 *
 * | 问题 | 本端点 |
 * |---|---|
 * | 有几个 agent 处于 indexed 披露？ | ✅ |
 * | 每个 agent 当前遮蔽了多少工具？ | ✅ |
 * | 谁解锁了什么（按顺序）？ | ✅ |
 * | `tools/change` 发了几次？ | ✅ |
 * | **宿主的 `restrict` 真的按 deny 生效了吗？** | ❌ 需读宿主工具视图（A0′ 探针路径） |
 *
 * ⇒ 它把"完全不可查"提升为"**我们这侧完全可查**"，而不是把未验证项变成已验证项。
 *
 * ## 为什么不需要工作区参数
 *
 * 披露状态是**进程级**的（每个 agent 一份，与工作区无关）。
 * ⇒ 本端点是**唯一不需要 `getWorkspaceRoot` 的 anic 数据端点**：
 *   查证「插件当前处于什么披露状态」不该依赖"当前在哪个项目"。
 *
 * ## 隐私边界
 *
 * 响应**不含** agent 标识（会话 id / cwd / 用户信息），只有数量与工具 id。
 * ⇒ 多会话共存时不会从一个项目看到另一个项目的会话标识。
 */
import { buildDisclosureReadout, summarizeDisclosure, type DisclosureReadout } from '../runtime/disclosureReadout.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface ServerContext {
  webServer?: {
    register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
  };
}

/** 注册披露读数路由。 */
export function registerDisclosureRoute(
  ctx: ServerContext,
  send: SendFn,
): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws?.register) return [];
  const disposers: Array<(() => void) | null> = [];
  // 用 `reg('<path>', handler)` 形态（与其它路由同款）。
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
  reg('/anic/api/disclosure', (_req, res) => {
    const readout: DisclosureReadout = buildDisclosureReadout();
    send(res, 200, { ...readout, summary: summarizeDisclosure(readout) });
  });
  return disposers;
}
