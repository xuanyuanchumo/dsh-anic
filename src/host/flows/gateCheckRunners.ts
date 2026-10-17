/**
 * gateCheckRunners —— gate-check 流程的引擎侧执行器（R3 阶段 2）。
 *
 * 与 gateCheckFlow.ts（状态机层）的分界：
 *  - 本文件 = 「怎么把判定跑出来」：script 正典路径 / native 引擎路径 / native 入账。
 *  - 那边    = 「判定如何驱动状态」：描述子、守卫、投影、事件。
 *
 * 账本纪律：script 模式的 --record 由脚本自身完成（脚本是正典写入者）；
 * native 模式的入账在本文件 recordNative —— 与脚本 :204-214 同一去重语义。
 */
import type { GateCheckResult } from './gateTypes.ts';
import { runNativeGateCheck } from './gateEngine.ts';
import { resolveSkillScriptsDir, invokeSkillScript } from '../skillInvoker.ts';
import { parseGateLines, parseGateVerdict } from '../runtime/scriptParsers.ts';
import { loadLedger, appendEntry } from '../runtime/ledger.ts';

/** 收敛门中文名（与技能 lib/ledger.mjs GATE_NAMES 同表——账本条目字段必须一致）。 */
export const CONVERGENCE_GATE_NAMES: Readonly<Record<string, string>> = {
  G0: '评估收敛门',
  G1: '任务收敛门',
  G2: '测试收敛门',
  G3: '构建收敛门',
};

/** 引擎判定面（两侧共同形态；diff 模式按字段比对两侧）。 */
export interface EngineSide {
  gates: Record<string, GateCheckResult>;
  quality: Record<string, GateCheckResult>;
  allPass: boolean;
  exitCode: number;
  fatal?: string;
}

export interface ScriptSideOut extends EngineSide {
  stdout: string;
}

/** script 正典路径：spawn 技能脚本 + 输出解析。技能目录缺失 → error 字段响亮返回。 */
export function runScriptSide(
  ws: string,
  gate: string,
  quality: boolean,
  record: boolean,
  timeoutMs: number,
): ScriptSideOut | { error: string } {
  const scriptsDir = resolveSkillScriptsDir(ws);
  if (!scriptsDir) return { error: 'skill scripts not found' };
  const args = ['--gate', gate, ...(quality ? ['--quality'] : []), ...(record ? ['--record'] : [])];
  const r = invokeSkillScript(scriptsDir, 'gate-check', args, ws, timeoutMs);
  const parsed = parseGateLines(r);
  const overall = parseGateVerdict(r);
  return {
    gates: parsed.gates,
    quality: parsed.quality,
    allPass: overall === 'PASS',
    exitCode: r.exitCode === 0 ? 0 : 1,
    fatal: /No \.cycles\/config\.yml found/.test(r.stderr) ? 'CONFIG_MISSING' : undefined,
    stdout: r.stdout,
  };
}

/** native+record：与脚本 :204-214 同一去重语义（该门最新一条 result+detail 相同则跳过）。 */
export function recordNative(cyclesDir: string, gates: Record<string, GateCheckResult>): string[] {
  const existing = loadLedger(cyclesDir);
  const recorded: string[] = [];
  for (const [g, r] of Object.entries(gates)) {
    const status = r.pass ? 'PASS' : 'FAIL';
    const detail = r.detail || 'N/A';
    const lastForGate = [...existing].reverse().find((e) => e.gate === g);
    if (lastForGate && lastForGate.result === status && lastForGate.detail === detail) continue;
    appendEntry(cyclesDir, {
      gate: g,
      gateName: CONVERGENCE_GATE_NAMES[g] ?? g,
      result: status,
      detail,
    });
    recorded.push(g);
  }
  return recorded;
}

/** native 路径便捷封装（gateCheckFlow 只消费 EngineSide 形态）。 */
export function runNativeSide(ws: string, gate: string, quality: boolean | undefined): EngineSide {
  return runNativeGateCheck(ws, { gate, quality });
}
