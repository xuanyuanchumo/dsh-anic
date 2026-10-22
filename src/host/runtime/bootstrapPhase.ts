/**
 * 自举相位推进（cycle-72 拆分：同步编排器与异步执行循环共用的唯一实现）。
 *
 * 为什么单独成模块：async 版从 bootstrapOrchestrator.ts 拆出后（T3 250 行上限），
 * 两文件都需要「相位推进 + 落盘」。若各自复制一份 enterPhase，cycle-38 建立的
 * **状态机唯一权威**（transitionBootstrap 是唯一写 status 的入口）就会出现第二份
 * 调用约定，正是 CLAUDE.md「同一语义两条数据路径必须共享一个实现」所禁止的。
 *
 * 语义保持不变（承自 bootstrapOrchestrator 原注释）：
 * 每个相位边界都走 `transitionBootstrap` 并立即落盘，中间态在磁盘上可观测。
 * 非法触发词不推进也不抛：返回原状态让调用方继续——**相位记录是观测手段，
 * 不是裁决手段**，不能因为记账失败而让整轮自举停摆。
 */
import {
  type BootstrapState,
  type BootstrapTrigger,
  transitionBootstrap,
  saveBootstrapState,
} from '../selfBootstrap.ts';

/** 自举相位推进可用的触发词子集（与 BOOTSTRAP_TRANSITIONS 的相位边一致）。 */
export type PhaseTrigger = Extract<
  BootstrapTrigger,
  'start' | 'eval-done' | 'gate-fail' | 'fix-done' | 'verify-fail'
>;

/** 推进相位并落盘；非法转移返回原状态（不抛、不纠正）。 */
export function enterPhase(
  cyclesDir: string,
  state: BootstrapState,
  trigger: PhaseTrigger,
): BootstrapState {
  const moved = transitionBootstrap(state, trigger);
  if (!moved.ok) return state;
  saveBootstrapState(cyclesDir, moved.state);
  return moved.state;
}

/** 相位推进的可裁决形态：非法转移**如实返回原因**（路由面不得把拒绝伪装成成功）。 */
export interface PhaseOutcome {
  state: BootstrapState;
  rejected: string | null;
}

/**
 * 推进相位并在非法时返回拒绝原因（路由用；编排器用 enterPhase）。
 *
 * 两者共用同一次 `transitionBootstrap` 调用与同一次落盘——差别只在**是否把
 * 拒绝讲出来**。编排器是自动驱动，拒绝时继续跑（记账不是裁决）；路由是面向
 * 调用方的裁决面，拒绝必须响亮返回，否则非法转移会被读成成功。
 */
export function applyPhase(
  cyclesDir: string,
  state: BootstrapState,
  trigger: PhaseTrigger,
  patch?: Partial<Pick<BootstrapState, 'lastEvalScore' | 'lastGateVerdict'>>,
): PhaseOutcome {
  const moved = transitionBootstrap(state, trigger, patch);
  if (!moved.ok) return { state, rejected: moved.reason };
  saveBootstrapState(cyclesDir, moved.state);
  return { state: moved.state, rejected: null };
}
