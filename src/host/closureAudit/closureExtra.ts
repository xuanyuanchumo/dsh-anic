/**
 * 闭环体检**第五族 + 跨项目隔离**的编排与口径（cycle-82 可观测性收口）。
 *
 * ## 为什么单独成文件（而不是塞进 registryClosure）
 *
 * `registryClosure.ts` 已在 248 行（T3 上限 250）。cycle-82 要新增两个面
 * （`.cycles` 文档生命周期第五族 + 跨项目隔离判定）以及它们的口径 notes 与守卫，
 * 直接内联必破 250。本文件承载**新面**的编排，registryClosure 保留四族编排不变
 * —— 拆分边界沿"旧面 / 新面"切，而不是按行数硬切，这样 diff 可读、回滚可分段。
 *
 * ## 口径（三族与两面的关系，防读者把新读数当旧读数的延伸误读）
 *
 *   四族（tools/i18n/routes/skills）= 代码资产三态：注册 / 生产 / 消费。
 *   artifacts（第五族）          = **文档资产**三态：模板注册 / 逐循环生产 / 谁在读。
 *   isolation                    = **路径来源**不变量：读写都必须能由 workspace 根推导。
 *
 * 三者回答三个不同问题，故 artifacts/isolation **不进** `clusters` 数组
 * （进了会被 `clustersConsistent` / `bucketsOf` 当成资产三态族来对账，
 * 而它们没有 consumed/unconsumed 的六分类语义 —— 硬塞会造出恒假的分类账）。
 *
 * ## 纪律
 *
 * 纯只读（R-31）；空扫描集由各族扫描器自己响亮抛错；本文件不含扫描逻辑。
 */
import { scanArtifacts, type ArtifactsReport } from './artifactsClosure.ts';
import { checkIsolation, type IsolationReport } from './isolation.ts';

/** 新增两面的汇总（挂进 ClosureSummary）。 */
export interface ExtraSurfaces {
  artifacts: ArtifactsReport;
  isolation: IsolationReport;
}

/** 生成两面的口径 notes（白盒读数必须自带解释，否则数字会被误读）。 */
function extraNotes(s: ExtraSurfaces): string[] {
  return [
    'artifacts（cycle-82）= .cycles 文档生命周期第五族：逐模板报 registered / 逐循环矩阵 / consumed。'
    + '只有 scope=cycle 才点名缺失（`cycle-N/文件名`）；scope=project 只判单份存在；'
    + 'scope=ondemand（事故/复盘）零发生是**健康的**，故报 occurrences 而不是缺失。',
    'isolation（cycle-82）= 跨项目隔离：每条持久化路径必须能从 workspace 根推导出来。'
    + 'violations 只含污染类（`..` 越界 / cwd 兜底 / 写死绝对路径）；dangling 是"登记表漂移"'
    + '（登记了但源码里找不到锚点）——两类**分开**是因为处置动作不同：前者改路径来源，后者改登记表。',
    'artifacts 覆盖：' + String(s.artifacts.totals.registered) + '/' + String(s.artifacts.totals.templates)
    + ' 模板已注册，' + String(s.artifacts.totals.consumed) + ' 个有消费者，缺失点名 '
    + String(s.artifacts.totals.missing) + ' 条（历史循环在模板体系定型前产出，缺失是线索不是判决）。',
    s.isolation.ok
      ? 'isolation 判定：' + String(s.isolation.items.length) + ' 条持久化路径全部落在工作区内，零绝对路径泄漏。'
      : 'isolation 判定**未通过**：' + String(s.isolation.violations.length) + ' 条污染违规 / '
        + String(s.isolation.dangling.length) + ' 条死登记 —— 见响应 isolation 键。',
  ];
}

/**
 * 构建两面（artifacts + isolation）并返回口径 notes。
 *
 * @param rootDir 体检根（本仓语义 = **插件自身**，见 closureAuditRoute 头注）
 * @throws 任一面的空扫描集（由各自扫描器抛；此处不 try/catch —— 静默降级会让
 *   面板显示"缺 15 个模板"这种与真相无关的读数）
 */
export function buildExtraSurfaces(rootDir: string): { surfaces: ExtraSurfaces; notes: string[] } {
  const artifacts = scanArtifacts(rootDir);
  // 隔离判定的 workspace 取 rootDir：体检目标是插件自身，故判的是
  // "插件的持久化面有没有越出插件自己的 .cycles"（而不是用户项目）。
  const isolation = checkIsolation(rootDir, rootDir);
  const surfaces: ExtraSurfaces = { artifacts, isolation };
  return { surfaces, notes: extraNotes(surfaces) };
}

/**
 * 口径守卫：两面必须**在场且有数据**。
 *
 * 为什么单列：`assertClustersPresent` 只守四族（tools/i18n/routes/skills）。
 * 若只依赖编排器自觉挂键，下一次重构把 `artifacts` 忘了，路由照常 200、
 * 面板照常渲染（只是少一行），**没有任何断言会红** —— 这正是 cycle-72
 * 「有壳无表体」的同族形态。空 items 同理（有键无内容 = 假白盒）。
 */
export function assertExtraSurfacesPresent(surfaces: {
  artifacts?: ArtifactsReport;
  isolation?: IsolationReport;
}): void {
  if (surfaces.artifacts === undefined) throw new Error('closure audit: artifacts surface missing');
  if (surfaces.isolation === undefined) throw new Error('closure audit: isolation surface missing');
  if (surfaces.artifacts.items.length === 0) throw new Error('closure audit: artifacts items empty');
  if (surfaces.isolation.items.length === 0) throw new Error('closure audit: isolation items empty');
  if (surfaces.artifacts.templatesScanned.length === 0) {
    throw new Error('closure audit: artifacts templates empty');
  }
}
