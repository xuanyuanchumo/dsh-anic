/**
 * 快照节点/边的**装配**（cycle-83 拆分：从 snapshotCore 下移，守 T3 ≤250 行）。
 *
 * ## 为什么要单独成文件
 *
 * `snapshotCore.ts` 是「唯一构建器」（嵌入快照与路由快照共用），加入窗口化投影后
 * 职责变成三块：读源、算窗口、装配图。三者混在一个文件里必破 250 行——
 * 而拆分边界只能沿**职责**切，不能按行数硬切，否则回滚会变成"改一处动两个文件"。
 *
 * 本文件只做「事实 → 节点/边」的纯装配：**不读盘、不判窗口**（窗口与源读取在
 * `snapshotSource.ts` / `projectionWindow.ts`；接线在 `snapshotCore.ts`）。
 * 于是装配层可以直接喂夹具做两态断言（折叠前后各跑一次），不必造真实 `.cycles/`。
 *
 * ## 布局坐标为什么保留旧的 5 列 × 46 行
 *
 * 客户端 `graphLayout.ts` 会**重新**布局（分类型 lane），旧坐标只是数据面的事实
 * （`x = 列号 * 380`）。保留它有两个理由：① 旧客户端/生成器仍按旧坐标渲染；
 * ② `graphLayout.test.ts` 的「原布局包围盒」断言用它在算压缩率——坐标换了那条
 * 断言会失去比对面。改布局是客户端的事，不该在这里动。
 */
// 同目录导入（本文件就躺在 snapshotProjection/ 里，再拼一层目录名 = 模块解析失败）。
import type { CycleFact } from './projectionWindow.ts';
import { summarizeArchived } from './projectionWindow.ts';
import {
  badgeLabel,
  evidenceDetail,
  groupGateEvents,
  groupVerdict,
  windowGateGroups,
  type GateGroup,
  type LedgerEntryFact,
} from './aggregateGateEvents.ts';
import type { TestReportSummary } from './testReportProjection.ts';

export interface SnapshotNode {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  result?: string;
  detail?: string;
  testReport?: TestReportSummary;
}

export interface SnapshotEdge { from: string; to: string; type: string }

/** 装配输入：全部为已读取/已判定的事实，本层零 IO。 */
export interface AssembleInput {
  /** workflow-graph.yaml 解析结果（缺失时为空）。 */
  graph: { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[] };
  /** 进主图的活跃轮（已按窗口裁剪，数值序）。 */
  windowedCycles: readonly CycleFact[];
  /** 归档轮（数值序）——用于合成摘要节点。 */
  archivedCycles: readonly CycleFact[];
  /** 账本记录（结构化字段）。 */
  ledger: readonly LedgerEntryFact[];
  /** 事故文件名（事实）。 */
  incidents: readonly string[];
  /** 自主级标量（`L?` = 未 init）。 */
  autonomy: string;
  /** 当前轮最新测试报告摘要（无则 null）。 */
  testReport: TestReportSummary | null;
  /** `false` = 逐条摊开（静态溯源工件）；`true` = 按轮聚合成门禁摘要节点。 */
  aggregateEvents: boolean;
  /** 账本组的窗口大小（与 cycle 窗口同值：同一段历史必须同一尺度）。 */
  recent: number;
}

export interface AssembleOutput {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  /** 归档摘要读数（count = 0 时 nodeId 为 null，不生成空节点）。 */
  archived: { count: number; first: string | null; last: string | null; nodeId: string | null; label: string };
  /** 被窗口折叠的账本组数（0 = 全量摊开或未超窗）。 */
  foldedGroups: number;
}

/** 五列布局常量（旧约定；客户端 graphLayout 会重新布局）。 */
const COL = { macro: 0, gate: 1, cycle: 2, event: 3, aux: 4 } as const;

/** 装配节点与边（纯函数：同输入同输出）。 */
export function assembleSnapshot(input: AssembleInput): AssembleOutput {
  const nodes: SnapshotNode[] = [];
  const edges: SnapshotEdge[] = [];
  const counters = { macro: 0, gate: 0, cycle: 0, event: 0, aux: 0 };
  const node = (id: string, group: keyof typeof COL, type: string, label: string, extra?: Partial<SnapshotNode>): void => {
    nodes.push({ id, type, label, x: COL[group] * 380, y: counters[group]++ * 46, ...extra });
  };
  const edge = (from: string, to: string, type: string): void => { edges.push({ from, to, type }); };

  // ── 1) 宏图（声明图）──
  for (const n of input.graph.nodes) {
    node(`wf:${n.id}`, n.type === 'gate' || n.type === 'human-gate' ? 'gate' : 'macro', n.type, n.label || n.id);
  }
  for (const e of input.graph.edges) edge(`wf:${e.from}`, `wf:${e.to}`, e.type);
  const nodeIdSet = new Set<string>();
  for (const n of nodes) nodeIdSet.add(n.id);

  // ── 2) 窗口内的活跃轮 + cycle-seq（只在窗口内连：折叠不等于断链）──
  const byNum = new Map<number, CycleFact>();
  for (const c of input.windowedCycles) byNum.set(c.num, c);
  for (const c of input.windowedCycles) {
    node(`cycle:${c.name}`, 'cycle', 'cycle', c.name);
    const prev = byNum.get(c.num - 1);
    if (prev !== undefined) edge(`cycle:${prev.name}`, `cycle:${c.name}`, 'cycle-seq');
  }

  // ── 3) 归档摘要组（1 个节点 + 计数）：「归档 ≠ 丢失」的可见形态 ──
  const summary = summarizeArchived(input.archivedCycles);
  if (summary.nodeId !== null) {
    const names = input.archivedCycles.map((c) => c.name);
    // 详情点名（前 12 + 剩余计数）：点得开才算"保留可回溯"，不能只给一个数字。
    const detail = names.length <= 12
      ? names.join(', ')
      : names.slice(0, 12).join(', ') + ` … (+${String(names.length - 12)} more)`;
    node(summary.nodeId, 'cycle', 'cycle', summary.label, { result: 'ARCHIVED', detail });
    const first = input.windowedCycles[0];
    if (first !== undefined) edge(summary.nodeId, `cycle:${first.name}`, 'cycle-seq');
  }

  // ── 4) 账本事件：逐条摊开 or 按轮聚合（聚合后仍要**窗口**，否则 73 组还是 73 个点）──
  let foldedGroups = 0;
  if (input.aggregateEvents) {
    const allGroups = groupGateEvents(input.ledger);
    const win = windowGateGroups(allGroups, input.recent);
    foldedGroups = win.folded.length;
    // 折叠段的计数节点必须在场：静默丢数据是本仓反复踩的形态，折叠数必须可读。
    if (win.foldedSummary !== null) {
      node(win.foldedSummary.nodeId, 'event', 'gate-event', win.foldedSummary.label, {
        result: 'FOLDED',
        detail: `windowed out ${String(win.foldedSummary.groups)} groups / ${String(win.foldedSummary.entries)} records (ledger entries #${String(win.foldedSummary.start)}–${String(win.foldedSummary.end)}); kept the most recent ${String(win.kept.length)} groups. Not shown in the main view — the ledger itself is untouched (INV-9).`,
      });
      // 折叠段 → 保留段的第一组（历史指向现在，链条不断）
      const firstKept = win.kept[0];
      if (firstKept !== undefined) edge(win.foldedSummary.nodeId, `evt:group-${String(firstKept.index)}`, 'event-seq');
    }
    // 报告挂在"最近一个含 G2 的组"上（G2 = 测试收敛门）。
    let reportGroup: GateGroup | null = null;
    for (const g of win.kept) if (g.verdicts['G2'] !== undefined) reportGroup = g;
    let prevKeptId: string | null = null;
    for (const g of win.kept) {
      const id = `evt:group-${String(g.index)}`;
      const verdict = groupVerdict(g);
      node(id, 'event', 'gate-event', badgeLabel(g), {
        ...(verdict !== null ? { result: verdict } : {}),
        detail: evidenceDetail(g),
        ...(g === reportGroup && input.testReport !== null ? { testReport: input.testReport } : {}),
      });
      if (prevKeptId !== null) edge(prevKeptId, id, 'event-seq');
      prevKeptId = id;
      for (const gate of g.gates) {
        const gateId = `wf:gate-${gate.toLowerCase()}`;
        if (nodeIdSet.has(gateId)) edge(id, gateId, 'evidences');
      }
    }
  } else {
    input.ledger.forEach((e, i) => {
      const id = `evt:${String(i)}`;
      const isG2 = String(e.gate ?? '').toUpperCase() === 'G2';
      node(id, 'event', 'gate-event', `${String(e.gate ?? '?')} ${String(e.result ?? '?')}`, {
        result: e.result,
        detail: e.detail,
        ...(isG2 && input.testReport !== null ? { testReport: input.testReport } : {}),
      });
      if (i > 0) edge(`evt:${String(i - 1)}`, id, 'event-seq');
      const gateId = `wf:gate-${String(e.gate ?? '').toLowerCase()}`;
      if (nodeIdSet.has(gateId)) edge(id, gateId, 'evidences');
    });
  }

  // ── 5) 事故 + 自主级（**不折叠**：事故是"需要行动"的信号，折叠等于丢待办）──
  for (const f of input.incidents) node(`inc:${f}`, 'aux', 'incident', f);
  if (input.incidents.length > 0) edge(`inc:${input.incidents[0] ?? ''}`, 'aux:auto', 'reports');
  node('aux:auto', 'aux', 'autonomy', `autonomy ${input.autonomy}`);

  return { nodes, edges, archived: summary, foldedGroups };
}
