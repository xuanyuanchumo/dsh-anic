/**
 * 自举循环的步骤执行器（cycle-38 T3 拆分：bootstrapOrchestrator 279→≤250 行）。
 *
 * 三个步骤（eval / gate / fix）在同步版与异步版编排器里是逐字重复的
 * （startFlow → invoke → finishFlow → parse）。re-gate 环加入后，gate 步骤
 * 会出现**三次**调用点（首次裁决 / 复检 / 异步版同款）——重复到第三次就是
 * 拆分的时机（CLAUDE.md 模块化纪律：一域一文件）。
 *
 * 本模块只做「跑一步 + 记账 + 解析」，不做状态机推进（相位推进留在编排器的
 * enterPhase——状态机是编排器的职责边界）。scriptsDir 由编排器解析一次注入，
 * 为 null（技能未安装）时步骤退化为「零值 + 不记账」——编排器不需要再分支。
 */
import type { InvokeResult } from '../skillInvoker.ts';
import { invokeSkillScript } from '../skillInvoker.ts';
import { startFlow, finishFlow, type FlowTrackerState } from './flowTracker.ts';
import { parseEvalScore, parseGateVerdict, parseFixApplied } from './scriptParsers.ts';

/** gate-check 的标准参数（首次裁决与复检共用；--record 让判定落账本）。 */
export const GATE_CHECK_ARGS: string[] = ['--gate', 'all', '--quality', '--record'];

export interface StepOutcome<T> {
  trackerState: FlowTrackerState;
  flowId?: string;
  value: T;
}

/** 同步跑一步 + 记账 + 解析（eval/gate/fix 共用形状；scriptsDir null → 零值直返）。 */
function runStep<T>(
  scriptsDir: string | null,
  cyclesDir: string,
  trackerState: FlowTrackerState,
  script: string,
  workspace: string,
  args: string[],
  timeoutMs: number,
  parse: (r: InvokeResult) => T,
  zero: T,
): StepOutcome<T> {
  if (!scriptsDir) return { trackerState, value: zero };
  const { state: s, flowId } = startFlow(cyclesDir, trackerState, script, workspace, args);
  const result = invokeSkillScript(scriptsDir, script, args, workspace, timeoutMs);
  return { trackerState: finishFlow(cyclesDir, s, flowId, result), flowId, value: parse(result) };
}

/** eval 步骤（解析：分数 0..1；失败清单在 stderr，cycle-96 起传入完整结果）。 */
export function runEvalStep(scriptsDir: string | null, cyclesDir: string, trackerState: FlowTrackerState, workspace: string, timeoutMs: number): StepOutcome<number> {
  return runStep(scriptsDir, cyclesDir, trackerState, 'eval-runner', workspace, [], timeoutMs, parseEvalScore, 0);
}

/** gate 步骤（解析：PASS/FAIL/doubt/...；FAILED 总裁决行在 stderr）。 */
export function runGateStep(scriptsDir: string | null, cyclesDir: string, trackerState: FlowTrackerState, workspace: string, timeoutMs: number, args: string[] = GATE_CHECK_ARGS): StepOutcome<string> {
  return runStep(scriptsDir, cyclesDir, trackerState, 'gate-check', workspace, args, timeoutMs, parseGateVerdict, 'unknown');
}

/** fix 步骤（解析：修复描述或 null=未修复）。 */
export function runFixStep(scriptsDir: string | null, cyclesDir: string, trackerState: FlowTrackerState, workspace: string, timeoutMs: number): StepOutcome<string | null> {
  return runStep(scriptsDir, cyclesDir, trackerState, 'auto-fix-loop', workspace, [], timeoutMs, parseFixApplied, null);
}

/** 门禁裁决的通过判定（PASS/approve 双拼写——编排器与路由共用的唯一口径）。 */
export function gateVerdictPassed(verdict: string): boolean {
  return verdict === 'PASS' || verdict === 'approve';
}
