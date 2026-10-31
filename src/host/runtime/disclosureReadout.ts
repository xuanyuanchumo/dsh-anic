/**
 * 渐进式披露的**运行时读数**（cycle-93）—— 把「不可查证」变成「任何时刻可查」。
 *
 * ## 为什么需要这个文件（修 O-92-02 / O-92-04 的根本困难）
 *
 * cycle-92 修掉了披露自锁（indexed 模式 2/23 → 23/23），但留下两个**无法查证**的项：
 *
 * | 编号 | 项 | 为什么当时查不了 |
 * |---|---|---|
 * | O-92-02 | 按需解锁是否真的生效 | 需切 `toolDisclosure: indexed` + **重启会话**，且只证明一次 |
 * | O-92-04 | `tools/change` 是否真的让宿主重装配 | 同上，且需观察宿主内部行为 |
 *
 * **根本问题不是"没做真机验证"，而是"披露状态没有任何出口"**：
 * - 状态存在内存 `WeakMap` / `Set` 里，当时只有一个从未被调用过的 `log.info` 出口
 *   （cycle-95 已删：不触发的日志不是证据）；
 * - `P8-tool-disclosure-mode` 探针只查**静态可激活性**（deny 集合 + 加载器在场），
 *   不查**运行时发生了什么**（哪些 agent 被遮蔽、谁解锁了什么、`tools/change` 发了几次）；
 * - ⇒ 即便切到 indexed 并重启，**同样看不到**内部状态，只能靠"模型能不能调通"间接推断。
 *
 * ## 修法：把运行时状态做成**可枚举的读数**
 *
 * 本模块提供一个**纯读取**的快照函数，把：
 * - 当前有多少 agent 处于 indexed 披露；
 * - 每个 agent 的 deny 数量与已解锁工具；
 * - `tools/change` 发出了多少次；
 *
 * 汇成一个结构化读数 ⇒ 由 `GET /anic/api/disclosure` 暴露 ⇒ 任何时候都能查证。
 *
 * ## 为什么是**读数**而不是"更强的日志"
 *
 * 日志是**流**（要按时间翻），读数是**状态**（一问一答）。查证"现在各 agent 的
 * 遮蔽面"是状态问题，用日志回答要翻全部历史且容易漏。
 *
 * ## 诚实边界（必须一起读）
 *
 * 本模块**不证明**宿主的 `restrict` 真的按 deny 生效——那需要读宿主的工具视图
 * （`ctx.tools.get(name, agent)`，A0′ 探针用过）。本模块只回答**我们这一侧**
 * 施加了什么、解锁了什么、发了几次事件。
 *
 * ⇒ 它把"完全不可查"提升为"我们这侧完全可查 + 宿主那侧仍待真机"——
 *   **不是**把未验证项变成已验证项，而是让验证有据可依。
 */
import { disclosureOf, trackedAgentCount, listTrackedAgents } from './disclosureActivation.ts';
import { toolsChangeEmitCount } from './toolsChangeCounter.ts';

// 计数器已下沉到零依赖叶子（解环）；此处重导出保持既有 import 路径零变更。
export { noteToolsChangeEmit, toolsChangeEmitCount, resetToolsChangeEmitCount } from './toolsChangeCounter.ts';


/** 一个 agent 的披露读数。 */
export interface AgentDisclosureReadout {
  /** 该 agent 的全部工具数。 */
  allToolCount: number;
  /** 加载器数（永不被遮蔽）。 */
  loaderCount: number;
  /** 当前 deny 数（被遮蔽的工具数）。 */
  denyCount: number;
  /** 已解锁的工具 id（按解锁顺序）。 */
  unlocked: string[];
  /** 当前是否还有生效的 restriction（`disposer !== null`）。 */
  restricted: boolean;
}

/** 披露运行时读数（`GET /anic/api/disclosure` 的响应体）。 */
export interface DisclosureReadout {
  /** 处于 indexed 披露的 agent 数（进程级）。 */
  trackedAgents: number;
  /** 各 agent 的明细（按 tracked 顺序；不含 agent 标识以免泄漏会话信息）。 */
  agents: AgentDisclosureReadout[];
  /** `tools/change` 累计发出次数。 */
  toolsChangeEmits: number;
  /**
   * **自锁判定**（本读数的核心）：是否有 agent 处于「被遮蔽且无解锁通道」的状态。
   *
   * 判据：`denyCount > 0 && !restricted` 是**不可能态**（没 restriction 却算 deny）；
   * 真正的自锁是 `denyCount === allToolCount && trackedAgents > 0` 且
   * 解锁通道缺失——但通道存在性由 `activationReady` 管（P8 探针）。
   * ⇒ 本字段只报「deny 覆盖了除加载器外的全部工具」这一**预期初态**，
   *   供读者对照「解锁后应该变小」。
   */
  fullyMaskedAgents: number;
  /** 读数生成时刻（ISO）。 */
  generatedAt: string;
}

/**
 * 生成披露运行时读数。
 *
 * ## 为什么要从 `tracked` 反查而不是遍历 `WeakMap`
 *
 * `WeakMap` **不可枚举**（这是它的语义：不影响 GC）。⇒ 状态表额外维护一个
 * `tracked: Set<object>` 用于巡检（`trackAgent` / `untrackAgent` 已在 cycle-92 落地）。
 * 遍历 `tracked` 再用 `disclosureOf(agent)` 取明细 —— 两者同源，不会分叉。
 */
export function buildDisclosureReadout(nowIso?: string): DisclosureReadout {
  const agents: AgentDisclosureReadout[] = [];
  let fullyMasked = 0;
  // trackedAgentCount 只给数量；明细需要逐个 agent ⇒ 用导出的迭代器。
  for (const agent of iterTrackedAgents()) {
    const st = disclosureOf(agent);
    if (st === null) continue;
    const unlocked = [...st.unlocked];
    const denyCount = st.deny.length;
    const isFullyMasked = denyCount === st.allToolIds.length - st.loaderIds.length;
    if (isFullyMasked) fullyMasked++;
    agents.push({
      allToolCount: st.allToolIds.length,
      loaderCount: st.loaderIds.length,
      denyCount,
      unlocked,
      restricted: st.disposer !== null,
    });
  }
  return {
    trackedAgents: trackedAgentCount(),
    agents,
    toolsChangeEmits: toolsChangeEmitCount(),
    fullyMaskedAgents: fullyMasked,
    generatedAt: nowIso ?? new Date().toISOString(),
  };
}

/**
 * 遍历被跟踪的 agent（供读数构建）。
 *
 * 单独导出而不是让读数模块直接读 `tracked`：`tracked` 是模块私有状态，
 * 直接读会让两个模块耦合在**同一个可变集合**上。经函数暴露 ⇒ 读侧只依赖接口。
 */
function iterTrackedAgents(): object[] {
  return listTrackedAgents();
}


/** 读数是否显示**解锁通道在工作**（供探针/面板判据）。 */
export function unlockChannelActive(readout: DisclosureReadout): boolean {
  return readout.agents.some((a) => a.unlocked.length > 0);
}

/** 日志一行摘要（进 org-status / 排障）。 */
export function summarizeDisclosure(readout: DisclosureReadout): string {
  if (readout.trackedAgents === 0) return 'no agent in indexed disclosure (mode=full)';
  const unlockedTotal = readout.agents.reduce((n, a) => n + a.unlocked.length, 0);
  return `agents=${String(readout.trackedAgents)}, unlocked=${String(unlockedTotal)}, `
    + `fullyMasked=${String(readout.fullyMaskedAgents)}, tools/change=${String(readout.toolsChangeEmits)}`;
}

/**
 * ## cycle-95 删除 `noteReadoutReady()`（为什么删）
 *
 * 它只发一条「模块已装载」的 log，**从没被任何调用方调用**（全仓去注释后零
 * 文本命中，含 `src/index.ts` 的 apply 路径）。而「这一版读数模块是活的」
 * 已经有两个更硬的出口证明：
 *
 * - `GET /anic/api/disclosure` 的响应（`disclosureRoute` 用 `summarizeDisclosure`）；
 * - `GET /anic/api/self-check` 的 runtime 行（`selfCheckRoute` 同源摘要）。
 *
 * ⇒ 一条没人触发的 log 不是排障证据，反而是「以为有启动自证」的假安心。
 * 本仓纪律：守卫/自证必须真的会跑；不会跑的自证比没有更糟。
 */
