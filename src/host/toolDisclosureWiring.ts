/**
 * 工具面**按需加载接线**（cycle-74 T-7406）——把披露/激活机制接到 agent 生命周期。
 *
 * 前置已全部就绪：
 *   - A0′ **PASS**：scoped ctx 上 `restrict` 生效（cycle-73 零凭据真机，视图 25→24、
 *     `get(name,agent)` 归 absent、全局不受影响、disposer 精确恢复）；
 *   - 加载器工具**已注册**（anic_tool_detail / anic_tools_search）⇒ `activationReady` 可过；
 *   - `planActivation` 给出 deny 集合（只含已注册 id，绝不含加载器）。
 *
 * 接线形态（沿官方先例 dsh-file-reference-local / dsh-subagent）：
 *   `ctx.on('agent/created', ({ agent }) => …)` → 在该 **agent 的 scoped ctx** 上：
 *     ① `ctx.systemPrompt.section({…索引文本…})` 注入能力索引（A0″ 已验证该通道可用）；
 *     ② `agent.ctx.tools.restrict({ deny })` 激活可见集。
 *
 * 双保险（绝不半途遮蔽）：
 *   - 模式为 `full`（默认）⇒ **完全不接线**（零行为变更，A8）；
 *   - 加载器缺失 或 宿主无 `restrict`/`systemPrompt` ⇒ **保持 full** 并记日志。
 *
 * 关键实现坑（cycle-73 实测，勿重踩）：`schemas()` 不传参 = 全局视图；
 * 要观察 scope 差异必须传 agent。本模块只用 `restrict`/`section`，不读 schemas。
 */
import { createScoped } from './logger.ts';
import { planActivation } from './indexActivation.ts';
import { buildIndexSectionText, resolveDisclosureMode } from './toolDisclosure.ts';
import type { CapabilityIndexInjectable } from './capabilityIndex.ts';
import { INDEX_LOADER_TOOLS } from './indexActivation.ts';

const log = createScoped('anic:tool-disclosure');

/** 接线所需的最小宿主面（本地窄化，不引宿主包）。 */
interface ScopedCtx {
  tools?: { restrict?: (f: { deny: string[] }) => () => void };
  systemPrompt?: { section?: (s: { name: string; order?: number; text: string }) => unknown };
}
interface DisclosureHost {
  on?: (name: string, handler: (payload: { agent?: { ctx?: ScopedCtx } }) => void) => unknown;
  systemPrompt?: { getSectionOrder?: (key: string) => number };
}

/** 接线结果（供探针/日志如实上报「接没接、为什么」。 */
export interface WiringOutcome {
  wired: boolean;
  reason: string;
  denyCount: number;
}

/**
 * 为一个 agent scope 施加披露（注入索引 + 激活可见集）。
 *
 * 导出以便**单测**直接验证判定路径，而不必伪造完整宿主。返回 disposer（无操作则 null）。
 */
export function applyDisclosureToScope(
  scoped: ScopedCtx,
  index: CapabilityIndexInjectable,
  mode: 'full' | 'indexed',
  allToolIds: readonly string[],
): WiringOutcome {
  if (mode !== 'indexed') return { wired: false, reason: 'mode=full (default, zero behavior change)', denyCount: 0 };
  const plan = planActivation(mode, allToolIds, allToolIds);
  if (!plan) {
    return { wired: false, reason: 'activation blocked: ' + (INDEX_LOADER_TOOLS.join('/') + ' 未全部注册，切档将自锁'), denyCount: 0 };
  }
  if (!scoped.tools?.restrict) return { wired: false, reason: 'host has no scoped tools.restrict (old generation/stub) — stay full', denyCount: 0 };
  try {
    scoped.tools.restrict({ deny: plan.deny });
    scoped.systemPrompt?.section?.({ name: 'anic:capability-index', text: buildIndexSectionText(index) });
    return { wired: true, reason: 'indexed: injected index + restricted ' + String(plan.deny.length) + ' tools', denyCount: plan.deny.length };
  } catch (e) {
    // 失败必须响亮且**退回 full 语义**：restrict 未生效即未遮蔽，模型仍见全量。
    return { wired: false, reason: 'restrict threw: ' + (e instanceof Error ? e.message : String(e)), denyCount: 0 };
  }
}

/**
 * 注册 agent 生命周期接线（`agent/created`）。
 *
 * `mode='full'`（默认）时**直接不注册监听器**——省掉每条会话的无谓开销，且语义最清晰。
 */
export function wireToolDisclosure(
  ctx: unknown,
  opts: {
    mode: unknown;
    index: CapabilityIndexInjectable;
    allToolIds: readonly string[];
  },
): WiringOutcome {
  const mode = resolveDisclosureMode(opts.mode);
  if (mode !== 'indexed') return { wired: false, reason: 'mode=full (default)', denyCount: 0 };
  const host = ctx as DisclosureHost;
  if (typeof host.on !== 'function') return { wired: false, reason: 'host has no ctx.on (stub/old generation) — stay full', denyCount: 0 };
  const plan = planActivation(mode, opts.allToolIds, opts.allToolIds);
  if (!plan) return { wired: false, reason: 'activation blocked (loaders missing) — stay full', denyCount: 0 };
  host.on('agent/created', (payload) => {
    const scoped = payload?.agent?.ctx;
    if (!scoped) return;
    const out = applyDisclosureToScope(scoped, opts.index, mode, opts.allToolIds);
    log[out.wired ? 'info' : 'warn']('agent disclosure: ' + out.reason);
  });
  return { wired: true, reason: 'listener registered (per-agent indexed disclosure)', denyCount: plan.deny.length };
}
