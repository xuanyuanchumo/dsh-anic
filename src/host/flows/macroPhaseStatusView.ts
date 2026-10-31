/**
 * 宏观相位的**只读视图**（cycle-96 WS-A：从 `macroPhaseFlow.ts` 下移，守 T3 ≤250 行）。
 *
 * ## 为什么单独成文件（职责，不是行数）
 *
 * 这个文件回答的是「**当前相位到底读作什么**」——它把两个口径并列摆出来：
 *   - `stored`   磁盘 `.cycles/workflow-state.json` 的 `currentPhase`（写者 = advance）
 *   - `inferred` 当前循环工件推断出的相位（= 技能 `workflow-state.mjs` 的 inferPhase）
 *
 * 两者不一致就是 `drift`。把「两个口径互相漂移」的判定与「状态机怎么推进」放在
 * 同一文件，会让读代码的人误以为查询会顺手校正其中一方 —— 而这正是本文件存在的
 * 理由：**查询不写盘**。回写只发生在 `advance`（`runMacroPhaseFlow` 的写动作）与
 * 技能侧 `cmdAdvance`。
 *
 * ## 被修缺陷（cycle-96 实测）
 *
 * 技能 `workflow-state.mjs` 的 `cmdStatus` 曾把 `inferPhase(artifacts)` **写回**
 * `state.currentPhase` 并落盘：查一次状态就改掉了被观察的状态（Lead 复现：
 * 强置 plan → 跑 status → 磁盘变成 test）。宿主侧这条纪律本来就对（本文件从
 * `macroPhaseFlow.ts` 继承的头注原文「不落盘、不执行 inferPhase 回写」），
 * 缺的是**把推断值也读出来给用户看** —— 只报 stored 时，「状态文件没跟上工件」
 * 这件事在面板上完全不可见。
 *
 * ## 推断的**能力上限**（必须如实讲，否则 drift 会变成假警报）
 *
 * `inferPhase` 只有 4 个可达结论：plan / design / build / test（判据是
 * eval/plan/tasks/testReports 四类工件的存在性）。**deploy / maintain 推不出来**：
 * 部署与维护没有对应的「工件指纹」，所以 advanced 到 deploy/maintain 之后
 * `inferred` 一定停在 test。那种 drift **不是**状态文件错了，而是推断器到顶了
 * —— 故本视图同时返回 `inferenceCeiling: 'test'`，让消费方能区分
 * 「真分叉」与「推断上限」。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PHASES, readGateResults, type MacroStateFile } from './macroPhaseEngine.ts';

/** 与技能 `getCycleArtifacts` 逐项同表（文件名 → 语义键）。 */
const ARTIFACT_FILES: ReadonlyArray<readonly [string, string]> = [
  ['项目评估报告.md', 'eval'],
  ['当前循环总规划.md', 'plan'],
  ['任务清单.md', 'tasks'],
  ['当前循环页面状态.md', 'pageState'],
  ['审计日志.md', 'audit'],
  ['交付清单.md', 'delivery'],
  ['非功能验证报告.md', 'nonFunc'],
];

/** 当前循环的工件在场性（技能同款：目录不存在 ⇒ 空表，不猜）。 */
export function readCycleArtifacts(workspaceRoot: string, cycle: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!cycle) return out;
  const cyclePath = join(workspaceRoot, '.cycles', 'cycles', cycle);
  if (!existsSync(cyclePath)) return out;
  for (const [filename, key] of ARTIFACT_FILES) out[key] = existsSync(join(cyclePath, filename));
  const testDir = join(cyclePath, 'test-reports');
  // 与技能一致：只有**非空**的 test-reports（含 .md）才算测试工件。
  // 空目录是「建了目录还没写报告」，判成 test 会把 build 阶段提前顶到 test。
  out['testReports'] = existsSync(testDir)
    && readdirSync(testDir).filter((e) => e.endsWith('.md')).length > 0;
  return out;
}

/**
 * 工件 → 相位（技能 `inferPhase` 逐字同款）。
 *
 * 为什么不「顺手改进」推断规则：两侧必须可对账。一旦宿主侧比技能侧更聪明，
 * 同一工作区会出现「脚本说 A、宿主说 B」的第二次分叉（正是本轮要消灭的那类缺陷）。
 * 改进应改在技能侧，两处一起动。
 */
export function inferMacroPhaseFromArtifacts(artifacts: Record<string, boolean>): string {
  if (artifacts['eval'] && !artifacts['plan']) return 'plan';
  if (artifacts['plan'] && !artifacts['tasks']) return 'design';
  if (artifacts['tasks'] && !artifacts['testReports']) return 'build';
  if (artifacts['testReports']) return 'test';
  return 'plan';
}

/** 推断器可达的最高相（deploy/maintain 没有工件指纹，见文件头注）。 */
export const INFERENCE_CEILING = 'test';

/** 只读状态视图的响应体（`GET /anic/flows/macro-phase/status` 的唯一生产者）。 */
export interface MacroPhaseStatusView {
  flowId: 'macro-phase';
  /** 磁盘事实（advance 写的那个值）。字段名保持向后兼容。 */
  currentPhase: string | null;
  phaseName: string | null;
  /** 工件推断的读数（只展示，永不落盘）。 */
  inferredPhase: string | null;
  /** stored !== inferred。null = 无状态文件（无从比较，不判分叉）。 */
  drift: boolean | null;
  /** 推断器上限；drift 落在 ceiling 及之后时属「推断到顶」而非真分叉。 */
  inferenceCeiling: string;
  currentCycle: string | null;
  phaseHistoryLength: number;
  gates: Array<{ gate: string; status: 'PASS' | 'FAIL' | 'PENDING' }>;
  projectionSeeded: boolean;
  /** 本次视图是否**曾**写盘（恒 false；字段存在的意义是让「不写盘」可被断言）。 */
  wroteState: false;
}

/**
 * 只读状态视图（cmdStatus 的投影面；不落盘、不执行 inferPhase 回写）。
 *
 * @param state 已由调用方读好的状态（`loadMacroState` 的结果，缺失即 null）。
 *   为什么不在这里自己读：路由层已经读过一次，二次读盘在「读与写之间」的窗口里
 *   可能拿到不同的两份事实（同一响应里 stored 与 cycle 自相矛盾）。
 */
export function buildMacroPhaseStatus(
  workspaceRoot: string,
  state: MacroStateFile | null,
): MacroPhaseStatusView {
  const gateResults = readGateResults(workspaceRoot);
  const stored = state?.currentPhase ?? null;
  const phase = PHASES.find((p) => p.id === stored) ?? null;
  // 无状态文件 ⇒ 没有 currentCycle ⇒ 无从推断 ⇒ inferred 为 null（不是 'plan'）。
  // 这里**故意**与技能侧不同：技能在无状态时用内存缺省 'plan' 参与比较，
  // 但宿主没有任何「已经存在的状态」可比较，报 null 才是如实（不伪造 plan）。
  const inferred = state === null
    ? null
    : inferMacroPhaseFromArtifacts(readCycleArtifacts(workspaceRoot, state.currentCycle));
  return {
    flowId: 'macro-phase',
    currentPhase: stored,
    phaseName: phase?.name ?? null,
    inferredPhase: inferred,
    drift: stored === null || inferred === null ? null : stored !== inferred,
    inferenceCeiling: INFERENCE_CEILING,
    currentCycle: state?.currentCycle ?? null,
    phaseHistoryLength: state?.phaseHistory.length ?? 0,
    gates: phase
      ? phase.gates.map((g) => ({
        gate: g,
        // 技能 cmdStatus 展示序：曾 PASS > 曾 FAIL > PENDING
        status: gateResults.passed.includes(g) ? 'PASS' : gateResults.failed.includes(g) ? 'FAIL' : 'PENDING',
      }))
      : [],
    projectionSeeded: state !== null,
    wroteState: false,
  };
}
