/**
 * gateCheckRunners —— gate-check 流程的引擎侧执行器（R3 阶段 2）。
 *
 * 与 gateCheckFlow.ts（状态机层）的分界：
 *  - 本文件 = 「怎么把判定跑出来」：script 正典路径 / native 引擎路径 / native 入账。
 *  - 那边    = 「判定如何驱动状态」：描述子、守卫、投影、事件。
 *
 * 账本纪律：script 模式的 --record 由脚本自身完成（脚本是正典写入者）；
 * native 模式的入账在本文件 recordNative —— 与脚本同一去重语义，且 cycle-77 起
 * 与脚本一样把**质量维逐维裁决**并入 detail（F-04：账本不得只记基本判定）。
 */
import type { GateCheckResult } from './gateTypes.ts';
import { runNativeGateCheck, type QualityGateDetail } from './gateEngine.ts';
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

/**
 * 原生侧「同一次运行的判定面 → 质量维裁决」关联表（cycle-77 修 F-04 原生侧同族缺陷）。
 *
 * 被守卫的缺陷：recordNative 原先只消费 `native.gates`（门的基本判定），质量维裁决停在
 * EngineSide.quality 里 ⇒ 质量维 FAIL 时账本照样记 PASS，与脚本侧同一个账本 fail-open 面
 * （cycle-72 债务台账 §4）。
 *
 * 为什么不加第三个必填参数：唯一生产调用点 gateCheckFlow.ts 传的是 `native.gates`
 * （不是整个 EngineSide），把 quality 改成必填就得同步改调用方；本表按「同一跑产出的
 * gates 对象」关联质量裁决，使 recordNative(cyclesDir, gates) 在同一跑里自然拿到 Q 段，
 * 既有导出签名与调用方零改动（third 参数仍保留为显式覆盖，供新调用方/测试使用）。
 * WeakMap：键随 gates 对象回收，绝不会把上一次运行的质量裁决串到下一次。
 */
const qualityByGates = new WeakMap<Record<string, GateCheckResult>, Record<string, GateCheckResult>>();

/**
 * native+record：与脚本 :275-300 同一去重语义（该门最新一条 result+detail 相同则跳过），
 * 且 detail 与 result 取**含质量维的最终裁决**（F-04）：
 *  - 质量 FAIL ⇒ 账本记 FAIL（修复前只看 gates[g].pass，账本可能记 PASS）；
 *  - detail 追加逐维裁决 `[Q1:PASS,Q5:FAIL]`，与脚本 --record 拼出的 detail 逐字节一致，
 *    否则同一门在脚本/native 两种模式下会因 detail 不同而双录。
 */
export function recordNative(
  cyclesDir: string,
  gates: Record<string, GateCheckResult>,
  quality?: Record<string, GateCheckResult>,
): string[] {
  const qualityOf = quality ?? qualityByGates.get(gates) ?? {};
  const existing = loadLedger(cyclesDir);
  const recorded: string[] = [];
  for (const [g, r] of Object.entries(gates)) {
    const q = qualityOf[g] as QualityGateDetail | undefined;
    const finalPass = r.pass && (q === undefined ? true : q.pass);
    const status = finalPass ? 'PASS' : 'FAIL';
    const dims = q?.dimensionRows;
    const detail = `${r.detail || 'N/A'}${dims && dims.length > 0 ? ` [${dims.join(',')}]` : ''}`;
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
  const side = runNativeGateCheck(ws, { gate, quality });
  // 登记质量裁决，供同一次运行的 recordNative(cyclesDir, side.gates) 合流（见上表注释）
  qualityByGates.set(side.gates, side.quality);
  return side;
}
