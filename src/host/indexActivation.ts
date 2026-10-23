/**
 * 工具面**按需激活**机制（cycle-74 T-7402）。
 *
 * 前置已满足：A0′ **PASS**（cycle-73 零凭据真机）——scoped ctx 上 `restrict` 生效。
 * 证据：`.cycles/tech-debt/cycle-73-a0-probe-result.md`。
 *
 * 本模块提供激活/停用的**纯逻辑**（可离线单测），把「哪些工具该被遮住」算清楚；
 * 真正的 `restrict()` 调用与 agent 生命周期接线在 host 侧（下一轮，需加载器工具）。
 *
 * 为什么先做纯逻辑：deny 集合算错会**静默遮蔽模型必需的加载器**（模型再也取不回 schema，
 * 比不激活更糟）。把风险点做成可断言的纯函数，是这类开关的正确切法。
 *
 * 语义（design §3.2/§3.3）：
 *   - indexed 模式：除**加载器**外的全部 anic 工具进 deny（模型只看得见索引 + 加载器）；
 *   - full 模式：deny 为空（零行为变更）；
 *   - 加载器**永不**进 deny（否则模型无法取回 schema——自锁）；
 *   - 未知 id 不进 deny（`restrict` 对 unknown name 会抛，须先过滤，见下）。
 */
import { isKnownToolId } from './toolIds.ts';
import type { ToolDisclosureMode } from './toolDisclosure.ts';

/**
 * indexed 模式下**必须保持可见**的加载器工具（模型取回 schema 的唯一通道）。
 *
 * 注意：这两个 id 属**下一轮新增**（当前 19 工具里没有）。本模块按 id 声明，
 * `computeDeny()` 会先经 `isKnownToolId` 过滤——故在加载器尚未注册时，
 * deny 集合里**不会**出现它们（`restrict` 也就不会因 unknown name 抛错）。
 */
export const INDEX_LOADER_TOOLS = ['anic_tool_detail', 'anic_tools_search'] as const;

/**
 * 计算 `restrict` 的 deny 列表。
 *
 * 三条硬约束（每条都有对应单测）：
 *   1. full 模式 ⇒ 空数组（零行为变更，A8）；
 *   2. indexed 模式 ⇒ 全部**已知**工具减去加载器（加载器保持可见）；
 *   3. **只输出已知 id**——`restrict` 对 unknown global tool 会抛错（cycle-73 v6 实测：
 *      「names unknown global tool ...」），故必须先过滤，绝不把不存在的 id 交出去。
 */
export function computeDeny(mode: ToolDisclosureMode, allToolIds: readonly string[]): string[] {
  if (mode !== 'indexed') return [];
  const loaders = new Set<string>(INDEX_LOADER_TOOLS);
  return allToolIds.filter((id) => isKnownToolId(id) && !loaders.has(id));
}

/**
 * 激活面是否**可落地**（加载器已全部注册才可）。
 *
 * 若加载器缺失却切到 indexed，模型将失去取回任何 schema 的通道（自锁）。
 * 故此处显式判定，调用方据此**拒绝切档**（fail-closed 到 full，绝不半途遮蔽）。
 */
export function activationReady(mode: ToolDisclosureMode, registeredIds: readonly string[]): { ready: boolean; reason: string } {
  if (mode !== 'indexed') return { ready: false, reason: 'mode=full（默认，无需激活）' };
  const missing = INDEX_LOADER_TOOLS.filter((id) => !registeredIds.includes(id));
  if (missing.length > 0) {
    return { ready: false, reason: 'indexed 模式缺加载器 ' + missing.join(', ') + ' —— 模型将无法取回 schema（自锁），拒绝切档' };
  }
  return { ready: true, reason: 'ok' };
}

/**
 * 激活的单次调用契约（供 host 侧接线用；此处只描述形状，不做副作用）。
 *
 * 返回的 `lift` 必须被调用以恢复（对应 A0′ 实测的 disposer 精确恢复语义）。
 */
export interface ActivationPlan {
  /** 要交给 `ctx.tools.restrict({ deny })` 的列表。 */
  deny: string[];
  /** 人话理由（进日志/探针，便于排障）。 */
  reason: string;
}

/** 生成激活计划；不可落地时返回 null（调用方据此**保持 full**）。 */
export function planActivation(
  mode: ToolDisclosureMode,
  allToolIds: readonly string[],
  registeredIds: readonly string[],
): ActivationPlan | null {
  const ready = activationReady(mode, registeredIds);
  if (!ready.ready) return null;
  return { deny: computeDeny(mode, allToolIds), reason: ready.reason };
}
