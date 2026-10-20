/**
 * Cycle 生命周期管理（F8，M2-a）。
 *
 * initCycle → 创建 .cycles/cycle-N/ 结构
 * advanceCycle → 状态机推进 + 账本追加
 * closeCycle → 最终门禁检查
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLedger, appendEntry, verifyLedger, type LedgerEntry } from './ledger.ts';
import { loadWorkflowGraph, loadState, initState, advance, checkStrict, type WorkflowGraph, type NodeState } from './stateMachine.ts';

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

  return { cycleDir, cycleNumber: n, createdAt: now };
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

  // 持久化状态
  writeFileSync(join(cyclesDir, 'workflow-state.json'), JSON.stringify({ nodeStatus: adv.state }, null, 2));

  return { ok: true, cycleNumber, nodeId, state: adv.state, ledgerEntry };
}

/** 关闭 cycle：严格门禁检查 + 账本验证。 */
export function closeCycle(cyclesDir: string, _cycleNumber: number): {
  ok: boolean;
  gatesPassed: boolean;
  ledgerValid: boolean;
  reason?: string;
} {
  const graph = loadWorkflowGraph(cyclesDir);
  if (!graph) return { ok: false, gatesPassed: false, ledgerValid: false, reason: 'no workflow-graph.yaml' };

  const state = loadState(cyclesDir);
  const check = checkStrict(graph, state);
  const verify = verifyLedger(cyclesDir);

  return {
    ok: check.ok && verify.ok,
    gatesPassed: check.ok,
    ledgerValid: verify.ok,
    reason: !check.ok ? check.reason : !verify.ok ? (verify.reason ?? undefined) : undefined,
  };
}
