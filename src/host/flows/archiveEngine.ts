/**
 * R3 阶段 3 后半 — archive 引擎（L1 纯函数族）。
 *
 * 技能侧逐字对齐：scripts/archive-cycle.mjs（146 行，v1.8.3）。
 * 三条命令语义：--cycle N（归档一个已完成循环）/ --clean [--keep N]（清理旧归档）
 * / --list（清单）。
 *
 * 关键纪律（技能 :36-48 / :75-80 的两条注释是承重裁决）：
 * 1. isCycleComplete 与 gate-check G1 共用同一任务行解析器（本插件侧即
 *    flows/gateArtifacts.ts 的 parseTaskRows）——「G1 说完成、归档说没完成」
 *    分叉的根因就是两处判定各写一份。
 * 2. 归档只移动目录，永不触碰账本（INV-9 只追加哈希链；按 detail 删条目
 *    会让后续所有 previousHash 指向幽灵，verifyLedger 必报 CHAIN_BREAK）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listCycleNames } from './macroPhaseEngine.ts';
import { parseTaskRows } from './gateArtifacts.ts';

export interface CycleInventoryEntry {
  name: string;
  /** active 循环的任务完成态；archived 循环恒 null（清单不重算历史） */
  complete: boolean | null;
  /** 仅 archived 条目：归档时间（ISO 日期） */
  archivedAt?: string;
}

export interface CycleInventory {
  active: CycleInventoryEntry[];
  archived: CycleInventoryEntry[];
}

export type ArchiveAction =
  | { kind: 'archive'; cycle: number }
  | { kind: 'clean'; keep?: number }
  | { kind: 'list' };

export interface ArchiveOutcome {
  ok: boolean;
  action: ArchiveAction['kind'];
  /** 动作结果的人类可读消息（与技能 stdout 语义一致） */
  message: string;
  /** 归档/清理受影响的循环名 */
  affected: string[];
  inventory?: CycleInventory;
  error?: string;
}

function cyclesParent(workspaceRoot: string): string {
  return join(workspaceRoot, '.cycles');
}

/**
 * 循环完成判定 —— 与 G1 同解析器（gateArtifacts.parseTaskRows）。
 * total>0 且 pendingCount===0 才算完成；目录/清单缺失恒 false。
 */
export function isCycleComplete(workspaceRoot: string, cycleName: string): boolean {
  const cyclePath = join(cyclesParent(workspaceRoot), 'cycles', cycleName);
  if (!existsSync(cyclePath)) return false;
  const taskListPath = join(cyclePath, '任务清单.md');
  if (!existsSync(taskListPath)) return false;
  let text: string;
  try {
    text = readFileSync(taskListPath, 'utf-8');
  } catch {
    return false;
  }
  const rows = parseTaskRows(text);
  const pendingCount = rows.filter((r) => r[r.length - 1] !== '完成').length;
  return rows.length > 0 && pendingCount === 0;
}

/** 循环清单（active 带 complete 标注；archived 带归档日期）。 */
export function listCycleInventory(workspaceRoot: string): CycleInventory {
  const parent = cyclesParent(workspaceRoot);
  const active = listCycleNames(join(parent, 'cycles')).map((name) => ({
    name,
    complete: isCycleComplete(workspaceRoot, name),
  }));
  const archiveDir = join(parent, 'archive');
  const archived: CycleInventoryEntry[] = [];
  if (existsSync(archiveDir)) {
    for (const name of listCycleNames(archiveDir)) {
      const p = join(archiveDir, name);
      try {
        const mtime = statSync(p).mtime.toISOString().substring(0, 10);
        archived.push({ name, complete: null, archivedAt: mtime });
      } catch {
        archived.push({ name, complete: null });
      }
    }
  }
  return { active, archived };
}

/** 归档一个循环（--cycle N）。失败路径零文件系统写入。 */
export function archiveOneCycle(workspaceRoot: string, cycleNum: number): ArchiveOutcome {
  const cycleName = `cycle-${cycleNum}`;
  const cyclePath = join(cyclesParent(workspaceRoot), 'cycles', cycleName);
  if (!existsSync(cyclePath)) {
    return { ok: false, action: 'archive', message: `Cycle ${cycleName} not found.`, affected: [], error: `Cycle ${cycleName} not found.` };
  }
  if (!isCycleComplete(workspaceRoot, cycleName)) {
    const msg = `Cycle ${cycleName} has pending tasks. Complete all tasks before archiving.`;
    return { ok: false, action: 'archive', message: msg, affected: [], error: msg };
  }
  const archiveDir = join(cyclesParent(workspaceRoot), 'archive');
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, cycleName);
  if (existsSync(archivePath)) {
    const msg = `Cycle ${cycleName} already archived.`;
    return { ok: false, action: 'archive', message: msg, affected: [], error: msg };
  }
  renameSync(cyclePath, archivePath);
  return {
    ok: true,
    action: 'archive',
    message: `Archived ${cycleName} to ${archivePath} — ledger untouched (append-only hash chain, INV-9).`,
    affected: [cycleName],
  };
}

/** 清理旧归档（--clean [--keep N]，默认 keep 5 —— 技能 :14 同值）。 */
export function cleanOldArchives(workspaceRoot: string, keepCount = 5): ArchiveOutcome {
  const archiveDir = join(cyclesParent(workspaceRoot), 'archive');
  if (!existsSync(archiveDir)) {
    return { ok: true, action: 'clean', message: 'No archive directory.', affected: [] };
  }
  const archived = listCycleNames(archiveDir);
  if (archived.length <= keepCount) {
    return { ok: true, action: 'clean', message: `Only ${archived.length} archived cycles, keeping all (limit: ${keepCount}).`, affected: [] };
  }
  const toRemove = archived.slice(0, archived.length - keepCount);
  for (const cycle of toRemove) {
    rmSync(join(archiveDir, cycle), { recursive: true });
  }
  return {
    ok: true,
    action: 'clean',
    message: `Cleaned ${toRemove.length} old archive(s), keeping ${keepCount}.`,
    affected: toRemove,
  };
}

/** 动作分派（native 引擎入口）。list 恒 ok=true。 */
export function runArchiveAction(workspaceRoot: string, action: ArchiveAction): ArchiveOutcome {
  switch (action.kind) {
    case 'list':
      return { ok: true, action: 'list', message: 'Cycle inventory listed.', affected: [], inventory: listCycleInventory(workspaceRoot) };
    case 'clean':
      return cleanOldArchives(workspaceRoot, action.keep ?? 5);
    case 'archive':
      return archiveOneCycle(workspaceRoot, action.cycle);
  }
}
