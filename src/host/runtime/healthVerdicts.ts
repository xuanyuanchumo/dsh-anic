/**
 * 负裁决判定（cycle-85 · O-84-01，从 continuousLearning 拆出）。
 *
 * ## 问题（真实误判）
 *
 * `gate-check` / `eval-runner` 的 `exit 1` 是**正常输出**——"门禁没过"正是它们的
 * 工作结果。此前一律按 `status==='FAILED'` 计入失败率，本仓实测读数是
 * `gate-check 近期成功率 25%`、`eval-runner 36%`，并建议"检查 stderr 定位失败原因"。
 * 守卫生效被读成工具宕机，污染健康等级、改进建议与基于 health 的熔断判据。
 *
 * ## 判据（fail-closed）
 *
 * 一条调用算「有效负裁决」需**同时**满足：
 *   1. 脚本在**显式白名单**内（裁决类脚本）；
 *   2. `status==='FAILED'` 且 `exitCode===1`（2+ 视为异常退出）；
 *   3. stdout 非空且含**结构化裁决标记**；
 *   4. stderr 不含崩溃特征（MODULE_NOT_FOUND / TypeError / …）。
 * 任一不满足 ⇒ 仍是故障。宁可多报一次失败，也不把真故障洗白。
 *
 * 纯函数、零 IO：输入一条 FlowRecord，输出五态分类。
 */
import type { FlowRecord } from './flowTracker.ts';

/**
 * 裁决类脚本白名单。
 *
 * 显式枚举而不是"看输出猜语义"：新脚本要享受该语义必须自己加进来，
 * 否则按普通脚本处理（fail-closed）。
 */
export const VERDICT_SCRIPTS: ReadonlySet<string> = new Set([
  'gate-check',
  'eval-runner',
  'hitl-audit',
  'multi-agent-gate',
  'fact-base-verify',
  'plan-sync-check',
  'band-detector',
]);

/** 负裁决的**结构化标记**（脚本自己在 stdout 打印的裁决行）。 */
export const VERDICT_MARKERS = /\[FAIL\]|\[TRIGGERED\]|dimension\(s\) failed|Gate check FAILED|circuit|BLOCKED/;

/** 崩溃特征（stderr）：出现即**不**算有效裁决（即使 stdout 恰好含裁决词）。 */
export const CRASH_MARKERS = /MODULE_NOT_FOUND|Cannot find module|ENOENT|SyntaxError|TypeError|ReferenceError|is not a function/;

/**
 * 单条调用的语义分类：
 * - `done`：退出 0；
 * - `verdict`：裁决类脚本给出了可解释的负裁决（正常工作）；
 * - `timeout`：超时（挂死，真故障）；
 * - `failed`：其它非零退出（真故障）；
 * - `pending`：尚未结束。
 */
export type FlowOutcomeClass = 'done' | 'verdict' | 'usage' | 'timeout' | 'failed' | 'pending';

/**
 * **调用方用法错误**的标记（cycle-88）。
 *
 * 与 `verdict` 的区别：负裁决是"工具正常工作并给出否定结论"，用法错误是
 * **调用方传错了参数**——两者都不是工具故障，但也不是同一件事：
 *   - verdict：工具对被测对象下了否定结论（gate-check 说门禁没过）；
 *   - usage：工具根本没开始工作（缺位置参数 / 未知旗标 / 非法取值）。
 *
 * 为什么要单列：本仓实测 `workflow-state` 被面板标成 degraded（近期 75%），
 * 而两次"失败"是 agent 自己少传了一个位置参数；`archive-cycle` 的 1 次失败同理。
 * 把调用方的失误记成设备故障，会让健康面持续显示"技能坏了"——用户看到的
 * 就是"很多技能健康问题"，而真相是**没人真的去查那两次到底发生了什么**。
 *
 * 判据仍是 fail-closed：必须 exit 1 **且** stderr 命中这些脚本自带的用法提示，
 * 才归为 usage；普通异常（缺模块/类型错误）永远算故障。
 */
export const USAGE_MARKERS = /只接受\s*\d+\s*个位置参数|未知旗标|必须提供|需要\s*--|Usage:\s*node\s/m;

export function classifyFlowOutcome(f: FlowRecord): FlowOutcomeClass {
  if (f.status === 'TIMEOUT') return 'timeout';
  if (f.status === 'INVOKING' || f.status === 'RUNNING') return 'pending';
  if (f.status === 'DONE') return 'done';
  if (f.status !== 'FAILED') return 'pending';
  // 用法错误优先于裁决/故障判定：脚本还没开始干活就被参数挡下了。
  // 只在 exit 1 + stderr 命中脚本自带用法提示时成立（fail-closed）。
  if (f.exitCode === 1 && USAGE_MARKERS.test(f.stderr ?? '')) return 'usage';
  if (!VERDICT_SCRIPTS.has(f.script)) return 'failed';
  if (f.exitCode !== 1) return 'failed';
  const out = f.stdout ?? '';
  const err = f.stderr ?? '';
  if (out.trim() === '') return 'failed';
  if (CRASH_MARKERS.test(err)) return 'failed';
  return VERDICT_MARKERS.test(out) || VERDICT_MARKERS.test(err) ? 'verdict' : 'failed';
}
