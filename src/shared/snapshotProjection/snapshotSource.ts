/**
 * 快照的**数据源读取**（cycle-83 拆分：从 snapshotCore 下移，守 T3 ≤250 行）。
 *
 * ## 为什么读源要单独一层（而不是留在构建器里）
 *
 * 「读哪个目录、怎么容忍缺失」与「图怎么装配」是两件独立的事：
 * 前者是**磁盘事实**（可能不存在、可能不可读），后者是**纯变换**。
 * 混在一起的后果是本仓反复踩的形态——想给装配层写夹具，就得造一个真实
 * `.cycles/` 目录；而"造真实目录"的测试在并发清理下会变成 flaky（本仓有前科）。
 * 拆开之后，装配层可以喂纯对象，读源层单独用 `mkdtempSync` 建临时工作区测。
 *
 * ## 纪律
 *
 * 只读、绝不 throw（未 init 的项目必须返回可用空图，而不是 500）。
 * **不写任何文件**（R-31；本文件连 fs-safe 都不 import）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectory, listCycleFacts } from './cycleInventory.ts';
import { projectLatestTestReport, type TestReportSummary } from './testReportProjection.ts';
import type { LedgerEntryFact } from './aggregateGateEvents.ts';
import type { CycleFact } from './projectionWindow.ts';

/** 声明图（workflow-graph.yaml）的最小解析（只认技能侧真实形状）。 */
export function parseWorkflowGraph(text: string): { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[] } {
  const nodes: { id: string; type: string; label: string }[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  let cur: { id: string; type: string; label: string } | null = null;
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^nodes:/.test(line)) { section = 'nodes'; continue; }
    if (/^edges:/.test(line)) { section = 'edges'; continue; }
    if (/^\S/.test(line)) { section = ''; continue; }
    if (section === 'nodes') {
      const idm = line.match(/^\s*-\s+id:\s*(\S+)/);
      if (idm) { cur = { id: idm[1] ?? '', type: 'phase', label: idm[1] ?? '' }; nodes.push(cur); continue; }
      if (cur) {
        const t = line.match(/^\s*type:\s*(\S+)/);
        if (t?.[1]) cur.type = t[1];
        const l = line.match(/^\s*label:\s*"([^"]*)"/);
        if (l?.[1]) cur.label = l[1];
      }
    }
    if (section === 'edges') {
      const m = line.match(/^\s*-\s*\{\s*from:\s*(\S+?),\s*to:\s*(\S+?)(?:,\s*type:\s*"([^"]+)")?\s*\}/);
      if (m) edges.push({ from: m[1] ?? '', to: m[2] ?? '', type: m[3] ?? 'flow' });
    }
  }
  return { nodes, edges };
}

/** 读声明图（缺失 ⇒ 空图；读坏 ⇒ **throw**，由路由层转 500：损坏不等于未 init）。 */
export function readWorkflowGraph(cyclesDir: string): { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[] } {
  const p = join(cyclesDir, 'workflow-graph.yaml');
  if (!existsSync(p)) return { nodes: [], edges: [] };
  return parseWorkflowGraph(readFileSync(p, 'utf8'));
}

/** 读账本（结构化字段；畸形/缺失 ⇒ 空数组——结构损坏按 0 条处理，不 throw）。 */
export function readLedgerFacts(cyclesDir: string): LedgerEntryFact[] {
  const p = join(cyclesDir, 'gates', 'ledger.json');
  if (!existsSync(p)) return [];
  try {
    const ledger = JSON.parse(readFileSync(p, 'utf8')) as { entries?: LedgerEntryFact[] } | LedgerEntryFact[];
    return Array.isArray(ledger) ? ledger : (ledger.entries ?? []);
  } catch {
    return [];
  }
}

/** 读事故文件名（事实；目录缺失 ⇒ 空数组）。 */
export function readIncidents(cyclesDir: string): string[] {
  const p = join(cyclesDir, 'incidents');
  if (!isDirectory(p)) return [];
  try { return readdirSync(p).filter((f) => f.endsWith('.md')); } catch { return []; }
}

/** 读自主级（`L?` = 未 init 或读不到；带引号写法容错）。 */
export function readAutonomy(cyclesDir: string): string {
  const p = join(cyclesDir, 'config.yml');
  if (!existsSync(p)) return 'L?';
  try {
    const m = readFileSync(p, 'utf8').match(/^\s*autonomy_level:\s*["']?(L[1-4])["']?/m);
    return m?.[1] ?? 'L?';
  } catch {
    return 'L?';
  }
}

/**
 * 读 `anic.snapshotWindow` 的**原始**值（cycle-83；未配置 ⇒ null）。
 *
 * ## 为什么这里自己读 config.yml 而不 import `host/config.ts`
 *
 * `snapshotCore` 在 `src/shared/`（客户端与生成器都可达），而 `loadWorkspaceConfig`
 * 在 `src/host/` —— 反向 import 会把整个 host 域拖进客户端编译单元（tsconfig 的两份
 * include 也互斥，见 typecheckCoverage 契约）。这与本文件已有的 `autonomy_level`
 * 读取是**同一处历史选择**（同样只取一个字段的正则）。
 *
 * ## 为什么只取原始串、不在此 parseInt
 *
 * 判据只该有一个实现：`windowConfig.resolveSnapshotWindow`。这一层若顺手 Number()，
 * 就会造出"配置说 99 → 这里接受 → 构建器不接受"的分叉（双真相源）。
 *
 * 只认 `anic:` 段内的行：顶层同名字段（别处可能有 `snapshotWindow`）不是这个配置。
 */
export function readSnapshotWindowRaw(cyclesDir: string): string | null {
  const p = join(cyclesDir, 'config.yml');
  if (!existsSync(p)) return null;
  let lines: string[];
  try { lines = readFileSync(p, 'utf8').split(/\r?\n/); } catch { return null; }
  let inAnic = false;
  for (const line of lines) {
    if (/^anic:\s*$/.test(line)) { inAnic = true; continue; }
    if (!inAnic) continue;
    if (/^\S/.test(line)) { inAnic = false; continue; } // 顶层键 = 段结束
    const m = line.match(/^\s+snapshotWindow:\s*(.*)$/);
    if (m?.[1] !== undefined) {
      const raw = m[1].split(' #')[0]?.trim() ?? '';
      // 剥引号（YAML 允许 `snapshotWindow: "8"`）——闸门自己再剥一层也安全。
      const unquoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
      return unquoted;
    }
  }
  return null;
}

/** 一次性读齐全部源（调用方只需一次调用，避免四个函数各读一遍配置）。 */
export interface SnapshotSources {
  graph: ReturnType<typeof readWorkflowGraph>;
  active: CycleFact[];
  archived: CycleFact[];
  ledger: LedgerEntryFact[];
  incidents: string[];
  autonomy: string;
  /** `anic.snapshotWindow` 原始串（null = 未配置；判据在 windowConfig）。 */
  windowRaw: string | null;
}

/** 读源（**不含**窗口判定与装配；那些是纯函数）。 */
export function readSnapshotSources(cyclesDir: string): SnapshotSources {
  const cyclesRoot = join(cyclesDir, 'cycles');
  return {
    graph: readWorkflowGraph(cyclesDir),
    active: listCycleFacts(cyclesRoot),
    // 归档区读目录 mtime 作为归档日期（manifest 是 manifest，不是身份来源）
    archived: listCycleFacts(join(cyclesDir, 'archive'), { withDate: true }),
    ledger: readLedgerFacts(cyclesDir),
    incidents: readIncidents(cyclesDir),
    autonomy: readAutonomy(cyclesDir),
    windowRaw: readSnapshotWindowRaw(cyclesDir),
  };
}

/** 当前轮最新测试报告（只取这一轮：全量投影 79 轮报告会再制造一次过度产物）。 */
export function readCurrentTestReport(cyclesDir: string, currentCycle: string | null): TestReportSummary | null {
  if (currentCycle === null) return null;
  return projectLatestTestReport(join(cyclesDir, 'cycles', currentCycle));
}

/** 目录规模统计（供 inventory 路由：活跃区/归档区的文件数与字节数）。 */
export function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else { files += 1; bytes += st.size; }
      } catch { /* 消失/不可读条目：跳过（并发清理不是归档发现） */ }
    }
  };
  walk(dir);
  return { files, bytes };
}
