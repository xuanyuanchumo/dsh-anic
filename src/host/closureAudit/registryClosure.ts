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
// cycle-82：第五族（.cycles 文档生命周期）+ 跨项目隔离判定的**编排**下移到
// closureExtra.ts（本文件已 248 行，新面内联必破 T3 ≤250；拆分边界沿"旧面/新面"切）。
import { assertExtraSurfacesPresent, buildExtraSurfaces } from './closureExtra.ts';
// cycle-82：新两面的编排 + 口径守卫（此处**再导出**，保消费者 import 路径零变更）。
export type { ExtraSurfaces } from './closureExtra.ts';
export { assertExtraSurfacesPresent, buildExtraSurfaces } from './closureExtra.ts';
// cycle-82：口径声明与计数自洽校验下移到 closureNotes.ts（本文件守 T3 ≤250 行）。
export type { UnconsumedItems } from './closureNotes.ts';
export { CLOSURE_NOTES, clustersConsistent } from './closureNotes.ts';
import { CLOSURE_NOTES } from './closureNotes.ts';
// cycle-78：通道声明（把「通道独占」从「未消费」里认领出来，见 channelRegistry 头注）。
import {
  CHANNEL_DECLARATIONS, findDeclaration, validateDeclarationDocs, validateDeclarations,
} from './channelRegistry.ts';

/* ── 再导出（cycle-75 拆分后保消费者 import 路径零变更）────────────────── */

export type { AssetDef, ClusterAudit, ClosureItem, ProducedKind } from './closureModel.ts';
export { emptyProducedTallies, tallyProduced } from './closureModel.ts';
export type { ClosureBucket } from './closureBuckets.ts';
export { CLOSURE_BUCKETS, bucketOf, bucketsOf, isProduced, producedCountOf } from './closureBuckets.ts';
export type { ClosureTotals } from './closureTotalsTypes.ts';
export type { ClosureSummary } from './closureSummary.ts';
// cycle-78：通道声明（未声明棘轮的机器面）——再导出保消费者 import 路径零变更。
export type { ChannelDeclaration, DeclarationMismatch } from './channelRegistry.ts';
export {
  CHANNEL_DECLARATIONS, checkDocRef, findDeclaration, routeSection,
  validateDeclarationDocs, validateDeclarations,
} from './channelRegistry.ts';
export type { ClosureView } from './closureView.ts';
export { UNCONSUMED_VIEW_LIMIT, orderUnconsumed, toClosureView } from './closureView.ts';
// cycle-76：连通性（report 类型 + 两态断言原语）。
export type { ChainHop, ConnectivityReport, RegistrarState } from './connectivity.ts';
export { assertConnectivityComplete, buildConnectivity, callLine } from './connectivity.ts';
// cycle-82：第五族（.cycles 文档生命周期）+ 跨项目隔离判定的公开名。
export type { ArtifactLifecycle, ArtifactScope, ArtifactsReport, CyclePresence, TemplateSpec } from './artifactsClosure.ts';
export { ARTIFACTS_VIEW_CYCLES, TEMPLATE_DIR_REL, TEMPLATE_SPECS, scanArtifacts, toArtifactsView } from './artifactsClosure.ts';
export type { ArtifactsView } from './artifactsClosure.ts';
export type {
  IsolationItem, IsolationReport, IsolationViolation, IsolationView,
} from './isolation.ts';
export {
  WORKSPACE_PATHS, checkIsolation, inWorkspace, judgePath, scanAbsoluteLiterals, toIsolationView,
} from './isolation.ts';

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

  /*
   * ★cycle-78：把**通道声明**注入 routes 族的逐项明细（声明表是唯一真相源）。
   * 为什么在编排器注入而不是 assetClosure 扫描器：声明是「注册面之外的人为承诺」，
   * 扫描器只该回答注册/生产/消费三个事实问题——把承诺混进扫描会让「有没有人声明」
   * 与「有没有人消费」两个维度互相污染。注入在 bucketsOf 之前，保证分类与 totals 同源。
   */
  const routeCluster = clusters.find((c) => c.cluster === 'routes');
  if (routeCluster !== undefined) {
    routeCluster.items = routeCluster.items.map((it) => {
      const decl = findDeclaration(it.id);
      if (decl === undefined) return it;
      return { ...it, declaredChannel: { owner: decl.owner, docRef: decl.docRef, reason: decl.reason } };
    });
  }
  // 声明表体检：字段非空 + docRef 有据（文件 + 标题章节 + 正文含路由）；不静默。
  const declarationProblems = validateDeclarationDocs(files, CHANNEL_DECLARATIONS);
  const routeIds = (routeCluster?.items ?? []).map((it) => it.id);
  const unconsumedRouteIds = (routeCluster?.items ?? []).filter((it) => !it.consumed).map((it) => it.id);
  const mismatch = validateDeclarations(routeIds, unconsumedRouteIds);
  // 未声明棘轮：未消费路由**必须**被声明。这里只如实入 notes（判定红在契约测试 ③：
  // 运行期抛错会让整个面板失去数据，比「红一条测试」更糟——可见的缺口优于隐身）。
  const channelNotes = [
    '通道声明（cycle-78）：routes 未消费项中 ' + String(unconsumedRouteIds.length - mismatch.undeclaredRoutes.length)
    + '/' + String(unconsumedRouteIds.length) + ' 条已声明（owner+docRef+reason），'
    + '声明 ≠ 豁免：它们仍计入未消费，只是归类为 declaredChannel（已知通道）。',
    ...(mismatch.undeclaredRoutes.length === 0
      ? ['未声明未消费路由：0 条（棘轮通过）。']
      : ['未声明未消费路由（棘轮红，必须补声明或补接线）：' + mismatch.undeclaredRoutes.join(', ')]),
    ...(mismatch.staleDeclarations.length === 0
      ? []
      : ['声明表指向不存在的路由（幽灵声明，必须删或修正）：' + mismatch.staleDeclarations.join(', ')]),
    ...(declarationProblems.length === 0
      ? ['声明 docRef 校验：' + String(CHANNEL_DECLARATIONS.length) + '/' + String(CHANNEL_DECLARATIONS.length) + ' 条有据（文件存在 + 章节标题命中 + 正文含路由字面量）。']
      : ['声明 docRef 问题（不静默）：' + declarationProblems.join('；')]),
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

  // ★cycle-82：第五族（.cycles 文档生命周期）+ 跨项目隔离（见 closureExtra 头注）。
  // 两者空扫描集各自响亮抛错；此处不 try/catch —— 静默降级会让面板显示
  // "15 个模板全缺"这种与真相无关的读数。
  const extra = buildExtraSurfaces(rootDir);

  const totals: ClosureTotals = {
    registered, produced, consumed, codeConsumed,
    unconsumed: registered - consumed,
    ghost: ghosts.length,
    consumedGap: buckets.consumedGap,
    producedGap: buckets.producedGap,
    dynamicClaimed: buckets.dynamicClaimed,
    channelOnly: buckets.channelOnly,
    // cycle-78：通道声明数（未消费但已声明）。面板据以显示「声明 N / 未声明 M」，
    // 其中 M = unconsumed - channelDeclared —— 两个数都从服务端亲算的 totals 派生。
    channelDeclared: buckets.declaredChannel,
  };

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    scannedFiles: files.size,
    totals,
    clusters,
    unconsumed,
    ghost: ghosts,
    notes: [
      ...CLOSURE_NOTES,
      ...channelNotes,
      // cycle-82：新两面的口径 notes（由 closureExtra 生成，口径与实现同一处）。
      ...extra.notes,
    ],
    connectivity,
    ...extra.surfaces,
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
