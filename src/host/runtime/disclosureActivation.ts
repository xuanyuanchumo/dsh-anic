/**
 * 渐进式披露的**按需解锁**（cycle-92）—— 修「自锁」。
 *
 * ## 实测缺陷（cycle-91 审计与研究共同指出的 P0）
 *
 * indexed 模式的语义是：`restrict({ deny: [除 2 个加载器外的全部 21 个工具] })`
 * ⇒ 模型只看得见 `anic_tools_search` 与 `anic_tool_detail`。
 *
 * 设计意图是「模型先用 search/detail 取回 schema，再调用目标工具」。
 *
 * **但 `anic_tool_detail` 只返回 schema 文本，从不把目标工具重新变可见**
 * ⇒ 模型取回 schema 后**依然调不到**那个工具 ⇒ **21/23 个工具永久不可用**。
 *
 * 这不是"披露模式收益低"，而是**功能性丧失**：indexed 模式下插件几乎报废。
 *
 * ## 为什么「再施加一条更窄的 restriction」不行
 *
 * 宿主契约（`tools.md`）：**restriction 取交集**，且「链上任何一层拒绝即不可见」。
 * ⇒ 旧 restriction 仍在时，新增更窄的一条**不会解锁**任何东西（交集只会更小）。
 *
 * ⇒ 解锁的唯一正确做法是：**先调用旧 restriction 的 disposer 撤销它，
 *   再施加一条新的（deny 集合已缩减）**。
 *
 * ## 为什么用 `exec.agent` 定位状态
 *
 * 加载器是**全局注册**的，它的 `execute(args, exec)` 的 `exec` 带 `agent`
 * 字段（`ToolRunContext extends ToolExecution`；dsh-ops 的 discovery 正是用
 * `exec.agent === agent` 做归属校验）。
 *
 * ⇒ 加载器知道「是哪个 agent 在取 schema」，于是能只解锁**那个 agent** 的
 * restriction（不会顺手放宽别的 agent —— 那是跨会话越权）。
 *
 * ## 三条纪律
 *
 * 1. **只放宽、不收紧**：解锁只会把工具从 deny 集合里**移除**，从不新增；
 * 2. **失败不影响主路**：解锁失败 ⇒ 返回原因，**不抛**（detail 本身仍要成功返回
 *    schema —— schema 本身仍有价值，只是暂时还不能调用）；
 * 3. **`tools/change` 必发**：宿主契约明确「scoped restriction 变更」属于该事件
 *    的触发条件；不发 ⇒ 宿主下一次 prompt 装配可能沿用陈旧工具集。
 *
 * ## 边界
 *
 * 状态存在内存（`Map<agent, State>`）；agent 销毁时由 `agent/disposed` 清理
 * （不清理会随会话数线性增长 —— 长跑宿主上是真实泄漏）。
 */
import { createScoped } from '../logger.ts';
import { noteToolsChangeEmit } from './toolsChangeCounter.ts';
import {
  classifyDisclosureVerdict,
  expectedVisibleIds,
  recomputeDeny,
  type DisclosureVerdict,
} from './disclosureVerdict.ts';
// cycle-109 T3：纯 deny 重算已并入 disclosureVerdict.ts（与 expectedVisibleIds 同族）。
export { recomputeDeny } from './disclosureVerdict.ts';
// cycle-109 T3：宿主侧取证下移到 disclosureHostCapture.ts（沿「动作 / 观测」切）。
import {
  captureHostVisibility,
  unverifiedVisibility,
  type HostVisibility,
  type ScopedToolsCtx,
} from './disclosureHostCapture.ts';

export type { HostVisibility, ScopedToolsCtx } from './disclosureHostCapture.ts';
export { captureHostVisibility } from './disclosureHostCapture.ts';

const log = createScoped('anic:disclosure-activation');

/** 一个 agent 的披露状态。 */
export interface AgentDisclosureState {
  /** 全部已知工具 id（解锁时据此重算 deny）。 */
  allToolIds: readonly string[];
  /** 加载器 id（永不解锁 —— 它们是取回 schema 的通道）。 */
  loaderIds: readonly string[];
  /** 已被 `anic_tool_detail` 请求过的工具（累积）。 */
  unlocked: Set<string>;
  /** 当前生效的 deny 集合。 */
  deny: string[];
  /** 撤销当前 restriction 的 disposer。 */
  disposer: (() => void) | null;
  /**
   * cycle-109：**宿主侧**可见性裁决（旁路取证，不是前置条件）。
   * `unverified` = 宿主无 `schemas` / 无 scope / 抛错 —— 采不到不等于失败。
   */
  hostVerdict: DisclosureVerdict;
  /** 实测可见数（null = 采不到）。 */
  hostVisible: number | null;
  /** 该遮蔽却仍在（空 = 无越权泄漏）。 */
  hostLeaked: string[];
  /** 该可见却不见了（空 = 无遮蔽过头）。 */
  hostMissing: string[];
}

/** 解锁结果（供加载器把真实结果告诉模型）。 */
export interface UnlockOutcome {
  /** 是否**本次**新解锁（此前已解锁 ⇒ false，但仍算可调用）。 */
  newlyUnlocked: boolean;
  /** 该工具当前是否**可调用**（true = 模型下一步能看到它）。 */
  callable: boolean;
  /** 人类可读的原因（`callable=false` 时必填）。 */
  reason?: string;
}

/** 内存注册表：agent → 状态。 */
const states = new WeakMap<object, AgentDisclosureState>();

/** 记录一个 agent 的披露状态（由接线层在 restrict 成功后调用）。 */
export function rememberDisclosure(
  agent: object,
  state: Omit<AgentDisclosureState, 'unlocked' | keyof HostVisibility>,
): void {
  // 未传取证 ⇒ 诚实形态（未采到）。绝不把「没采」默认成 verified。
  states.set(agent, { ...unverifiedVisibility(), ...state, unlocked: new Set<string>() });
}

/** 读取状态（缺省 null —— 该 agent 未启用 indexed 披露）。 */
export function disclosureOf(agent: unknown): AgentDisclosureState | null {
  if (agent === null || agent === undefined || typeof agent !== 'object') return null;
  return states.get(agent) ?? null;
}

/**
 * 清掉**全部**披露状态（agent 销毁时调用，防长跑泄漏）。
 *
 * ## ⚠️ cycle-93 修正：这里必须**同时** untrack
 *
 * 此前的契约是「`forgetDisclosure` 清 WeakMap，`untrackAgent` 清 tracked 集合」
 * ——两个函数、两次调用，靠**调用方记得都调**。
 *
 * **实测缺陷**：接线层的 `agent/disposed` 恰好两个都调了，所以看不出问题；
 * 但任何**只调一个**的路径（单测、将来的新调用方、或早退分支）都会留下
 * `tracked` 里的幽灵条目 ⇒ `trackedAgents` 读数**虚高** ⇒ 披露读数**撒谎**。
 *
 * ⇒ 收敛为单一职责：**「销毁」= 全清**。`untrackAgent` 保留导出（幂等，
 *   接线层继续调也不会出错），但 `forgetDisclosure` 自己兜住。
 */
export function forgetDisclosure(agent: object): void {
  const st = states.get(agent);
  if (st?.disposer) {
    try { st.disposer(); } catch { /* 撤销失败不该阻断销毁 */ }
  }
  states.delete(agent);
  // 同源清理：读数按 tracked 遍历，漏清会让读数虚高。
  tracked.delete(agent);
}

/**
 * 解锁一个工具（仅对**该 agent**）。
 *
 * ## 执行顺序（不可颠倒）
 *
 * 1. 把工具加进 `unlocked`；
 * 2. 重算 deny；
 * 3. **先撤旧 restriction**（否则交集语义下新 restriction 无效）；
 * 4. 施加新 restriction；
 * 5. `emit('tools/change')`（宿主据此失效工具集缓存）。
 *
 * ## 失败回滚
 *
 * 第 4 步抛错 ⇒ 已撤销旧 restriction（工具**全部可见**）⇒ 这是
 * **放宽方向**的失败（模型看得更多，不是更少）⇒ 不致命。
 * 但状态要如实更新：`deny=[]` + `disposer=null`，并由返回值说明原因。
 *
 * @param agent 调用方 agent（来自 `exec.agent`）
 * @param toolName 要解锁的工具 id
 */
export function unlockTool(agent: unknown, toolName: string): UnlockOutcome {
  const st = disclosureOf(agent);
  if (st === null) {
    // 未启用 indexed 披露 ⇒ 全部工具本来就可见 ⇒ "已可调用"。
    return { newlyUnlocked: false, callable: true, reason: 'this agent is not in indexed mode (all tools already visible)' };
  }
  if (st.loaderIds.includes(toolName)) {
    return { newlyUnlocked: false, callable: true, reason: 'loader is always visible' };
  }
  if (!st.allToolIds.includes(toolName)) {
    return { newlyUnlocked: false, callable: false, reason: `unknown tool id: ${toolName}` };
  }
  const already = st.unlocked.has(toolName);
  // 旧 deny 长度必须在覆盖前取（否则日志恒等 N → N，读不出真实变化）。
  const beforeDenyCount = st.deny.length;
  st.unlocked.add(toolName);
  const nextDeny = recomputeDeny(st.allToolIds, st.loaderIds, st.unlocked);
  const scoped = (agent as { ctx?: ScopedToolsCtx } | null | undefined)?.ctx;
  const restrict = scoped?.tools?.restrict;
  if (typeof restrict !== 'function') {
    return { newlyUnlocked: !already, callable: true, reason: 'host has no scoped tools.restrict — restriction never applied, so the tool is already visible' };
  }
  // 先撤旧（交集语义下这是解锁的**前提**）。
  if (st.disposer !== null) {
    try {
      st.disposer();
    } catch (e) {
      log.warn('old restriction disposer threw: ' + (e instanceof Error ? e.message : String(e)));
    }
    st.disposer = null;
  }
  try {
    const d = restrict({ deny: nextDeny });
    st.disposer = typeof d === 'function' ? d : null;
    st.deny = nextDeny;
    // cycle-109：deny 变了 ⇒ 旧的宿主取证已过期，重采一次（这正是「解锁是否真的
    // 让宿主多给了一个工具」的**唯一**直接证据；不重采则读数永远停在初态）。
    Object.assign(st, captureHostVisibility(scoped, agent, st.allToolIds, nextDeny));
  } catch (e) {
    // 撤销成功、施加失败 ⇒ 当前**无 restriction** ⇒ 全部工具可见（放宽方向）。
    st.deny = [];
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('re-restrict threw after lifting old one (all tools now visible): ' + msg);
    return { newlyUnlocked: !already, callable: true, reason: 'restriction lifted but re-apply failed (all tools visible): ' + msg };
  }
  // 宿主契约：scoped restriction 变更属于 `tools/change` 的触发条件。
  try {
    scoped?.emit?.('tools/change');
    noteToolsChangeEmit();
  } catch (e) {
    log.warn('emit tools/change threw: ' + (e instanceof Error ? e.message : String(e)));
  }
  log.info(`unlocked ${toolName} for agent (deny ${String(beforeDenyCount)} → ${String(nextDeny.length)}); `
    + `host=${st.hostVerdict}`
    + (st.hostVisible === null ? '' : ` visible=${String(st.hostVisible)}`)
    + (st.hostLeaked.length > 0 ? ` leaked=[${st.hostLeaked.join(', ')}]` : '')
    + (st.hostMissing.length > 0 ? ` missing=[${st.hostMissing.join(', ')}]` : ''));
  return { newlyUnlocked: !already, callable: true };
}

/** 单测用：重置注册表（WeakMap 无法枚举，故额外维护一个可清空的集合）。 */
const tracked = new Set<object>();

/** 记录 tracked（与 `rememberDisclosure` 配对；仅供测试与巡检计数）。 */
export function trackedAgentCount(): number {
  return tracked.size;
}

/** 记录一个 agent 供巡检计数（生产路径由接线层调用；WeakMap 不会阻止 GC）。 */
export function trackAgent(agent: object): void {
  tracked.add(agent);
}

/** 列出被跟踪的 agent（供读数模块遍历；读侧只依赖接口，不直接碰集合）。 */
export function listTrackedAgents(): object[] {
  return [...tracked];
}

/** 清理 tracked（销毁时调用）。 */
export function untrackAgent(agent: object): void {
  tracked.delete(agent);
}
