/**
 * 披露的**宿主侧取证**（cycle-109 · 修 O-109-01）——从 `disclosureActivation.ts` 拆出。
 *
 * ## 为什么单独成文件（T3 ≤250 行，但边界是职责）
 *
 * `disclosureActivation.ts` 的职责是「状态 + 解锁动作」，而「采一次宿主视图并裁决」
 * 是**观测**，不是动作。把观测塞进动作模块会让两件事共用一份 import 面，
 * 且它已经把动作模块推过 250 行上限（329）。沿「动作 / 观测」切是唯一诚实的切法。
 *
 * ## 三条纪律（与 `disclosureVerdict.ts` 的纯判据分工）
 *
 * 1. **只采 scope 视图**：`schemas()` 不传参返回**全局视图**（KB `tools.md:571`；
 *    A0′ 的 v7 正是在这里误判「restrict 无效果」）。无 scope ⇒ 直接 unverified。
 * 2. **失败即 unverified，绝不抛给宿主**：取证是旁路，不能阻断接线。
 * 3. **一次/agent**（接线时与解锁时），不进轮询 —— 官方实测 258 工具一次 34.2ms。
 */
import { createScoped } from '../logger.ts';
import { classifyDisclosureVerdict, expectedVisibleIds, type DisclosureVerdict } from './disclosureVerdict.ts';

const log = createScoped('anic:disclosure-activation');

/** 宿主 scoped 面（本地窄化，不引宿主包）。 */
export interface ScopedToolsCtx {
  tools?: {
    restrict?: (f: { deny: string[] }) => () => void;
    /**
     * cycle-109：**文档化**读面（KB `subsystems/tools.md:568-574`）。
     * `omitted = the global view` ⇒ 观察 scoped 效果**必须**传 viewing scope。
     */
    schemas?: (scope?: unknown) => Array<{ name?: unknown }>;
  };
  /** `tools/change` 是 emit 事件：restriction 变更后必须发。 */
  emit?: (name: string, ...args: unknown[]) => unknown;
}

/** 宿主侧取证的四元组（未采到时的诚实形态：unverified + null + 两个空集）。 */
export interface HostVisibility {
  hostVerdict: DisclosureVerdict;
  hostVisible: number | null;
  hostLeaked: string[];
  hostMissing: string[];
}

/** 未采到的统一形态（单一构造点，避免四处各写一份 null/[] 字面量）。 */
export function unverifiedVisibility(): HostVisibility {
  return { hostVerdict: 'unverified', hostVisible: null, hostLeaked: [], hostMissing: [] };
}

/**
 * 采一次宿主侧可见性并裁决。
 *
 * @param scoped     agent 的 scoped ctx（`agent.ctx`）
 * @param agentScope viewing scope（必须是 agent 对象；缺失即拒绝采集）
 * @param allToolIds 全部工具 id
 * @param deny       本次施加的 deny 集合
 */
export function captureHostVisibility(
  scoped: ScopedToolsCtx | null | undefined,
  agentScope: unknown,
  allToolIds: readonly string[],
  deny: readonly string[],
): HostVisibility {
  const schemas = scoped?.tools?.schemas;
  if (typeof schemas !== 'function') return unverifiedVisibility();
  if (agentScope === null || agentScope === undefined || typeof agentScope !== 'object') {
    // 无 scope ⇒ 只能拿全局视图 ⇒ 结论会恒 partial。宁缺勿猜。
    return unverifiedVisibility();
  }
  let observed: string[];
  try {
    const list = schemas.call(scoped?.tools, agentScope);
    if (!Array.isArray(list)) return unverifiedVisibility();
    observed = [];
    for (const s of list) {
      const n = s?.name;
      if (typeof n === 'string' && n !== '') observed.push(n);
    }
  } catch (e) {
    log.warn('host schemas(scope) threw — verdict stays unverified: ' + (e instanceof Error ? e.message : String(e)));
    return unverifiedVisibility();
  }
  const judge = classifyDisclosureVerdict(expectedVisibleIds(allToolIds, deny), observed, deny);
  return {
    hostVerdict: judge.verdict,
    hostVisible: judge.observedVisible === null ? null : judge.observedVisible.length,
    hostLeaked: judge.leaked,
    hostMissing: judge.missing,
  };
}