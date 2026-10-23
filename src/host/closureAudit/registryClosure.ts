/**
 * 闭环体检编排器（cycle-72 · T-7207 首片）。
 *
 * 输入：仓库文本索引（单一注册表扫描面）；输出：三态矩阵 + 未消费清单 +
 * 幽灵清单（consumed=true 但 registered=false）。
 *
 * 三族（工具 / 词表 / 路由）各自的定义扫描与消费判定在 scanPrimitives.ts 与
 * assetClosure.ts；本文件只负责编排、口径校验与汇总——一域一文件。
 *
 * 硬约束（与任务 write_scope 对齐）：纯只读（不写工作区、不改源码，R-31）；
 * 不 import 父工程 src（G-IND）；无 console 直连（出话由调用方经 scoped logger）。
 *
 * 诚实口径（本片必须显性标注，防读者误读）：
 *   - 工具与路由的对外消费者可以是 DSH 宿主 agent（宿主调用工具/端点，
 *     本仓内看不见）→ 未消费项按 cluster 归类，不硬算成 consumed；
 *   - 未消费清单是「缺口线索」，不是「该删」的判决。
 */
import type { ClusterAudit, ClosureItem } from './scanPrimitives.ts';
import { assertScanNonEmpty, buildFileIndex, buildTextMap, toolClosure } from './scanPrimitives.ts';
import { i18nClosure, i18nGhosts, routeClosure, routeGhosts } from './assetClosure.ts';

export interface ClosureTotals {
  registered: number;
  produced: number;
  /** consumed = 本仓内有读取方（含测试/agent 卡证据）。 */
  consumed: number;
  /** codeConsumed = 生产代码内真消费（证据出自 src/ 非注册文件）。 */
  codeConsumed: number;
  unconsumed: number;
  ghost: number;
}

export interface ClosureSummary {
  /** ISO 生成时刻（每次调用取一次，不缓存——白盒面要的是这一次）。 */
  generatedAt: string;
  /** 扫描根（绝对路径）；仅服务端可读，客户端投影不含它。 */
  rootDir: string;
  scannedFiles: number;
  totals: ClosureTotals;
  clusters: ClusterAudit[];
  /** registered=true 且 consumed=false（缺口线索）。 */
  unconsumed: ClosureItem[];
  /** consumed=true 但 registered=false（幽灵消费）。 */
  ghost: Array<{ cluster: string; id: string; evidence: string[] }>;
  /** 口径声明：客户端据以显示这些绿是什么绿。 */
  notes: string[];
}

/** 生产锚点判定：路由族的注册行 → 是否已接线在 routes/index.ts（挂进宿主 register 调用）。 */
function routeWired(files: Map<string, string>, id: string): boolean {
  const idx = files.get('src/host/routes/index.ts');
  if (idx === undefined) return false;
  return idx.includes(id);
}

/** 生产锚点判定：工具族的注册行 → 同一文件内是否有 execute（handler 就位）。 */
function toolHasHandler(files: Map<string, string>, definedAt: string): boolean {
  const rel = definedAt.split(':')[0] ?? '';
  const raw = files.get(rel);
  return raw !== undefined && /execute\s*:/.test(raw);
}

/**
 * 按族计算「已生产」项数，判据显性化（不统一成 registered 一个数）。
 * i18n 是例外：词表条目由 t() 纯查找，**没有独立写入点** → produced=0 如实标注。
 */
export function producedCount(cluster: string, files: Map<string, string>, items: readonly ClosureItem[]): number {
  if (cluster === 'tools') return items.filter((it) => toolHasHandler(files, it.definedAt)).length;
  if (cluster === 'routes') return items.filter((it) => routeWired(files, it.id)).length;
  return 0; // i18n：无独立写入点（诚实标注，不是缺失）
}

const NOTES: readonly string[] = [
  'consumed 判定 = 本仓内有读取方（客户端 fetch / 宿主内部调用 / 内联技能脚本 / 测试或 agent 卡引用）。',
  'tests 与 docs 引用计入证伪面而不计入端点生产消费（测试只证明注册可用）。',
  '工具与路由的对外消费者可以是 DSH 宿主 agent（宿主调用，本仓看不见）→ 未消费项是缺口线索，不是删除判决。',
  '词表条目没有独立写入点（t() 是纯查找），其 producedAt=null / produced=0 是诚实标注而非缺失。',
  'endpoint 的「已生产」判据 = 已接线在 routes/index.ts（挂进宿主 register 调用）；工具 = 同文件内有 execute handler。',
];

/** 计数自洽校验：consumed 计数 = 逐项统计，unconsumed = total − consumed。 */
export function clustersConsistent(clusters: readonly ClusterAudit[]): string[] {
  const problems: string[] = [];
  for (const c of clusters) {
    if (c.total !== c.items.length) problems.push(c.cluster + ': total != items.length');
    const consumed = c.items.filter((it) => it.consumed).length;
    if (consumed !== c.consumed) problems.push(c.cluster + ': consumed count mismatch');
    const code = c.items.filter((it) => it.evidenceKind === 'code').length;
    if (code !== c.codeConsumed) problems.push(c.cluster + ': codeConsumed count mismatch');
    if (c.total - consumed !== c.unconsumed) problems.push(c.cluster + ': unconsumed count mismatch');
  }
  return problems;
}

/** 运行全量闭环体检（给定 root 返回确定性汇总，无全局状态）。 */
export function runClosureAudit(rootDir: string): ClosureSummary {
  const files = buildTextMap(rootDir, buildFileIndex(rootDir));
  assertScanNonEmpty(files.size, 'file-index');

  const clusters: ClusterAudit[] = [toolClosure(files), i18nClosure(files), routeClosure(files)];

  const i18nDefined = clusters.find((c) => c.cluster === 'i18n')?.items.map((it) => it.id) ?? [];
  const routeDefined = clusters.find((c) => c.cluster === 'routes')?.items.map((it) => it.id) ?? [];
  const ghosts = [
    ...i18nGhosts(files, i18nDefined).map((id) => ({ cluster: 'i18n', id, evidence: [] as string[] })),
    ...routeGhosts(files, routeDefined).map((id) => ({ cluster: 'routes', id, evidence: [] as string[] })),
  ];

  const unconsumed: ClosureItem[] = clusters.flatMap((c) => c.items.filter((it) => !it.consumed));
  const consumed = clusters.reduce((sum, c) => sum + c.consumed, 0);
  const codeConsumed = clusters.reduce((sum, c) => sum + c.codeConsumed, 0);
  const registered = clusters.reduce((sum, c) => sum + c.total, 0);
  const produced = clusters.reduce((sum, c) => sum + producedCount(c.cluster, files, c.items), 0);

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    scannedFiles: files.size,
    totals: { registered, produced, consumed, codeConsumed, unconsumed: registered - consumed, ghost: ghosts.length },
    clusters,
    unconsumed,
    ghost: ghosts,
    notes: [...NOTES],
  };
}

/** 客户端投影：去 rootDir（本地绝对路径不出服务端）。 */
export interface ClosureView {
  generatedAt: string;
  totals: ClosureTotals;
  clusters: Array<{ cluster: string; unit: string; total: number; consumed: number; codeConsumed: number; unconsumed: number }>;
  unconsumed: Array<{ cluster: string; id: string; definedAt: string; evidenceKind: string }>;
  ghost: Array<{ cluster: string; id: string }>;
  notes: string[];
}

export function toClosureView(summary: ClosureSummary): ClosureView {
  return {
    generatedAt: summary.generatedAt,
    totals: summary.totals,
    clusters: summary.clusters.map((c) => ({
      cluster: c.cluster,
      unit: c.unit,
      total: c.total,
      consumed: c.consumed,
      codeConsumed: c.codeConsumed,
      unconsumed: c.unconsumed,
    })),
    unconsumed: summary.unconsumed.map((it) => ({
      cluster: it.cluster,
      id: it.id,
      definedAt: it.definedAt,
      evidenceKind: it.evidenceKind,
    })),
    ghost: summary.ghost.map((g) => ({ cluster: g.cluster, id: g.id })),
    notes: summary.notes,
  };
}

/** 口径守卫：三族必须都在场且非空（静默缺族 = 假守卫）。 */
export function assertClustersPresent(clusters: readonly ClusterAudit[]): void {
  for (const want of ['tools', 'i18n', 'routes']) {
    const c = clusters.find((x) => x.cluster === want);
    if (!c) throw new Error('closure audit cluster missing: ' + want);
    assertScanNonEmpty(c.total, 'cluster-' + want);
  }
}
