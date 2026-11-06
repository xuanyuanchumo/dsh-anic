/**
 * 工具面**按需加载接线**（cycle-74 T-7406 / T-7408）——把披露/激活接到 agent 生命周期。
 *
 * 前置已就绪：
 *   - A0′ **PASS**：scoped ctx 上 `restrict` 生效（真机，视图 -1、`get(name,agent)` 归 absent）；
 *   - **A3/A4/A6 PASS**（真机 21 工具）：19 个被遮、加载器 schema 不变、幂等；
 *   - 加载器工具已注册 ⇒ `activationReady` 可过。
 *
 * ## 为什么解析必须**下移到 per-agent**（cycle-74 实测修正）
 *
 * 初版在 `apply` 时解析一次工作区并据此全局接线。这是**错的**，两个理由：
 *   1. 本插件**单实例服务多工作区**：apply 时只能取「第一个」工作区，
 *      会把 A 项目的 `indexed` 误施加到 B 项目的 agent 上（越权改变他项目行为）；
 *   2. apply 时**可能尚无会话** ⇒ 解析失败 ⇒ indexed 永不激活 = **注册了但没人消费**。
 *
 * 正解：在每个 `agent/created` 事件里，用该 **agent 自己的**会话头
 * （`agent.session.header.cwd`，源码取证 dsh-session:1822 由 `meta.cwd` 写入）解析工作区，
 * 再按该工作区读配置。这样「谁的项目、谁的配置、谁的披露」三者对齐。
 *
 * 双保险（绝不半途遮蔽、绝不错配）：
 *   - full（默认）⇒ 不注册监听器（零行为变更）；
 *   - 任一步失败（无 cwd / 无配置 / 无索引 / 无 restrict / restrict 抛错）⇒ 该 agent 保持 full。
 */
import { createScoped } from './logger.ts';
import { planActivation, INDEX_LOADER_TOOLS } from './indexActivation.ts';
import { buildIndexSectionText, resolveDisclosureMode } from './toolDisclosure.ts';
import type { CapabilityIndexInjectable } from './capabilityIndex.ts';
import {
  captureHostVisibility,
  forgetDisclosure,
  rememberDisclosure,
  trackAgent,
  untrackAgent,
} from './runtime/disclosureActivation.ts';
import { noteToolsChangeEmit } from './runtime/disclosureReadout.ts';
import { describeHostVerdict, type DisclosureVerdict } from './runtime/disclosureVerdict.ts';

const log = createScoped('anic:tool-disclosure');

/**
 * 索引 section 的排序位（**必须**是有限数字，否则宿主抛错——cycle-74 实测）：
 * 官方 `systemPrompt.section()` 校验 `order` 为有限数（dsh-system-prompt 源码注释：
 * 「duplicates within one layer and non-finite orders throw」），且官方自身一律经
 * `getSectionOrder('KEY')` 从 `SECTION_ORDERS` 取值。
 *
 * 本插件取 4950：落在**工具区尾部**（TOOL_* 到 3000、MCP_SERVERS 3100）
 * 与 `TOOLS_SDK`(5000) 之间——因为本索引正是「替代常驻工具 schema」的东西，
 * 语义上应紧随工具定义之后、SDK 之前。**不**借用官方键名（那不是我们的语义）。
 */
const INDEX_SECTION_ORDER = 4950;

/** 接线所需的**scoped**宿主面（本地窄化，不引宿主包）。 */
interface ScopedCtx {
  tools?: {
    restrict?: (f: { deny: string[] }) => () => void;
    /** cycle-109：文档化读面（观察 scope 效果的唯一官方通道）。 */
    schemas?: (scope?: unknown) => Array<{ name?: unknown }>;
  };
  systemPrompt?: { section?: (s: { name: string; order: number; text: string }) => unknown };
}
interface DisclosureHost {
  on?: (name: string, handler: (payload: { agent?: unknown }) => void) => unknown;
}
/** agent 形状（本地窄化）：会话头 cwd 即该 agent 所属工作区。 */
interface AgentLike { ctx?: ScopedCtx; session?: { header?: { cwd?: string } } }

/** 单个 agent 的披露判定（由调用方按该 agent 所属工作区解析）。 */
export interface AgentDisclosure {
  mode: 'full' | 'indexed';
  index: CapabilityIndexInjectable | null;
}

/** 接线结果（供探针 / 日志如实上报「接没接、为什么」）。 */
export interface WiringOutcome {
  wired: boolean;
  reason: string;
  denyCount: number;
  /**
   * cycle-109：**宿主侧**裁决（`unverified` = 采不到；取证是旁路，
   * **绝不**因取证失败而改动 `wired` 语义——否则会出现「取证失败 ⇒ 回退 full」
   * 这种把观测故障升级成行为变更的恶性耦合）。
   */
  hostVerdict?: DisclosureVerdict;
  /** 实测可见数（null = 采不到）。 */
  hostVisible?: number | null;
}

/**
 * 从 agent 解析其所属工作区（会话头 `cwd`）。无 / 非字符串 ⇒ null（宁缺勿猜）。
 * 导出以便单测直接钉这条解析规则。
 */
export function rootOfAgent(agent: unknown): string | null {
  const cwd = (agent as AgentLike)?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/**
 * 为一个 agent scope 施加披露（注入索引 + 激活可见集）。返回结果；不抛。
 *
 * 失败一律**回落 full 语义**：restrict 未生效即未遮蔽，模型仍见全量（不是半遮蔽）。
 */
export function applyDisclosureToScope(
  scoped: ScopedCtx,
  index: CapabilityIndexInjectable | null,
  mode: 'full' | 'indexed',
  allToolIds: readonly string[],
  /** 该 scoped ctx 所属的 agent（cycle-92：按需解锁的归属依据）。 */
  agent?: unknown,
): WiringOutcome {
  if (mode !== 'indexed') return { wired: false, reason: 'mode=full (default, zero behavior change)', denyCount: 0 };
  if (!index) return { wired: false, reason: 'index artifact missing — stay full (no guessing)', denyCount: 0 };
  const plan = planActivation(mode, allToolIds, allToolIds);
  if (!plan) {
    return { wired: false, reason: 'activation blocked: 加载器（' + INDEX_LOADER_TOOLS.join('/') + '）未全部注册，切档将自锁', denyCount: 0 };
  }
  if (!scoped.tools?.restrict) return { wired: false, reason: 'host has no scoped tools.restrict (old generation/stub) — stay full', denyCount: 0 };
  // **原子性纪律**（cycle-74 实测教训）：**先**注入索引，**后**遮蔽工具。
  // 反序曾造成「restrict 成功、section 抛错」= 只遮蔽未注入索引——
  // 这是本设计明令禁止的半途落地（净收益归零且模型无检索通道），
  // 且当时的返回值 wired:false 与实际已遮蔽**不符**（谎报）。
  // 现在：任何一步失败都在遮蔽之前中止 ⇒ 要么两半都成，要么全不动。
  if (scoped.systemPrompt?.section) {
    try {
      scoped.systemPrompt.section({
        name: 'anic:capability-index',
        order: INDEX_SECTION_ORDER,
        text: buildIndexSectionText(index),
      });
    } catch (e) {
      return { wired: false, reason: 'index section threw (nothing restricted) — stay full: ' + (e instanceof Error ? e.message : String(e)), denyCount: 0 };
    }
  } else {
    // 无 systemPrompt 通道 ⇒ 注入不可能 ⇒ 绝不能遮蔽（否则模型无检索通道 = 自锁）
    return { wired: false, reason: 'host has no systemPrompt.section — cannot inject index, refuse to restrict (would self-lock)', denyCount: 0 };
  }
  try {
    const disposer = scoped.tools.restrict({ deny: plan.deny });
    // cycle-109：**施加完成后再取证**（顺序不可反：restrict 之前采到的是全量视图，
    // 那样裁决恒 partial）。取证失败只会得到 unverified，不影响 wired 语义。
    const host = captureHostVisibility(scoped, agent, allToolIds, plan.deny);
    // cycle-92：记录状态，供 `anic_tool_detail` **按需解锁**（只解锁该 agent）。
    // 修复前这里**丢弃 disposer** ⇒ 既无法解锁、也无法在 agent 销毁时撤销（遮蔽泄漏）。
    if (agent !== null && agent !== undefined && typeof agent === 'object') {
      rememberDisclosure(agent, {
        allToolIds,
        loaderIds: INDEX_LOADER_TOOLS,
        deny: plan.deny,
        disposer: typeof disposer === 'function' ? disposer : null,
        ...host,
      });
      trackAgent(agent);
    }
    // 宿主契约（tools.md）：scoped restriction 变更属于 `tools/change` 的触发条件；
    // 不发 ⇒ 宿主下一次 prompt 装配可能沿用陈旧工具集。
    try { (scoped as { emit?: (n: string) => unknown }).emit?.('tools/change'); noteToolsChangeEmit(); } catch { /* 老代宿主无 emit */ }
    return {
      wired: true,
      reason: 'indexed: injected index + restricted ' + String(plan.deny.length) + ' tools (unlockable via anic_tool_detail)',
      denyCount: plan.deny.length,
      hostVerdict: host.hostVerdict,
      hostVisible: host.hostVisible,
    };
  } catch (e) {
    // restrict 失败 ⇒ 未遮蔽（section 已注入但无害：索引在 full 模式下只是补充信息）。
    return { wired: false, reason: 'restrict threw (not restricted, index section only): ' + (e instanceof Error ? e.message : String(e)), denyCount: 0 };
  }
}

/**
 * 注册 agent 生命周期接线（`agent/created`）。
 *
 * **不注册**的条件：既非全局 indexed、又没有 per-agent 解析器 ⇒ 零行为变更、零开销。
 */
export function wireToolDisclosure(
  ctx: unknown,
  opts: {
    /** 全局默认模式（无 per-agent 解析器时使用）。 */
    mode: unknown;
    /** 全局索引（per-agent 解析器返回 null 时的兜底）。 */
    index: CapabilityIndexInjectable | null;
    allToolIds: readonly string[];
    /** 按 agent 解析其工作区对应的模式与索引（**推荐**；缺省则用全局 mode/index）。 */
    resolveForAgent?: (agent: unknown) => AgentDisclosure;
  },
): WiringOutcome {
  const globalMode = resolveDisclosureMode(opts.mode);
  const perAgent = typeof opts.resolveForAgent === 'function';
  if (globalMode !== 'indexed' && !perAgent) return { wired: false, reason: 'mode=full (default)', denyCount: 0 };
  const host = ctx as DisclosureHost;
  if (typeof host.on !== 'function') return { wired: false, reason: 'host has no ctx.on (stub/old generation) — stay full', denyCount: 0 };
  if (globalMode === 'indexed') {
    const plan = planActivation('indexed', opts.allToolIds, opts.allToolIds);
    if (!plan) return { wired: false, reason: 'activation blocked (loaders missing) — stay full', denyCount: 0 };
  }
  host.on('agent/created', (payload) => {
    const agent = payload?.agent;
    const scoped = (agent as AgentLike)?.ctx;
    if (!scoped) return;
    const d = opts.resolveForAgent
      ? opts.resolveForAgent(agent)
      : { mode: resolveDisclosureMode(opts.mode) as 'full' | 'indexed', index: opts.index };
    const out = applyDisclosureToScope(scoped, d.index, d.mode, opts.allToolIds, agent);
    // 取证结论必须**每次都出声**：`wired:true` 只说「调用没抛」，
    // 不说「宿主真的少给了工具」。一行日志把两者分开报（cycle-109）。
    const hostLine = out.hostVerdict === undefined
      ? ''
      : '; ' + describeHostVerdict(out.hostVerdict, out.hostVisible ?? null);
    log[out.wired ? 'info' : 'warn']('agent disclosure: ' + out.reason + hostLine);
  });
  // cycle-92：agent 销毁时**撤销遮蔽并清状态**。
  // 修复前不监听 `agent/disposed` ⇒ restriction 的 disposer 从不调用 ⇒
  // 状态随会话数线性增长（长跑宿主上是真实泄漏）。
  host.on('agent/disposed', (payload) => {
    const agent = (payload as { agent?: unknown })?.agent;
    if (agent === null || agent === undefined || typeof agent !== 'object') return;
    forgetDisclosure(agent);
    untrackAgent(agent);
  });
  return { wired: true, reason: 'listener registered (per-agent indexed disclosure + unlock + dispose cleanup)', denyCount: 0 };
}
