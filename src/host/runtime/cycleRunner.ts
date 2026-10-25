/**
 * Cycle 生命周期管理（F8，M2-a）。
 *
 * initCycle → 创建 .cycles/cycle-N/ 结构 + 宏观相位重置为 plan
 * advanceCycle → 状态机推进 + 账本追加
 * closeCycle → 最终门禁检查 + 按门禁账本推进宏观相位
 *
 * cycle-78 WS-A（全生命周期缺口）：宏观 6 相此前是死的——`initCycle` 只建目录、
 * `closeCycle` 只查 workflow-graph 状态机与账本有效性，**从不碰 `.cycles/workflow-state.json`
 * 的 currentPhase**，也没有任何自举链调用 `anic_flows_advance`。结果：L4 自举循环
 * 跑完 77 轮，状态机仍显示"构建中"（真实工作区 currentPhase=build 恒不变）。
 * 现在两条写路径补齐：init 归零到 plan、close 在全门禁 PASS 时按引擎守卫逐相推进。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadLedger, appendEntry, verifyLedger, type LedgerEntry } from './ledger.ts';
import { loadWorkflowGraph, loadState, initState, advance, checkStrict, type WorkflowGraph, type NodeState } from './stateMachine.ts';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { initMacroState, loadMacroState, readGateResults, type MacroStateFile } from '../flows/macroPhaseEngine.ts';
import { advancePhasesOnClose, phaseNoAdvance, type PhaseAdvanceReport } from './cyclePhaseAdvance.ts';

export type { PhaseAdvanceReport } from './cyclePhaseAdvance.ts';

export interface CycleInfo {
  cycleDir: string;
  cycleNumber: number;
  createdAt: string;
}

export interface AdvanceResult {
  ok: boolean;
  cycleNumber: number;
  nodeId: string;
  state: Record<string, NodeState>;
  ledgerEntry?: LedgerEntry;
  reason?: string;
}

/** close 结果：既有三字段原样保留 + 相位推进报告（只增字段，消费端零破坏）。 */
export interface CloseResult extends PhaseAdvanceReport {
  ok: boolean;
  gatesPassed: boolean;
  ledgerValid: boolean;
  reason?: string;
  /**
   * 门禁账本四门（G0-G3）是否**全部**有 PASS 记录——与 `gatesPassed` 是**两个证据源**：
   * `gatesPassed` = workflow-graph 节点级 strict check（play 协议），本字段 = 门禁账本
   * （自举协议）。自举循环只跑门禁协议 ⇒ nodeStatus 长期为空 ⇒ `gatesPassed=false`
   * 而相位照常推进；把两者分开暴露，读者才不会把"节点账空"误读成"门禁没过"。
   */
  gatesLedgerPassed: boolean;
  /** 本次 close 采信的证据组合：both / workflow-graph / gate-ledger / none。 */
  closeEvidence: 'both' | 'workflow-graph' | 'gate-ledger' | 'none';
}

/** 列出已有 cycle 目录（数值序）。
 *
 * 布局对齐（cycle-16 真机暴露）：正典 cycle 目录在 `.cycles/cycles/cycle-N`
 * （技能 init-cycle.mjs 的写入位置；gateEngine.ts:55 / orgStatus.ts:33 /
 * macroPhaseEngine.ts:82 同款双跳）。旧实现只扫 `.cycles` 根——真实工作区
 * 永远空列表（cycle/list 在任何真机从未工作过；B1 时间线是第一个消费者才抓到）。
 * 同时兼容单跳布局（cycleRunner 自身 initCycle 写出的位置）：两处都扫，数值序合并。
 */
export function listCycles(cyclesDir: string): number[] {
  const nums: number[] = [];
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^cycle-(\d+)$/);
      if (m?.[1]) nums.push(parseInt(m[1], 10));
    }
  };
  scan(cyclesDir); // 旧单跳布局（兼容）
  scan(join(cyclesDir, 'cycles')); // 正典双跳布局（技能正典）
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** 取下一个 cycle 编号（max+1，不靠字典序）。 */
export function nextCycleNumber(cyclesDir: string): number {
  const nums = listCycles(cyclesDir);
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/** 初始化新 cycle（正典双跳布局 .cycles/cycles/cycle-N，与技能 init-cycle.mjs 对齐）。 */
export function initCycle(cyclesDir: string, projectName?: string): CycleInfo {
  const canonical = join(cyclesDir, 'cycles');
  const n = nextCycleNumber(cyclesDir);
  const cycleDir = join(canonical, `cycle-${n}`);
  const now = new Date().toISOString();

  // 创建标准子目录（不创建空目录的空目录——只创有内容的）
  for (const sub of ['test-reports', 'gates']) {
    mkdirSync(join(cycleDir, sub), { recursive: true });
  }

  // 写 cycle 元数据
  writeFileSync(
    join(cycleDir, 'cycle-meta.json'),
    JSON.stringify({ cycleNumber: n, projectName: projectName ?? 'unnamed', createdAt: now }, null, 2),
  );

  // 宏观相位归零到新循环的 plan（cycle-78 WS-A 写路径一）。
  resetPhaseForNewCycle(cyclesDir, `cycle-${n}`, now);

  return { cycleDir, cycleNumber: n, createdAt: now };
}

/** 把宏观相位重置为新循环的 plan（initCycle 成功后调用）。
 *
 * 被守卫缺陷：initCycle 此前只建目录，`.cycles/workflow-state.json` 的 currentPhase
 * 永远停在上一循环（真实工作区 cycle-77 已收口仍显示 build）——自举链没有任何一环
 * 写相位，于是"阶段流转"是死的。
 * 复用 macroPhaseEngine 的 loadMacroState/initMacroState + 原子写（半写状态文件会
 * 让下次启动解析失败）；currentCycle 同步到新号；phaseHistory 追加一条结构化留痕
 * （note='cycle-init'），exitedAt 取**真实当前时间**——旧相确实在此刻退出，既不伪造
 * 历史时刻，也不给尚未开始的新相（plan）写 exitedAt。首次建状态（无旧文件）不追加，
 * 因为没有相真的退出过（不伪造）。
 */
function resetPhaseForNewCycle(cyclesDir: string, cycleName: string, now: string): void {
  // closeCycle/initCycle 只拿到 `.cycles` 目录：workspaceRoot 只能由 dirname 反推
  // （macroPhaseEngine 的状态路径固定为 <root>/.cycles/workflow-state.json）。
  const workspaceRoot = dirname(cyclesDir);
  const prev = loadMacroState(workspaceRoot);
  const state: MacroStateFile = prev ?? initMacroState(workspaceRoot);
  if (prev) {
    state.phaseHistory = [
      ...state.phaseHistory,
      { phase: prev.currentPhase, exitedAt: now, note: 'cycle-init' },
    ];
  }
  state.currentPhase = 'plan';
  state.currentCycle = cycleName;
  state.updatedAt = now;
  atomicWriteFileSync(join(cyclesDir, 'workflow-state.json'), JSON.stringify(state, null, 2));
}

/** 推进 cycle 节点（状态机 + 账本）。
 *
 * 迁移合法性矩阵 #2（cycle-40，doc18 §3 #8 收口 5/5）：哈希链校验。
 * record 携带门禁证据（gate + result，将被追加账本）时，先验证既有链完整性——
 * 链断即拒绝推进（fail-closed）：账本是门禁证据的唯一载体，往断链上追加
 * 新记录等于把新证据接到不可信的链上，且状态推进的「批准依据」本身已不可信。
 * 拒绝时状态原样不动（磁盘 workflow-state.json 未被触碰）。
 */
export function advanceCycle(
  cyclesDir: string,
  cycleNumber: number,
  nodeId: string,
  record: { gateApproved?: boolean; gate?: string; gateName?: string; result?: 'PASS' | 'FAIL'; detail?: string },
): AdvanceResult {
  const graph = loadWorkflowGraph(cyclesDir);
  if (!graph) return { ok: false, cycleNumber, nodeId, state: {}, reason: 'no workflow-graph.yaml' };

  let state = loadState(cyclesDir);
  if (Object.keys(state).length === 0) state = initState(graph);

  // 矩阵 #2：账本断链时拒绝推进（只在将要追加账本记录时检查——纯状态推进不读账本）
  if (record.gate && record.result) {
    const verify = verifyLedger(cyclesDir);
    if (!verify.ok) {
      return {
        ok: false,
        cycleNumber,
        nodeId,
        state,
        reason: `ledger chain broken at index ${verify.brokenAt} (${verify.reason}) — repair before advancing`,
      };
    }
  }

  const adv = advance(graph, state, nodeId, record);
  if (!adv.ok) return { ok: false, cycleNumber, nodeId, state: adv.state, reason: adv.reason };

  // 如果是 gate 节点且有 result，追加账本
  let ledgerEntry: LedgerEntry | undefined;
  if (record.gate && record.result) {
    ledgerEntry = appendEntry(cyclesDir, {
      gate: record.gate,
      gateName: record.gateName ?? record.gate,
      result: record.result,
      detail: record.detail ?? '',
    });
  }

  // 持久化状态（相位字段保全，cycle-78 WS-A）：旧实现只写 `{nodeStatus}`，会把同一
  // 文件里的 currentPhase/phaseHistory（宏观引擎的正典字段）整段抹掉——节点推进一次，
  // 刚重置的相位就退回 plan。状态文件是单一真源，节点账与相位账必须共存。
  const prevMacro = loadMacroState(dirname(cyclesDir));
  const payload = prevMacro
    ? { ...prevMacro, nodeStatus: adv.state, updatedAt: new Date().toISOString() }
    : { nodeStatus: adv.state };
  writeFileSync(join(cyclesDir, 'workflow-state.json'), JSON.stringify(payload, null, 2));

  return { ok: true, cycleNumber, nodeId, state: adv.state, ledgerEntry };
}

/** 关闭 cycle：严格门禁检查 + 账本验证 + 按门禁账本推进宏观相位。 */
export function closeCycle(cyclesDir: string, _cycleNumber: number): CloseResult {
  // 同 resetPhaseForNewCycle：只拿到 `.cycles` 目录，workspaceRoot 由 dirname 反推。
  const workspaceRoot = dirname(cyclesDir);
  // 两个证据源在**任何**返回路径上都要齐（缺失 graph 也要报告账本事实，否则读者只能猜）。
  const ledgerGates = readGateResults(workspaceRoot).passed;
  const gatesLedgerPassed = ['G0', 'G1', 'G2', 'G3'].every((g) => ledgerGates.includes(g));
  const graph = loadWorkflowGraph(cyclesDir);
  if (!graph) {
    return {
      ...phaseNoAdvance(workspaceRoot, 'workflow-graph.yaml', 'no workflow-graph.yaml — phase not advanced (zero writes)'),
      ok: false,
      gatesPassed: false,
      ledgerValid: false,
      gatesLedgerPassed,
      closeEvidence: gatesLedgerPassed ? 'gate-ledger' : 'none',
      reason: 'no workflow-graph.yaml',
    };
  }

  const state = loadState(cyclesDir);
  const check = checkStrict(graph, state);
  const verify = verifyLedger(cyclesDir);
  const phase = advancePhasesOnClose(workspaceRoot);

  return {
    ...phase,
    ok: check.ok && verify.ok,
    gatesPassed: check.ok,
    ledgerValid: verify.ok,
    gatesLedgerPassed,
    closeEvidence: check.ok && gatesLedgerPassed ? 'both' : check.ok ? 'workflow-graph' : gatesLedgerPassed ? 'gate-ledger' : 'none',
    reason: !check.ok ? check.reason : !verify.ok ? (verify.reason ?? undefined) : undefined,
  };
}
