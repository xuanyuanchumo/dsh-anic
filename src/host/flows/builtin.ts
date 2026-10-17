/**
 * builtin —— 内置流程注册聚合（R3 阶段 3 起多流程）。
 *
 * 从 gateCheckFlow.ts 抽出：阶段 2 只有一个流程时聚合放在那里没问题，
 * 阶段 3 起第二个流程（macro-phase）加入，聚合点独立成文件避免
 * gateCheckFlow ← macroPhaseFlow 的反向依赖。
 */
import { registerFlow } from './registry.ts';
import { GATE_CHECK_FLOW } from './gateCheckFlow.ts';
import { MACRO_PHASE_FLOW } from './macroPhaseFlow.ts';

/** 注册全部内置流程（插件 apply 期调用一次；返回聚合 disposer）。 */
export function registerBuiltinFlows(): () => void {
  const d1 = registerFlow(GATE_CHECK_FLOW);
  const d2 = registerFlow(MACRO_PHASE_FLOW);
  return () => { d2?.(); d1?.(); };
}
