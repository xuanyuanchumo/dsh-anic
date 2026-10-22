/**
 * 技能脚本输出解析器 —— cycle-96 按真实输出契约重写（P0-BOOTSTRAP-PARSER）。
 *
 * 旧实现（bootstrapOrchestrator.ts 与 selfBootstrapRoute.ts 各一份，共两份重复）
 * 按虚构格式解析："Overall score: 0.875" / "GATE: PASS" / "Applied: ..."。
 * 三个真实脚本从不输出这些行，后果：
 *   parseEvalScore 恒 0、parseGateVerdict 恒 'unknown'（真实工作区永远走不到
 *   CONVERGED，advanceBootstrap 只认 'PASS'/'approve'）、parseFixApplied 恒 null。
 * 自举链 M10-b 名义上连通，实际从未在真实环境正确裁决过。
 *
 * 真实输出契约（assets/skill/scripts/ 源码为证，行号为 cycle-96 基线）：
 * eval-runner.mjs：
 *   :498 stdout "Evaluation report written to <path>"（cycle 目录存在时）
 *   :515 stdout "\nAll N evaluated dimension(s) passed."（全部通过，exit 0）
 *   :509 stderr "\nN dimension(s) failed: E3, E8, Q8"（有失败，exit 1）
 *   :517 stdout "M dimension(s) SKIPPED (not evaluated, NOT pass): ..."（SKIP ≠ PASS）
 * gate-check.mjs：
 *   :197 status 仅两值（result.pass ? 'PASS' : 'FAIL'）
 *   :198 stdout "[PASS|FAIL] G0: <detail>"（逐门禁行）
 *   :219 stdout "  [PASS|FAIL] G0-Quality: <detail>"（--quality 行，缩进两格；
 *           质量 FAIL 同样拉低总裁决 :220）
 *   :228 stdout "\nAll gates PASSED."（全部通过，exit 0）
 *   :225 stderr "\nGate check FAILED. Fix issues before proceeding."（有失败，exit 1）
 *   :209/:212 "  [LEDGER] ..." 行不含 [PASS]/[FAIL] 前缀，不参与裁决
 * auto-fix-loop.mjs：
 *   :244 stdout "All tests passed. No fixes needed."（无需修复）
 *   :251 stdout "Identified N failure(s):" + :253 "  - <type>: <detail>" 行
 *   :274 stdout "Fix successful. All tests now pass."（修复并验证通过）
 *   :280 stdout "Fix attempt N failed. M failure(s) remain."（修复未通过）
 *
 * 同一语义必须单一实现：两份重复解析只会向坏方向漂移，故合并到本文件。
 */

import type { InvokeResult } from '../skillInvoker.ts';

/**
 * 解析器输入：只需输出双流（测试可直接构造字面量，无需完整 InvokeResult）。
 * 需要退出码判定「未运行」时由调用方传入完整 InvokeResult（exitCode 可选）。
 */
export type ScriptOutput = Pick<InvokeResult, 'stdout' | 'stderr'> & { exitCode?: number };

/**
 * 脚本裁决三态（cycle-72 P0-SCRIPT-PARSER-TRISTATE）。
 *
 * 旧契约只有二值（1/0、"PASS"/"FAIL"/"unknown"），于是**两类完全不同的事实**
 * 塌缩成同一个值：
 *   - 「脚本跑到了裁决，但没通过」 —— 真实的评估失败，值得进技术债队列；
 *   - 「脚本根本没跑成」（缺 .cycles 前置 / 未知维度 / 脚本不可用） —— 环境问题，
 *     修代码毫无意义。
 * 两轮自举恒 0 分的根因正是后者被当成前者：调用方看到 0 分就去产 0 分提案，
 * 而真正要做的是补 `.cycles` 前置。
 *
 * 现引入三态：`passed` / `failed` / `not-run`（附原因）。旧二值 API 保留为薄包装
 * （`not-run` 与 `failed` 都映射到「未通过」），因此所有既有调用方零改动、语义
 * 仍然 fail-closed——**只是现在多了一条能区分两者的信息**。
 */
export type OutcomeState = 'passed' | 'failed' | 'not-run';

/** 脚本未运行的原因（机器码，调用方按码分支，不解析 message）。 */
export type NotRunReason =
  | 'CONFIG_MISSING' //    .cycles 配置缺失——脚本入口即 exit 1
  | 'BAD_DIMENSIONS' //    未知维度名（eval-runner --dimensions E9）
  | 'NO_RECOGNIZABLE_OUTPUT'; // 输出里没有任何裁决行（脚本崩溃/不可用）

/** 三态裁决结果。 */
export interface ScriptOutcome {
  state: OutcomeState;
  /** 未运行时非空——调用方据此报「环境未就绪」而不是「质量不合格」。 */
  reason?: NotRunReason;
  /** 未运行时的原始诊断（脚本 stderr 首行）。 */
  detail?: string;
}

/**
 * 「脚本根本没跑成」的共同指纹（eval-runner / gate-check 共用的入口拒绝）。
 *
 * 两个脚本都经 `scripts/lib/config.mjs::loadProjectConfig` 读配置，缺文件时打印
 * 同一条 `No .cycles/config.yml found in <dir> ...` 并 exit 1（旧名
 * `cycle-config.yml` 同样命中该分支）。这里按**行为契约**匹配而非抄路径字面量
 * ——REMEDY 文案改了不该让三态判定失效，故用宽松锚点。
 */
const CONFIG_MISSING_RE = /No \.(?:cycles\/)?(?:cycle-)?config\.ya?ml found in/i;

/** eval-runner 的未知维度拒绝（eval-runner.mjs S-11 修复：响亮失败而非静默空集）。 */
const BAD_DIMENSIONS_RE = /Unknown dimension\(s\):/i;

/** 判定一次输出是否属于「未运行」，并给出原因；不属于则返回 null。 */
function detectNotRun(result: ScriptOutput): ScriptOutcome | null {
  const combined = `${result.stderr}\n${result.stdout}`;
  if (CONFIG_MISSING_RE.test(combined)) {
    return { state: 'not-run', reason: 'CONFIG_MISSING', detail: firstLine(result.stderr) };
  }
  if (BAD_DIMENSIONS_RE.test(combined)) {
    return { state: 'not-run', reason: 'BAD_DIMENSIONS', detail: firstLine(result.stderr) };
  }
  return null;
}

/** 取首个非空行（诊断摘要用；脚本把根因放在首行）。 */
function firstLine(s: string): string | undefined {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
}

/**
 * eval-runner 三态裁决。
 *
 * 顺序有意为之：**先判「没跑成」再判「跑失败」**。反过来会被下游症状误导——
 * 缺配置时脚本尚未来到维度循环就 exit 1，但 stdout 仍可能残留上一次的
 * 通过行（部分运行合并旧报告），先判 failed 会把入口拒绝读成"跑过了"。
 */
export function parseEvalOutcome(result: ScriptOutput): ScriptOutcome {
  const notRun = detectNotRun(result);
  if (notRun) return notRun;
  if (/dimension\(s\) failed:/.test(result.stderr)) return { state: 'failed' };
  if (/All \d+ evaluated dimension\(s\) passed\./.test(result.stdout)) return { state: 'passed' };
  // 有输出但无任何裁决行：脚本未走到裁决点（崩溃/被截断）——如实报未运行
  return { state: 'not-run', reason: 'NO_RECOGNIZABLE_OUTPUT', detail: firstLine(result.stderr) };
}

/**
 * gate-check 三态裁决。
 *
 * `unknown`（无任何裁决行）在旧契约里就是"无法识别"，等价于三态的 not-run；
 * 但**有裁决行**时 PASS/FAIL 都是真实结论，不得降级为 not-run。
 */
export function parseGateOutcome(result: ScriptOutput): ScriptOutcome & { verdict: string } {
  const notRun = detectNotRun(result);
  if (notRun) {
    // 缺配置时脚本可能已打印部分门禁行，但入口拒绝否定了整次运行的效力
    return { ...notRun, verdict: 'unknown' };
  }
  if (/All gates PASSED\./.test(result.stdout)) return { state: 'passed', verdict: 'PASS' };
  if (/Gate check FAILED\./.test(result.stderr)) return { state: 'failed', verdict: 'FAIL' };
  const gateLines = result.stdout.match(/^[ \t]*\[(PASS|FAIL)\] G\d/gm) ?? [];
  if (gateLines.length === 0) {
    return { state: 'not-run', reason: 'NO_RECOGNIZABLE_OUTPUT', verdict: 'unknown', detail: firstLine(result.stderr) };
  }
  return gateLines.some((l) => l.includes('[FAIL]'))
    ? { state: 'failed', verdict: 'FAIL' }
    : { state: 'passed', verdict: 'PASS' };
}

/**
 * eval-runner 裁决 → 1 | 0。
 *
 * 真实 stdout 没有连续分数行；失败路径也不打印通过数，连续分数不可推导
 * （失败清单在 stderr :509，通过总数只在成功路径 :515 出现）。
 * 忠实二值：1 = 全部已评估维度通过（exit 0）；0 = 存在失败维度或输出不可识别。
 * evalScore 在状态机中只作记录（advanceBootstrap 不按它分支），二值即诚实——
 * 宁可少报精度，不可虚构 "0.875" 这种从未存在过的数。
 *
 * cycle-72：三态信息由 parseEvalOutcome 承载；本函数保留为薄包装以零破坏既有
 * 调用方。`not-run` 与 `failed` 都返回 0（fail-closed：未通过），差别只在
 * **调用方是否选择**用 parseEvalOutcome 把两者分开。
 */
export function parseEvalScore(result: ScriptOutput): number {
  return parseEvalOutcome(result).state === 'passed' ? 1 : 0;
}

/**
 * gate-check 裁决 → 'PASS' | 'FAIL' | 'unknown'。
 *
 * 总裁决行优先（--gate all 时的官方裁决）；无总裁决行的部分运行
 * （如 --gate G1）退回逐门禁行统计。'unknown' 保留给完全无法识别的
 * 输出——调用方把它当"未通过"处理（advanceBootstrap 只认 PASS/approve）。
 *
 * cycle-72：三态信息由 parseGateOutcome 承载；本函数是薄包装（`.verdict` 直取）。
 * **收敛语义未变**：'PASS' 是唯一能让 advanceBootstrap 收敛的值，`failed` 与
 * `not-run` 分别映射到 'FAIL' 与 'unknown'，两者都不参与 CONVERGED 判定
 * （fail-closed 在状态机层，`selfBootstrap.ts` 只认 PASS/approve）。三态只增加
 * 可辨识度，不改变裁决。
 */
export function parseGateVerdict(result: ScriptOutput): string {
  return parseGateOutcome(result).verdict;
}

/**
 * auto-fix-loop 修复描述 → string | null。
 *
 * null = 无需修复（:244）/ 修复未验证通过（:280）/ 输出不可识别；
 * string = "修复并通过: <type1>: <detail1>; <type2>: ..."。
 * 修复描述取最后一次 Identified 清单——多次尝试时，前面尝试的失败
 * 可能已被后续尝试修复，只有最后一段对应最终通过的修复。
 */
export function parseFixApplied(result: ScriptOutput): string | null {
  if (/All tests passed\. No fixes needed\./.test(result.stdout)) return null;
  if (!/Fix successful\. All tests now pass\./.test(result.stdout)) return null;
  // 多次尝试取最后一段 Identified 清单
  const sections = [
    ...result.stdout.matchAll(/Identified \d+ failure\(s\):\r?\n((?:[ \t]*- .+(?:\r?\n|$))+)/g),
  ];
  const last = sections.at(-1);
  if (!last?.[1]) return 'Fix successful. All tests now pass.';
  const items = last[1]
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter(Boolean);
  return items.length > 0 ? `修复并通过: ${items.join('; ')}` : 'Fix successful. All tests now pass.';
}

/**
 * gate-check 逐门禁行解析（阶段 2 FlowRegistry 差分模式消费）。
 *
 * 输出契约（gate-check.mjs:198/:219）：
 *   门禁行   "[PASS] G0: <detail>"          —— 行首无缩进
 *   质量行   "  [PASS] G0-Quality: <detail>" —— 恰好两格缩进
 *   账本行   "  [LEDGER] G0 ..."             —— 前缀 [LEDGER]，天然不匹配上两条
 * 返回 {gates, quality} 两个 Record；无匹配行（如 config 缺失的致命路径）两者皆空。
 */
export interface ParsedGateSide {
  pass: boolean;
  detail: string;
}

export function parseGateLines(result: ScriptOutput): {
  gates: Record<string, ParsedGateSide>;
  quality: Record<string, ParsedGateSide>;
} {
  const gates: Record<string, ParsedGateSide> = {};
  const quality: Record<string, ParsedGateSide> = {};
  for (const m of result.stdout.matchAll(/^\[(PASS|FAIL)\] (G[0-3]): (.+)$/gm)) {
    gates[m[2] ?? ''] = { pass: m[1] === 'PASS', detail: m[3] ?? '' };
  }
  for (const m of result.stdout.matchAll(/^ {2}\[(PASS|FAIL)\] (G[0-3])-Quality: (.+)$/gm)) {
    quality[m[2] ?? ''] = { pass: m[1] === 'PASS', detail: m[3] ?? '' };
  }
  return { gates, quality };
}
