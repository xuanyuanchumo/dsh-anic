/**
 * ANIC 工作流快照构建器 —— 唯一实现（generate-snapshot.mjs 与宿主路由共用；
 * 「同一语义的两条数据路径必须共享一个实现」，父工程 buildFilePairAggregate 教训）。
 *
 * 输入：真实 `.cycles/` 目录（结构化字段 only，INV-21 合规——cycle/事件身份绝不从
 * detail 自由文本解析）。输出：分层布局节点/边 + autonomy + counts + 投影窗口读数。
 *
 * ## cycle-83：为什么这个唯一构建器里必须有「投影」这一步
 *
 * 用户原话「避免过度的产物影响判断」。旧实现把**每个** cycle 目录、**每条**账本
 * 记录都摊成一个节点：实测 296 个节点里 273 个（92%）在讲三周前的事。面板一打开，
 * 92% 的像素是历史——这不是"信息量大"，这是**没有投影**（把库整表倒进视图）。
 *
 * 修法只在**读侧**加一层窗口（裁决见 `snapshotProjection/projectionWindow.ts`）：
 *   - 活跃轮只把最近 N 轮（缺省 8）+ 当前轮放进主图，其余折叠成计数 `windowedOut`；
 *   - 账本按位置聚合成「每轮一个门禁摘要节点」（`aggregateGateEvents.ts`）；
 *   - 归档轮不进逐轮列表，但合成 1 个摘要节点继续可见（归档 ≠ 丢失）。
 *
 * ## 本文件只做**接线**（cycle-83 拆分）
 *
 * 读源 → `snapshotSource.ts`；装配 → `assembleSnapshot.ts`；窗口 → `projectionWindow.ts`；
 * 窗口合法性 → `windowConfig.ts`。拆分边界沿职责切（不是按行数硬切），于是
 * 每一层都能单独喂夹具做两态断言——而本文件只剩"把三块串起来 + 组 counts"。
 *
 * ## `window: 'full'` 保留旧的逐条摊开语义
 *
 * 生成器 `scripts/generate-snapshot.mjs` 用它产出静态溯源工件，因为那份工件是所有
 * 「数量必须对得上」契约（`artifacts/workflow-snapshot.json`）的比对面——它的职责是
 * **可审计的全量**，不是面板的可读性。两条路径同一个实现、不同参数，绝不是两套代码。
 */
import { planWindow } from './snapshotProjection/projectionWindow.ts';
import { assembleSnapshot, type SnapshotEdge, type SnapshotNode } from './snapshotProjection/assembleSnapshot.ts';
import { readCurrentTestReport, readSnapshotSources } from './snapshotProjection/snapshotSource.ts';
// `DEFAULT_SNAPSHOT_WINDOW` 的**唯一真相源**在 windowConfig（配置解析层）：
// 它同时也是 `.cycles/config.yml` 的 `anic.snapshotWindow` 缺省值。
// cycle-83 初版把它从 projectionWindow 导入——那一层只做窗口纯计算，不持有配置缺省，
// 于是 build 立刻 MISSING_EXPORT。缺省值跟配置解析走，是这条依赖唯一正确的方向。
import { DEFAULT_SNAPSHOT_WINDOW, resolveSnapshotWindow } from './snapshotProjection/windowConfig.ts';
import type { TestReportSummary } from './snapshotProjection/testReportProjection.ts';

// 保持既有公开名（消费者 import 路径零变更）：parseWorkflowGraph 从源读取层再导出。
export { parseWorkflowGraph } from './snapshotProjection/snapshotSource.ts';
export type { SnapshotEdge, SnapshotNode } from './snapshotProjection/assembleSnapshot.ts';

/** 投影窗口的对外读数（客户端据此显示「折叠了多少 / 窗口多大」）。 */
export interface SnapshotWindow {
  /**
   * 'windowed' = 只放最近 N 轮 + 当前轮（面板路径）；
   * 'full' = 全量摊开（静态溯源工件路径，见文件头）。
   */
  mode: 'windowed' | 'full';
  /** 生效的窗口大小（full 模式下 = 活跃轮数，语义为"不折叠"）。 */
  recent: number;
  /** 当前轮（缺省 = 最大编号活跃轮；无活跃轮 → null）。 */
  current: string | null;
  /** 被窗口折叠掉的活跃轮数 —— **不许静默丢数据**，这个数必须可读。 */
  windowedOut: number;
  /** 全部活跃轮（折叠前）。 */
  activeTotal: number;
  /** 窗口/当前轮判定的告警（空 = 干净）。 */
  warnings: string[];
}

/** 归档区读数（「归档 ≠ 丢失」的机器形态）。 */
export interface SnapshotArchived {
  count: number;
  first: string | null;
  last: string | null;
  /** 归档摘要节点 id（count = 0 时为 null：不生成空节点）。 */
  nodeId: string | null;
  label: string;
}

export interface WorkflowSnapshotData {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  autonomy: string;
  counts: {
    /** 旧字段（语义不变）：节点/边/全部活跃轮/账本条数/事故数。 */
    nodes: number; edges: number; cycles: number; ledgerEntries: number; incidents: number;
    /** 主图里的活跃轮数（= windowed，**不含**归档轮）。 */
    activeCycles: number;
    /** 归档轮数（历史仍在，只是移出主视图）。 */
    archivedCycles: number;
    /** 被窗口折叠掉的活跃轮数（0 = 没折叠任何东西）。 */
    windowedOut: number;
  };
  window: SnapshotWindow;
  archived: SnapshotArchived;
}

export interface SnapshotOptions {
  /**
   * 窗口大小。`undefined` ⇒ `DEFAULT_SNAPSHOT_WINDOW`（= 8，与配置缺省同值）；
   * `'full'` ⇒ 关掉窗口与事件聚合（静态工件路径）。
   *
   * 合法性闸门在 `windowConfig.resolveSnapshotWindow`；本函数对数字只做一次
   * 兜底净化（防止调用方绕过闸门传入坏值——两条入口必须**同一条判据**）。
   */
  window?: number | 'full';
  /** 显式当前轮（缺省取最大编号活跃轮；不存在时落回并告警）。 */
  current?: string;
  /** 窗口告警的外部汇合（配置层解析出的 warning 由此进入快照 `window.warnings`）。 */
  windowWarnings?: readonly string[];
}

/** 构建结果（含时间戳与来源标记，路由/生成器都消费）。 */
export type BuiltSnapshot = WorkflowSnapshotData & { generatedAt: string; source: 'live' };

/**
 * 从真实 .cycles/ 构建快照。任一数据源缺失都安全降级（少一类节点），绝不 throw ——
 * 宿主路由对未 init 的项目必须返回可用（空）图，而不是 500。
 *
 * **例外**：`workflow-graph.yaml` 存在但读坏时**会** throw（由路由层转 500）。
 * 「缺失」与「损坏」必须给出不同结论——把损坏当缺失，会静默显示一张空图。
 */
export function buildWorkflowSnapshot(
  cyclesDir: string,
  generatedAt = new Date().toISOString(),
  opts: SnapshotOptions = {},
): BuiltSnapshot {
  const fullMode = opts.window === 'full';
  const src = readSnapshotSources(cyclesDir);

  // 窗口判定：full 模式不折叠任何东西（但 recent 仍如实报 = 活跃轮数）。
  //
  // 优先级：显式参数 > `.cycles/config.yml` 的 `anic.snapshotWindow` > 缺省 8。
  // 三者走**同一条**闸门（resolveSnapshotWindow），因此"配置里写 0"与"参数传 0"
  // 得到完全相同的结论与告警——两条入口一个判据，不会分叉。
  const rawWindow = opts.window !== undefined ? opts.window : (src.windowRaw ?? DEFAULT_SNAPSHOT_WINDOW);
  const gate = fullMode
    ? { recent: src.active.length, warnings: [] as string[] }
    : resolveSnapshotWindow(rawWindow);
  const plan = fullMode
    ? {
        recent: src.active.length,
        windowed: [...src.active],
        folded: [] as typeof src.active,
        current: src.active[src.active.length - 1]?.name ?? null,
        warnings: [] as string[],
      }
    : planWindow({
        active: src.active,
        archived: src.archived,
        recent: gate.recent,
        ...(opts.current !== undefined ? { current: opts.current } : {}),
      });

  const testReport: TestReportSummary | null = readCurrentTestReport(cyclesDir, plan.current);
  const assembled = assembleSnapshot({
    graph: src.graph,
    windowedCycles: plan.windowed,
    archivedCycles: src.archived,
    ledger: src.ledger,
    incidents: src.incidents,
    autonomy: src.autonomy,
    testReport,
    aggregateEvents: !fullMode,
    // 账本组与 cycle 用**同一**窗口值：两处编码同一段历史，尺度不同会让
    // "为什么 8 轮却 73 组门禁"变成无法解释的读数。
    recent: plan.recent,
  });

  return {
    nodes: assembled.nodes,
    edges: assembled.edges,
    autonomy: src.autonomy,
    counts: {
      nodes: assembled.nodes.length,
      edges: assembled.edges.length,
      // cycles 保持旧语义：**全部活跃轮**（折叠是视图层的事，不是"少了几轮"）。
      cycles: src.active.length,
      ledgerEntries: src.ledger.length,
      incidents: src.incidents.length,
      activeCycles: plan.windowed.length,
      archivedCycles: src.archived.length,
      // 被折叠的**总数** = 折叠的 cycle 轮数 + 折叠的账本组数。
      // 为什么合并成一个数：`windowedOut` 回答的是「主视图少显示了历史里的多少件东西」
      // ——只报 cycle 部分会让 73 组门禁的折叠完全不可见（读数残缺 = 静默丢数据）。
      windowedOut: plan.folded.length + assembled.foldedGroups,
    },
    window: {
      mode: fullMode ? 'full' : 'windowed',
      recent: plan.recent,
      current: plan.current,
      // 与 counts.windowedOut 同值（单一读数：两个字段各算一遍迟早分叉）。
      windowedOut: plan.folded.length + assembled.foldedGroups,
      activeTotal: src.active.length,
      // 窗口合法性告警（来自配置层）+ 当前轮判定告警（来自 planWindow）合并上报。
      warnings: [...(opts.windowWarnings ?? []), ...gate.warnings, ...plan.warnings],
    },
    archived: assembled.archived,
    generatedAt,
    source: 'live',
  };
}
