/**
 * close 驱动的宏观相位推进（cycle-78 WS-A，全生命周期缺口）。
 *
 * 被守卫缺陷：宏观 6 相机制其实齐备（`flows/macroPhaseEngine.ts` 的 `advanceMacro`
 * 带逐相门禁守卫；`anic_flows_advance` 工具也在），但**没有任何自举链调用它**——
 * `cycleRunner.closeCycle` 只查 workflow-graph 节点状态与账本哈希链，从不读门禁账本、
 * 从不推进相位。于是 L4 自举循环跑完 77 轮，`.cycles/workflow-state.json` 仍显示
 * `currentPhase: build`：全生命周期评审的"阶段流转"是死的。
 *
 * 本文件是 close 侧唯一写路径：门禁账本 G0-G3 全有 PASS 时，循环调 `advanceMacro`
 * 把相位尽可能推进（build→test→deploy→maintain）；被门禁卡住即停；门禁不全时
 * **零相位写入**（拒绝零写入纪律）。从 cycleRunner.ts 拆出（T3：单文件 ≤250 行）。
 */
import { advanceMacro, loadMacroState, readGateResults } from '../flows/macroPhaseEngine.ts';

/** 宏观相位推进报告（closeCycle 返回值只增字段）。 */
export interface PhaseAdvanceReport {
  /** 本次 close 前的相位（状态文件缺失时回落 'plan'）。 */
  phaseFrom: string;
  /** 本次 close 后的相位（未推进时与 phaseFrom 相等）。 */
  phaseTo: string;
  /** 是否真实写入相位（门禁不全 / 幂等 / 已末相 → false，零写入）。 */
  phaseAdvanced: boolean;
  /** 卡住的门（逗号分隔；推进成功或幂等时缺省）。 */
  phaseBlockedBy?: string;
  /** 人类可读原因（缺门点名 / 引擎逐字消息 / 末相说明）。 */
  phaseReason: string;
}

/** 门禁账本四门：相位推进的唯一前置（全部有 PASS 记录才动相位）。 */
const PHASE_ADVANCE_GATES = ['G0', 'G1', 'G2', 'G3'] as const;

/** 不推进相位的报告（零写入纪律：宁可不写，也不写半截状态）。 */
export function phaseNoAdvance(
  workspaceRoot: string,
  blockedBy: string | undefined,
  reason: string,
): PhaseAdvanceReport {
  const current = loadMacroState(workspaceRoot)?.currentPhase ?? 'plan';
  return {
    phaseFrom: current,
    phaseTo: current,
    phaseAdvanced: false,
    ...(blockedBy ? { phaseBlockedBy: blockedBy } : {}),
    phaseReason: reason,
  };
}

/**
 * 按门禁账本把相位尽可能推进。
 *
 * 决策语义：
 *  - 前置 = 门禁账本四门（G0/G1/G2/G3）全部"曾 PASS"。缺任一 → 零写入 + 点名缺门。
 *  - 逐相循环 = 每步 `advanceMacro` 自带「当前相门禁已过」守卫；被卡住即停（已推进的
 *    部分照实返回，phaseAdvanced 反映真实写入）。
 *  - 幂等 = 末相（maintain）再推进时引擎返回 `final` 且零写入 → 同 cycle 二次 close
 *    不再改相位（无需额外标记文件）。
 *  - 推进条件**只以门禁账本为据**，不与节点级 strict check（依赖 nodeStatus）耦合：
 *    真实工作区 nodeStatus 长期为空，若耦合则相位永不推进（正是本缺口本身）。两套
 *    证据独立，ok/gatesPassed 仍如实反映节点账。
 */
export function advancePhasesOnClose(workspaceRoot: string): PhaseAdvanceReport {
  const gateResults = readGateResults(workspaceRoot);
  const missing = PHASE_ADVANCE_GATES.filter((g) => !gateResults.passed.includes(g));
  if (missing.length > 0) {
    return phaseNoAdvance(
      workspaceRoot,
      missing.join(','),
      `gate ledger missing PASS for ${missing.join(',')} — phase not advanced (zero writes)`,
    );
  }

  const from = loadMacroState(workspaceRoot)?.currentPhase ?? 'plan';
  let advanced = false;
  let reason = 'already at final phase (maintain) — no phase write';
  // 上限 = 相位数 + 余量：任何意外不前进都不会转成死循环。
  for (let step = 0; step < 8; step++) {
    const out = advanceMacro(workspaceRoot);
    if (out.final) { reason = out.message; break; }
    if (!out.ok) {
      const current = loadMacroState(workspaceRoot)?.currentPhase ?? from;
      return {
        phaseFrom: from,
        phaseTo: current,
        phaseAdvanced: advanced && current !== from,
        ...(out.gate ? { phaseBlockedBy: out.gate } : {}),
        phaseReason: out.message,
      };
    }
    advanced = true;
    reason = out.message;
  }
  const to = loadMacroState(workspaceRoot)?.currentPhase ?? from;
  return { phaseFrom: from, phaseTo: to, phaseAdvanced: advanced && to !== from, phaseReason: reason };
}
