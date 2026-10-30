/**
 * 流程归属解析（cycle-89 · 从 flowTracker.ts 拆出，守 T3 ≤250 行）。
 *
 * 解析 cycle/phase/gate 归属：读 workflow-state.json + ledger.json 链头，
 * 取不到写 source:'none'，绝不编造。纯 IO，不写盘。
 *
 * ## ⚠️ cycle-89 修正：gate 归属**不能**取账本链头
 *
 * 原实现用「账本最后一条的 gate」当本次流程的门禁归属。这是**错的**，实测反例：
 * 一次 `workflow-state check` 被记成 `gate:'G3'` —— 因为账本链头恰好是上一次
 * 跑门禁留下的 G3 记录。后果不是「多了一个字段」，而是**门禁证据覆盖指标永久假绿**：
 * 任意流程都会被算成「有 G3 证据」，用户看到的量化条毫无意义。
 *
 * 更糟的是**来源标注与字段实际出处不一致**：那个 gate 字段来自 ledger，
 * 而 `attribution.source` 却写着 `'workflow-state'` —— 两套真相同时失真。
 *
 * 修正后的判据（三条，缺一不可）：
 *
 * 1. **gate 只由「这次流程本身在跑哪道门禁」决定**，由脚本语义判定，
 *    **绝不**从「最近跑过哪道门禁」推断。后者是历史残留，不是本次事实。
 * 2. **来源标注必须与字段实际出处一致**：cycle/phase 来自 workflow-state →
 *    source='workflow-state'；gate 来自脚本语义 → 单独用 `gateSource` 标注，
 *    不再混进一个笼统的 source 字段里。
 * 3. **不回填历史**：旧记录没有 attribution 就是没有，如实计入孤儿。
 *    拿现在的 workflow-state 去回填旧记录，是把「看的时候的坐标」钉到
 *    「发生时的记录」上 —— 最坏的伪造。
 */
import { join } from 'node:path';
import { safeReadFileSync } from '../../shared/fs-safe.ts';
import type { FlowAttribution } from './flowTracker.ts';

/** 归属解析结果（三字段皆可缺——缺就是不落字段）。 */
export interface ResolvedFlowAttribution {
  cycle?: string;
  phase?: string;
  gate?: string;
  attribution: FlowAttribution;
}

/**
 * **门禁脚本白名单**：只有这些脚本本身在执行门禁，才配门禁归属。
 *
 * 为什么是白名单而不是黑名单：门禁种类（G0-G3 / H1-H4）是**闭合集合**，
 * 新增一个门禁脚本时若用黑名单，它会默认「有门禁归属」而实际上是别的门；
 * 白名单则默认「无归属」—— 宁缺勿猜（INV-27 诚实标注纪律）。
 *
 * `gate-check` 可带 `--gate G0` / `--gate H2` 等参数，具体是哪一道**由参数决定**；
 * 查不到参数时保守落 `G0`（评估基线门是所有门禁的入口，见 skills/gate-check 语义）。
 */
const GATE_SCRIPT_NAMES: ReadonlySet<string> = new Set(['gate-check']);

/**
 * 门禁脚本白名单（**对外导出**，供跨层对账用）。
 *
 * ## 为什么导出
 *
 * 这份白名单在**三处**各有一份声明（runtime 写入侧 / `flowGateSemantics` 指标侧 /
 * 客户端消费侧）。client 不能 import host（两条独立发版链），所以「同语义、两实现」
 * 是刻意的 —— 但**漂移**是真实风险：改了 runtime 的门禁脚本名而没改指标侧，
 * 归属数据照写、指标口径静默偏，「门禁证据覆盖」再次假绿且**无任何报错**。
 *
 * ⇒ 用**对账测试**代替共享代码来消除漂移：
 * `tests/unit/gateWhitelistReconcile.test.ts` 把三份声明钉成同一张表。
 *
 * 语义上它等于 `GATE_SCRIPT_NAMES ∪ HITL_SCRIPT_NAMES`（两个都是门禁执行器）。
 */
export const GATE_EVIDENCE_SCRIPT_NAMES: ReadonlySet<string> = new Set(['gate-check', 'hitl-audit']);

/** HITL 审计脚本：产出 H1-H4 的人审门证据。 */
const HITL_SCRIPT_NAMES: ReadonlySet<string> = new Set(['hitl-audit']);

/** 非空字符串才采信（其余 = 不可知）。 */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 读 `.cycles/workflow-state.json` 头部：currentCycle / currentPhase。 */
function readWorkflowStateHead(cyclesDir: string): { cycle?: string; phase?: string } {
  try {
    const raw = safeReadFileSync(join(cyclesDir, 'workflow-state.json'));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { currentCycle?: unknown; currentPhase?: unknown } | null;
    return { cycle: asNonEmptyString(parsed?.currentCycle), phase: asNonEmptyString(parsed?.currentPhase) };
  } catch {
    return {};
  }
}

/**
 * 由**脚本语义 + 调用参数**判定门禁归属（不使用账本链头）。
 *
 * `gate-check --gate G2` → 'G2'；`gate-check`（无参/--gate all）→ 'G0'
 * （评估基线是所有收敛门的入口）；`hitl-audit --gate H2` → 'H2'。
 * 非门禁脚本 → undefined（**不落字段**）。
 */
export function gateOfScript(script: string, args: readonly string[]): string | undefined {
  if (GATE_SCRIPT_NAMES.has(script)) {
    const idx = args.indexOf('--gate');
    const explicit = idx >= 0 ? asNonEmptyString(args[idx + 1]) : undefined;
    if (explicit !== undefined && /^[GH][0-4]$/.test(explicit)) return explicit;
    return 'G0';
  }
  if (HITL_SCRIPT_NAMES.has(script)) {
    const idx = args.indexOf('--gate');
    const explicit = idx >= 0 ? asNonEmptyString(args[idx + 1]) : undefined;
    if (explicit !== undefined && /^H[1-4]$/.test(explicit)) return explicit;
    return 'H1';
  }
  return undefined;
}

/**
 * 解析当前流程的 cycle/phase/gate 归属。
 *
 * 优先级：workflow-state.json（cycle/phase）+ **脚本语义**（gate）。
 * 任一取不到 → 该字段不落（`undefined`），`attribution.source` 标出来源。
 * **绝不编造**：三个字段全取不到 → `source:'none'`，不猜一个好看的默认值。
 */
export function resolveFlowAttribution(
  cyclesDir: string,
  at?: string,
  script?: string,
  args?: readonly string[],
): ResolvedFlowAttribution {
  const now = at ?? new Date().toISOString();
  const ws = readWorkflowStateHead(cyclesDir);
  const gate = script === undefined ? undefined : gateOfScript(script, args ?? []);
  const hasAny = ws.cycle !== undefined || ws.phase !== undefined || gate !== undefined;
  return {
    cycle: ws.cycle,
    phase: ws.phase,
    gate,
    attribution: { at: now, source: hasAny ? 'workflow-state' : 'none' },
  };
}
