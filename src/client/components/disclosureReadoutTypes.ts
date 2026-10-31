/**
 * 披露运行时读数的**客户端契约**（cycle-93）—— `GET /anic/api/disclosure` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级（响应字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import 宿主类型，一次字段改名就会让旧客户端
 * 整块崩掉（打包时类型擦除，编译期看不出来）。
 *
 * ⇒ 这里**手工声明可能缺字段**的形状，守卫只做最小准入。
 *
 * ## 这个读数解决什么问题
 *
 * cycle-92 修掉了披露自锁，但留下两个**无法查证**的项（O-92-02 / O-92-04）：
 * 「按需解锁是否真的生效」「`tools/change` 是否真的发出」。
 *
 * 根因不是"没做真机验证"，而是**状态没有出口**。
 * 本契约让面板能显示：几个 agent 被遮蔽、谁解锁了什么、事件发了几次。
 */

/** 单个 agent 的披露读数。 */
export interface AgentDisclosureJson {
  allToolCount?: number;
  loaderCount?: number;
  /** 当前被遮蔽的工具数（解锁后应减少）。 */
  denyCount?: number;
  /** 已解锁的工具 id（按解锁顺序）。 */
  unlocked?: string[];
  /** 当前是否还有生效的 restriction。 */
  restricted?: boolean;
}

/** `GET /anic/api/disclosure` 的响应。 */
export interface DisclosureReadoutJson {
  trackedAgents?: number;
  agents?: AgentDisclosureJson[];
  toolsChangeEmits?: number;
  fullyMaskedAgents?: number;
  generatedAt?: string;
  summary?: string;
}

/** 披露读数端点。 */
export const DISCLOSURE_URL = '/anic/api/disclosure';

/** 对象形守卫（独立实现，避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「trackedAgents 是数字」。
 *
 * 刻意**不**校验全部字段 —— 任何新增/缺失字段都不该让整块面板走失败行
 * （与 `flowMatrixTypes.isFlowMatrix` 同款最宽守卫）。
 */
export function isDisclosureReadout(v: unknown): v is DisclosureReadoutJson {
  if (!isObj(v)) return false;
  return typeof v['trackedAgents'] === 'number';
}

/** 已解锁工具总数（跨 agent 汇总；缺字段按 0）。 */
export function unlockedTotal(r: DisclosureReadoutJson | null | undefined): number {
  if (!r?.agents) return 0;
  return r.agents.reduce((n, a) => n + (a.unlocked?.length ?? 0), 0);
}

/**
 * 读数是否显示**解锁通道在工作**。
 *
 * ## 为什么不只是 `unlockedTotal > 0`
 *
 * `full` 模式下**没有 agent 被遮蔽** ⇒ 解锁通道**不需要**工作 ⇒
 * `unlockedTotal === 0` 是**正确**的，不是"通道坏了"。
 *
 * ⇒ 判据必须区分三态：
 * - 无 agent（full 模式）⇒ `'idle'`（不适用）；
 * - 有 agent 但无人解锁 ⇒ `'masked-only'`（遮蔽生效但还没人取 schema）；
 * - 有人解锁 ⇒ `'unlocking'`（通道工作）。
 */
export type UnlockChannelState = 'idle' | 'masked-only' | 'unlocking';

/** 解锁通道的**三态**判定（见上）。 */
export function unlockChannelState(r: DisclosureReadoutJson | null | undefined): UnlockChannelState {
  if (!r || (r.trackedAgents ?? 0) === 0) return 'idle';
  return unlockedTotal(r) > 0 ? 'unlocking' : 'masked-only';
}

/** 一行可读摘要（面板用；缺字段时给"未知"而非编数）。 */
export function disclosureLine(r: DisclosureReadoutJson | null | undefined): string {
  if (!r) return 'disclosure: unknown';
  const agents = r.trackedAgents ?? 0;
  if (agents === 0) return 'disclosure: mode=full (no masked agent)';
  const unlocked = unlockedTotal(r);
  const emits = r.toolsChangeEmits ?? 0;
  return `disclosure: agents=${String(agents)} · unlocked=${String(unlocked)} · tools/change=${String(emits)}`;
}
