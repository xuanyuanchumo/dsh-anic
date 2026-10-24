/**
 * 闭环体检编排器（cycle-72 · T-7207 首片；cycle-75 拆分与真值重写）。
 *
 * 输入：仓库文本索引（单一注册表扫描面）；输出：三态矩阵 + 未消费清单 +
 * 幽灵清单（consumed=true 但 registered=false）+ 分类计数。
 *
 * 职责边界（cycle-75 T3 拆分后，本文件只做**编排与口径校验**，≤250 行）：
 *   closureModel.ts    数据模型（ClosureItem / ClusterAudit / ProducedKind）
 *   closureBuckets.ts  分类学（五分类判据与计数）
 *   closureTotalsTypes.ts / closureSummary.ts  汇总形状（下沉破循环 import）
 *   closureView.ts     客户端投影（截断 + 排序）
 *   scanPrimitives.ts  扫描原语 + 工具族
 *   assetClosure.ts    路由族（真注册点）+ 词表族再导出
 *   i18nClosure.ts     词表族
 * 消费者 import 路径零变更：本文件**再导出**全部下移的公开名。
 *
 * 硬约束（与任务 write_scope 对齐）：纯只读（不写工作区、不改源码，R-31）；
 * 不 import 父工程 src（G-IND）；无 console 直连（出话由调用方经 scoped logger）。
 *
 * 诚实口径（本片必须显性标注，防读者误读）：
 *   - 工具与路由的对外消费者可以是 DSH 宿主 agent（宿主调用工具/端点，
 *     本仓内看不见）→ 未消费项按 cluster 归类，不硬算成 consumed；
 *   - 未消费清单是「缺口线索」，不是「该删」的判决。
 */
import type { ClusterAudit, ClosureItem } from './closureModel.ts';
import { assertScanNonEmpty, buildFileIndex, buildTextMap, tallyProduced, toolClosure } from './scanPrimitives.ts';
import { i18nClosure, i18nGhosts, routeClosure, routeGhosts } from './assetClosure.ts';
// cycle-75 T6：第四族（技能脚本 + MCP 传输层）——此前该面零覆盖。
import { SKILL_CLOSURE_NOTES, skillClosure } from './skillClosure.ts';
// cycle-76：连通性（注册 → 生产 → **运行时可达**）——三态矩阵答不了「那段代码会不会被执行」。
import { assertConnectivityComplete, buildConnectivity } from './connectivity.ts';
// cycle-76：证据倒排索引（修 O(项 × 全仓行) 的性能缺口）。
import { buildEvidenceIndex } from './evidenceIndex.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import type { ClosureSummary } from './closureSummary.ts';
import type { ClosureBucket } from './closureBuckets.ts';
import { CLOSURE_BUCKETS, bucketsOf, producedCountOf } from './closureBuckets.ts';

/* ── 再导出（cycle-75 拆分后保消费者 import 路径零变更）────────────────── */

export type { AssetDef, ClusterAudit, ClosureItem, ProducedKind } from './closureModel.ts';
export { emptyProducedTallies, tallyProduced } from './closureModel.ts';
export type { ClosureBucket } from './closureBuckets.ts';
export { CLOSURE_BUCKETS, bucketOf, bucketsOf, isProduced, producedCountOf } from './closureBuckets.ts';
export type { ClosureTotals } from './closureTotalsTypes.ts';
export type { ClosureSummary } from './closureSummary.ts';
export type { ClosureView } from './closureView.ts';
export { UNCONSUMED_VIEW_LIMIT, orderUnconsumed, toClosureView } from './closureView.ts';
// cycle-76：连通性（report 类型 + 两态断言原语）。
export type { ChainHop, ConnectivityReport, RegistrarState } from './connectivity.ts';
export { assertConnectivityComplete, buildConnectivity, callLine } from './connectivity.ts';

/* ── 生产锚点判定（cycle-75：判据已下移到各族扫描器，此处不再各自重算）── */

/**
 * 按族计算「已生产」项数。
 *
 * cycle-75 重写：上一版对路由族只看 `routes/index.ts` 是否**含 id 子串**——
 * 而真实注册发生在各路由文件内部（index.ts 只调注册器），那判据把 55 条真注册
 * 报成 1 条。现在各族在**自己的扫描器**里就带上了 producedAt / producedKind 证据，
 * 本函数只做逐项汇总（单一真相，不在聚合层重算第二套判据）。
 *
 * 签名保留 _cluster/_files 两参：既有调用点与契约测试按此形态调用，改签名是破坏性变更。
 */
export function producedCount(_cluster: string, _files: Map<string, string>, items: readonly ClosureItem[]): number {
  return producedCountOf(items);
}

const NOTES: readonly string[] = [
  'consumed 判定 = 本仓内有读取方（客户端 fetch / 宿主内部调用 / 内联技能脚本 / 测试或 agent 卡引用）。',
  'tests 与 docs 引用计入证伪面而不计入端点生产消费（测试只证明注册可用）。',
  '工具与路由的对外消费者可以是 DSH 宿主 agent（宿主调用，本仓看不见）→ 未消费项是缺口线索，不是删除判决。',
  '词表条目没有独立写入点（t() 是纯查找），其 producedAt=null / producedKind=no-write-point 是诚实标注而非缺失。',
  'endpoint 的「已生产」判据 = 存在**真注册调用点**（webServer.register({path}) 或 reg(path,…)），'
  + '不是「routes/index.ts 里出现了该字符串」——后者是聚合器回声。',
  '未消费 ≠ 全部是缺陷：code=生产代码内真消费；dynamicClaimed=计算键认领；'
  + 'channelOnly=仅测试/agent 卡引用（无生产消费者）；consumedGap=真缺口；producedGap=只声明没接线。',
  'producedByKind 是**全量分类**（合计 = total，no-write-point 也占位），'
  + '故不可与 produced 计数直接互比——后者只数真有写入锚点者。',
  // cycle-75 T6：第四族（技能/MCP）的口径与诚实边界由族实现自带（避免口径漂移）。
  ...SKILL_CLOSURE_NOTES,
];

/** 计数自洽校验：各族计数 = 逐项统计；分类合计 = total；produced 分类合计 = total。 */
export function clustersConsistent(clusters: readonly ClusterAudit[]): string[] {
  const problems: string[] = [];
  for (const c of clusters) {
    if (c.total !== c.items.length) problems.push(c.cluster + ': total != items.length');
    const consumed = c.items.filter((it) => it.consumed).length;
    if (consumed !== c.consumed) problems.push(c.cluster + ': consumed count mismatch');
    const code = c.items.filter((it) => it.evidenceKind === 'code').length;
    if (code !== c.codeConsumed) problems.push(c.cluster + ': codeConsumed count mismatch');
    if (c.total - consumed !== c.unconsumed) problems.push(c.cluster + ': unconsumed count mismatch');
    // cycle-75：分类合计必须等于 total（互斥且穷尽——漏一类即静默丢失资产）。
    const buckets = bucketsOf(c.items);
    const bucketSum = CLOSURE_BUCKETS.reduce((s, k) => s + buckets[k], 0);
    if (bucketSum !== c.total) problems.push(c.cluster + ': bucket sum ' + String(bucketSum) + ' != total ' + String(c.total));
    // produced 类别分布必须与逐项统计相等，且**合计 = total**（见 NOTES 最后一条）。
    const tallied = tallyProduced(c.items);
    for (const k of Object.keys(tallied) as Array<keyof typeof tallied>) {
      if (tallied[k] !== c.producedByKind[k]) problems.push(c.cluster + ': producedByKind.' + k + ' mismatch');
    }
    const producedSum = Object.values(c.producedByKind).reduce((s, n) => s + n, 0);
    if (producedSum !== c.total) {
      problems.push(c.cluster + ': producedByKind sum ' + String(producedSum) + ' != total ' + String(c.total));
    }
    // 已生产项数不得超过 total（恒真守卫，防分类实现漂移后自报虚高）。
    if (producedCountOf(c.items) > c.total) problems.push(c.cluster + ': produced > total');
  }
  return problems;
}

/** 运行全量闭环体检（给定 root 返回确定性汇总，无全局状态）。 */
export function runClosureAudit(rootDir: string): ClosureSummary {
  const files = buildTextMap(rootDir, buildFileIndex(rootDir));
  assertScanNonEmpty(files.size, 'file-index');

  // cycle-76（性能）：**一次**建倒排索引，三族共用查表。
  // 旧路径是「每项资产 × 每个文件每行」全扫（419 项 × 519 文件 ≈ 34M 次行判定，实测 7.9s）；
  // 建索引一次后每项查询降为 O(1) 哈希查表。建索引涉及的全量文件数与扫描集同源。
  const evidence = buildEvidenceIndex(files);
  assertScanNonEmpty(evidence.fileCount, 'evidence-index');

  const clusters: ClusterAudit[] = [
    toolClosure(files, evidence), i18nClosure(files, evidence),
    routeClosure(files, evidence), skillClosure(files),
  ];

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
  const buckets = bucketsOf(clusters.flatMap((c) => c.items));

  // cycle-76：连通性（注册 → 生产 → 运行时可达）。扫描集为空即**响亮抛错**
  // （空集恒绿是假守卫；连通性面尤其如此——链全断时「无孤儿」也是空的）。
  const connectivity = buildConnectivity(files);
  assertConnectivityComplete(connectivity);

  const totals: ClosureTotals = {
    registered, produced, consumed, codeConsumed,
    unconsumed: registered - consumed,
    ghost: ghosts.length,
    consumedGap: buckets.consumedGap,
    producedGap: buckets.producedGap,
    dynamicClaimed: buckets.dynamicClaimed,
    channelOnly: buckets.channelOnly,
  };

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    scannedFiles: files.size,
    totals,
    clusters,
    unconsumed,
    ghost: ghosts,
    notes: [...NOTES],
    connectivity,
  };
}

/**
 * 口径守卫：四族必须都在场且非空（静默缺族 = 假守卫）。
 *
 * cycle-75 T6：由三族扩到**四族**（增技能/MCP 面）。缺族不报错的守卫是假守卫——
 * 技能面此前正是「零覆盖却不被任何断言发现」的形态。
 */
export function assertClustersPresent(clusters: readonly ClusterAudit[]): void {
  for (const want of ['tools', 'i18n', 'routes', 'skills']) {
    const c = clusters.find((x) => x.cluster === want);
    if (!c) throw new Error('closure audit cluster missing: ' + want);
    assertScanNonEmpty(c.total, 'cluster-' + want);
  }
}
