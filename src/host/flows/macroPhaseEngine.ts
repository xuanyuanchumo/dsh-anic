/**
 * macroPhaseEngine —— 6 阶段宏观循环引擎（R3 阶段 3）。
 *
 * 逐字对齐技能 scripts/workflow-state.mjs：
 *  - PHASES 表（:17-28）：plan(G0)/design(G0)/build(G1)/test(G2)/deploy(G3)/maintain()
 *  - cmdAdvance（:173-231）：只许前向、末相免检、当前相门禁全绿才放行
 *  - getGateResults（:99-110）：**曾通过**语义 —— 账本任一历史 PASS 即算
 *    （与 gateEvidence.latestConvergenceVerdicts 的「每门最新」语义不同，
 *    差异是刻意的：advance 守卫按技能原语义，不偷偷收紧）
 *  - saveState：v1.8.3 原子写（半写状态文件会让下次启动解析失败）
 *
 * 与 macroPhaseFlow.ts（状态机层）的分界：本文件 = 「推进规则与状态文件 IO」；
 * 那边 = 「推进如何进 FlowRegistry/投影/事件」。
 */
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';

export interface MacroPhase {
  id: string;
  name: string;
  gates: string[];
}

/** 六相表（与技能 PHASES 逐字同表；name 含中文全角括号，账本/消息字段一致）。 */
export const PHASES: ReadonlyArray<MacroPhase> = [
  { id: 'plan', name: 'Plan（规划）', gates: ['G0'] },
  { id: 'design', name: 'Design（设计）', gates: ['G0'] },
  { id: 'build', name: 'Build（构建）', gates: ['G1'] },
  { id: 'test', name: 'Test（测试）', gates: ['G2'] },
  { id: 'deploy', name: 'Deploy（部署）', gates: ['G3'] },
  { id: 'maintain', name: 'Maintain（维护）', gates: [] },
];

export const PHASE_IDS: ReadonlyArray<string> = PHASES.map((p) => p.id);

/** 相位历史条目。
 *
 * 被守卫缺陷（cycle-78 WS-A）：旧类型把 `phase`/`exitedAt` 声明为必填，但真实
 * `.cycles/workflow-state.json` 的历史条目是**人工/脚本混合写入**的（如
 * `{note:'cycle-75 收口…', at:…}`，没有 phase/exitedAt）。loadMacroState 原样透传
 * 数组，于是类型声明与磁盘事实不符——initCycle 想在条目里加 `note` 时被类型挡住。
 * 修法：条目字段全部可选并补上 note/detail/at，磁盘上有什么就承认什么（不伪造）。
 */
export interface PhaseHistoryEntry {
  phase?: string;
  exitedAt?: string;
  note?: string;
  detail?: string;
  at?: string;
}

export interface MacroStateFile {
  currentPhase: string;
  currentCycle: string | null;
  phaseHistory: PhaseHistoryEntry[];
  nodeStatus: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const STATE_PATH = join('.cycles', 'workflow-state.json');

/** 读 `.cycles/workflow-state.json`（缺失/损坏/形状不对 → null，不部分采信）。 */
export function loadMacroState(workspaceRoot: string): MacroStateFile | null {
  const p = join(workspaceRoot, STATE_PATH);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<MacroStateFile>;
    if (typeof raw.currentPhase !== 'string') return null;
    return {
      currentPhase: raw.currentPhase,
      currentCycle: typeof raw.currentCycle === 'string' ? raw.currentCycle : null,
      phaseHistory: Array.isArray(raw.phaseHistory) ? raw.phaseHistory : [],
      nodeStatus: raw.nodeStatus && typeof raw.nodeStatus === 'object' ? raw.nodeStatus as Record<string, unknown> : {},
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

/** 数值序列出 cycle 目录名（cycle-10 > cycle-9；技能 v1.8.3 同款修复）。 */
export function listCycleNames(cyclesDir: string): string[] {
  if (!existsSync(cyclesDir)) return [];
  try {
    return readdirSync(cyclesDir)
      .filter((n) => /^cycle-(\d+)$/.test(n))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  } catch {
    return [];
  }
}

/** 初始状态（技能 initState:52-64 语义：当前相恒 plan，cycle 取最新）。 */
export function initMacroState(workspaceRoot: string): MacroStateFile {
  const names = listCycleNames(join(workspaceRoot, '.cycles', 'cycles'));
  const now = new Date().toISOString();
  return {
    currentPhase: 'plan',
    currentCycle: names.length > 0 ? names[names.length - 1] ?? null : null,
    phaseHistory: [],
    nodeStatus: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** 账本门结果（技能 getGateResults:99-110 语义：曾 PASS/曾 FAIL 两个名单）。 */
export function readGateResults(workspaceRoot: string): { passed: string[]; failed: string[] } {
  const p = join(workspaceRoot, '.cycles', 'gates', 'ledger.json');
  if (!existsSync(p)) return { passed: [], failed: [] };
  try {
    // 技能读 ledger.entries（包裹形态）；native 侧额外容忍裸数组（防御，不改判定）
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as
      | { entries?: Array<{ gate?: unknown; result?: unknown }> }
      | Array<{ gate?: unknown; result?: unknown }>;
    const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
    const named = entries.filter(
      (e): e is { gate: string; result: string } => typeof e.gate === 'string' && typeof e.result === 'string',
    );
    return {
      passed: named.filter((e) => e.result === 'PASS').map((e) => e.gate),
      failed: named.filter((e) => e.result === 'FAIL').map((e) => e.gate),
    };
  } catch {
    return { passed: [], failed: [] };
  }
}

export interface AdvanceOutcome {
  ok: boolean;
  /** 技能逐字消息（成功 = `Advanced from X to Y.`；失败 = stderr 首行）。 */
  message: string;
  exitCode: 0 | 1;
  from?: string;
  to?: string;
  /** 下一相待过门（maintain 为空数组）。 */
  nextGates?: string[];
  /** 末相再推进（技能 exit 0、零写入）。 */
  final?: boolean;
  /** 守卫未过时：卡住的门 + 已过门名单（技能 stderr 第二行素材）。 */
  gate?: string;
  passedGates?: string;
  dryRun?: boolean;
}

/**
 * 宏观相位推进（技能 cmdAdvance:173-231 全语义）。
 * 失败路径零写入（技能同款：state 缺失时 init 但不落盘，推进成功才 save）。
 */
export function advanceMacro(
  workspaceRoot: string,
  target?: string,
  opts: { dryRun?: boolean } = {},
): AdvanceOutcome {
  const state = loadMacroState(workspaceRoot) ?? initMacroState(workspaceRoot);
  const currentIdx = PHASES.findIndex((p) => p.id === state.currentPhase);
  if (currentIdx === -1) {
    return { ok: false, message: `Invalid current phase: ${state.currentPhase}`, exitCode: 1 };
  }

  let nextIdx: number;
  if (target) {
    nextIdx = PHASES.findIndex((p) => p.id === target);
    if (nextIdx === -1) {
      return { ok: false, message: `Unknown phase: ${target}. Valid phases: ${PHASE_IDS.join(', ')}`, exitCode: 1 };
    }
  } else {
    nextIdx = currentIdx + 1;
  }

  if (nextIdx <= currentIdx) {
    return {
      ok: false,
      message: `Cannot advance backwards or to same phase. Current: ${state.currentPhase}, Target: ${PHASES[nextIdx]?.id ?? target}`,
      exitCode: 1,
    };
  }
  if (nextIdx >= PHASES.length) {
    // 技能语义：末相再推进不是错误（exit 0、零写入）
    return {
      ok: true,
      final: true,
      from: PHASES[currentIdx]!.id,
      message: `Already at final phase (${PHASES[currentIdx]!.name}). No more phases to advance.`,
      nextGates: [],
      exitCode: 0,
    };
  }

  const currentPhase = PHASES[currentIdx]!;
  const nextPhase = PHASES[nextIdx]!;
  const gateResults = readGateResults(workspaceRoot);
  for (const g of currentPhase.gates) {
    if (!gateResults.passed.includes(g)) {
      return {
        ok: false,
        message: `Cannot advance: gate ${g} for phase ${currentPhase.name} has not passed.`,
        exitCode: 1,
        gate: g,
        passedGates: gateResults.passed.join(', ') || 'none',
      };
    }
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      from: currentPhase.id,
      to: nextPhase.id,
      message: `Advanced from ${currentPhase.name} to ${nextPhase.name}.`,
      nextGates: nextPhase.gates,
      exitCode: 0,
    };
  }

  state.phaseHistory.push({ phase: state.currentPhase, exitedAt: new Date().toISOString() });
  state.currentPhase = nextPhase.id;
  state.updatedAt = new Date().toISOString();
  const cyclesDir = join(workspaceRoot, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  atomicWriteFileSync(join(cyclesDir, 'workflow-state.json'), JSON.stringify(state, null, 2));

  return {
    ok: true,
    from: currentPhase.id,
    to: nextPhase.id,
    message: `Advanced from ${currentPhase.name} to ${nextPhase.name}.`,
    nextGates: nextPhase.gates,
    exitCode: 0,
  };
}
