/**
 * 事实基线验证 v2 —— 证据接地重写（cycle-38）。
 *
 * v1 的真实缺陷（本仓库自身即样本，实测取证）：
 *   `runFactBaseVerify(<repo>)` → total=135 / verified=3 / missing=132。
 *   132 条「缺失」几乎全是**伪缺失**：v1 用 `/\b([FNA]-?\d+[a-z]?)\b/` 把文档里的
 *   需求编号（F16 / N9 / A1 …）当成「实现声明」，再断言「某个源码**文件名**里
 *   出现该编号的小写形式」——需求编号从不进文件名，于是恒不命中。
 *   更糟的是结果被喂进 `bootstrapEngineIntegration` 的 riskScore
 *   （factRisk = missing/total × 0.4 ≈ 0.39），**纯噪声驱动风险评分**。
 *   次要缺陷：源码根硬编码 `<workspace>/dsh-anic/src`，独立仓库下恒不存在。
 *
 * v2 判据（承两条外部纪律：dsh-model-everything「结论带 file:line，核不了的
 * 直接说明」；dsh-plugin-veriscope「缺失不补零、核不了与确实没有是两态」）：
 *   1. 声明只认**被定义**的编号行（标题 / 列表项 / 表格首列 / 加粗行首），
 *      正文里的偶然提及不算声明（v1 的假阳性来源之一）。
 *   2. 声明必须携带**可核锚点**才可核验：反引号里的源码树路径或代码符号名。
 *      无锚点 → `unscannable`（核不了就直说），**不计入 missing**。
 *   3. 有锚点 → 路径存在性 / 符号在源码中的**导出点（file:line）**；命中记
 *      `verified` 并附 `rel/path.ts:行`，未命中记 `absent`（真实缺失）。
 *   4. 源码根按候选序列解析（`<ws>/src` → `<ws>/dsh-anic/src` 兼容旧布局）；
 *      都不可读 → 全部声明 `unscannable`，而不是全部 missing。
 *
 * 分界（T3 ≤250 行）：factBaseAnchors = 抽取与定位；本文件 = 裁决与聚合。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  findSymbol,
  extractDeclarations,
  scanFiles,
  ARTIFACT_PREFIXES,
  FILE_ANCHOR_DIRS,
  type Declaration,
} from './factBaseAnchors.ts';

/** 单条声明的核验状态（核不了不等于缺失）。 */
export type FactState = 'verified' | 'absent' | 'unscannable';

/** 扫描根：源码根（符号/路径核验）与工作区根（产物存在性核验）。 */
export interface ScanContext {
  /** 源码根候选（空 = 无法扫描，符号类锚点全部 unscannable）。 */
  sourceRoots: readonly string[];
  /** 工作区根（`.cycles/` 产物锚点的核验基准）。 */
  workspaceRoot: string;
  /** 已扫描的**绝对**路径清单（多根下相对路径会撞名）。 */
  absFiles: readonly string[];
  /** 工作区相对路径集（/ 分隔，路径锚点判定 O(1) 查询）。 */
  relSet: ReadonlySet<string>;
}

export interface FactCheck {
  declaration: string;
  source: string;
  /** 向后兼容字段：仅 `state === 'verified'` 时为 true。 */
  found: boolean;
  state: FactState;
  /** verified → `src/x.ts:12`；absent → undefined（见 reason）；unscannable → undefined。 */
  evidence?: string;
  /** 非 verified 的原因（可 grep 的确定性文案）。 */
  reason?: string;
  /** 声明在文档中的行号（1-based），便于回跳原文。 */
  line?: number;
}

export interface FactBaseResult {
  checks: FactCheck[];
  verified: number;
  /** 真实缺失（absent）计数；**不含 unscannable**。 */
  missing: number;
  /** 无可核锚点 / 源码不可扫描的声明计数（核不了 ≠ 缺失）。 */
  unscannable: number;
  total: number;
  /** 首个源码根（null = 无法扫描；多根时看 scannedFiles）。 */
  sourceRoot: string | null;
  /** 已扫描源码文件数（0 + sourceRoot=null 即「没核过」）。 */
  scannedFiles: number;
}

/** 单条声明核验 → 三态（cycle-98：多根 + 产物/裸文件/否定式三通道）。 */
function verifyDeclaration(decl: Declaration, scan: ScanContext, symbolCache: Map<string, string | null>): FactCheck {
  const base = { declaration: decl.id, source: decl.source, line: decl.line };
  const hasAnyAnchor = decl.pathAnchors.length > 0 || decl.symbolAnchors.length > 0
    || decl.fileAnchors.length > 0 || decl.invertedAnchors.length > 0;
  if (!hasAnyAnchor) {
    return { ...base, found: false, state: 'unscannable', reason: 'no verifiable anchor (path or symbol in backticks)' };
  }
  // cycle-98 修正：源码树不可扫描只应挡**符号/源码路径**通道——否定式（工作区
  // 存在性）、产物（.cycles/）、裸文件名三类锚点不依赖源码扫描，必须照常核验。
  // 实测踩中：无 src/ 的最小工作区里否定式声明被整体 unscannable。
  const sourceScannable = scan.sourceRoots.length > 0 && scan.absFiles.length > 0;
  // 否定式锚点（「无 `X`」）：X **缺席**才算 verified——存在反而记 absent 并点名。
  // 核验完成且缺席 → 立即 verified 短路（缺席即事实成立，不落符号通道）。
  let invertedChecked = false;
  for (const anchor of decl.invertedAnchors) {
    invertedChecked = true;
    const present = scan.relSet.has(anchor)
      || scan.absFiles.some((abs) => abs.replace(/\\/g, '/').endsWith(`/${anchor}`))
      || existsSync(join(scan.workspaceRoot, anchor));
    if (present) {
      return { ...base, found: false, state: 'absent', reason: `inverted declaration violated: \`${anchor}\` exists but doc says it must not` };
    }
  }
  if (invertedChecked) {
    return { ...base, found: true, state: 'verified', evidence: decl.invertedAnchors.map((a) => `absent:${a}`).join(',') };
  }
  if (!sourceScannable) {
    return { ...base, found: false, state: 'unscannable', reason: 'source tree not scannable from this workspace' };
  }
  // 产物锚点（`.cycles/` 前缀）：核验产物文件在工作区里是否真的存在——
  // 账本 / 状态机这类运行时事实不该去源码里搜符号。
  for (const anchor of decl.pathAnchors) {
    if (ARTIFACT_PREFIXES.some((p) => anchor.startsWith(p))) {
      if (existsSync(join(scan.workspaceRoot, anchor))) {
        return { ...base, found: true, state: 'verified', evidence: anchor };
      }
      continue;
    }
    // 目录形态锚点（`src/host/closureAudit/`，cycle-98）：目录存在且其下
    // 有已扫描文件（空目录不算实现）。
    if (anchor.endsWith('/')) {
      const prefix = anchor.slice(0, -1) + '/';
      if (scan.absFiles.some((abs) => abs.replace(/\\/g, '/').includes(`/${prefix}`))) {
        return { ...base, found: true, state: 'verified', evidence: anchor };
      }
      continue;
    }
    if (scan.relSet.has(anchor)) return { ...base, found: true, state: 'verified', evidence: anchor };
    // 仓库根一级子目录文件（`dsh-anic/package.json`）：直接核工作区相对存在性。
    if (existsSync(join(scan.workspaceRoot, anchor))) {
      return { ...base, found: true, state: 'verified', evidence: anchor };
    }
  }
  // 裸文件名锚点（`README.md`/`ledger.json`）：在候选目录里查存在性，
  // 不进符号搜索（裸文件名不是标识符，搜导出点恒 miss → 假 absent）。
  for (const anchor of decl.fileAnchors) {
    for (const dir of FILE_ANCHOR_DIRS) {
      if (existsSync(join(scan.workspaceRoot, dir, anchor))) {
        return { ...base, found: true, state: 'verified', evidence: join(dir, anchor).replace(/\\/g, '/') };
      }
    }
  }
  // 符号锚点：在全部源码根候选中找导出点（src/ 之外还有 scripts/、assets/skill/）。
  for (const anchor of decl.symbolAnchors) {
    const found = findSymbol(scan.absFiles, anchor, symbolCache, scan.workspaceRoot);
    if (found !== null) return { ...base, found: true, state: 'verified', evidence: found };
  }
  const tried = [
    ...decl.pathAnchors.map((a) => `path:${a}`),
    ...decl.symbolAnchors.map((a) => `symbol:${a}`),
    ...decl.fileAnchors.map((a) => `file:${a}`),
    ...decl.invertedAnchors.map((a) => `inverted:${a}`),
  ];
  return { ...base, found: false, state: 'absent', reason: `no anchor resolved (tried ${tried.join(', ')})` };
}

/** config.yml 声明的命令是否真的落在 package.json scripts 里（v1 唯一正确检查的保留）。
 *  package.json 损坏/缺失 = 无 scripts，不猜（如实记 absent）。 */
function verifyConfigCommands(workspaceRoot: string): FactCheck[] {
  const configPath = join(workspaceRoot, '.cycles', 'config.yml');
  if (!existsSync(configPath)) return [];
  let config: string;
  try {
    config = readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }
  let pkg: { scripts?: Record<string, string> } = {};
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    } catch {
      pkg = {};
    }
  }
  const out: FactCheck[] = [];
  for (const [key, scriptName] of [['build_cmd', 'build'], ['test_cmd', 'test'], ['lint_cmd', 'lint']] as const) {
    const m = config.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"`, 'm'));
    if (m?.[1] === undefined) continue;
    const declared = m[1];
    const present = pkg.scripts?.[scriptName] !== undefined;
    out.push({
      declaration: `${key}="${declared}"`,
      source: 'config.yml',
      found: present,
      state: present ? 'verified' : 'absent',
      evidence: present ? `package.json scripts.${scriptName}` : undefined,
      reason: present ? undefined : `package.json has no scripts.${scriptName}`,
    });
  }
  return out;
}

/**
 * 运行事实基线验证（v2 证据接地；cycle-98 多根 + 产物/裸文件/否定式/目录四通道）。
 */
export function runFactBaseVerify(workspaceRoot: string): FactBaseResult {
  const checks: FactCheck[] = [...verifyConfigCommands(workspaceRoot)];

  // cycle-98：源码根候选序列扩展——v2 只扫 `<ws>/src`，scripts/assets/tests
  // 前缀锚点与其中符号必然假缺失（判据与扫描域脱钩）。收集绝对路径清单。
  const sourceRoots: string[] = [];
  for (const rel of ['src', 'dsh-anic/src', 'scripts', 'assets/skill/scripts', 'tests']) {
    const candidate = join(workspaceRoot, rel);
    if (existsSync(candidate)) sourceRoots.push(candidate);
  }
  const absFiles: string[] = [];
  const relSet = new Set<string>();
  for (const root of sourceRoots) {
    const bucket: string[] = [];
    scanFiles(root, root, bucket);
    for (const rel of bucket) {
      const abs = join(root, rel);
      absFiles.push(abs);
      relSet.add(abs.slice(workspaceRoot.length + 1).replace(/\\/g, '/'));
    }
  }

  const scan: ScanContext = { sourceRoots, workspaceRoot, absFiles, relSet };
  const docsDir = join(workspaceRoot, 'docs', 'anic');
  if (existsSync(docsDir)) {
    const symbolCache = new Map<string, string | null>();
    let docs: string[] = [];
    try {
      docs = readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      docs = []; // 目录不可读 = 无文档可核，不抛
    }
    for (const doc of docs) {
      for (const decl of extractDeclarations(join(docsDir, doc), doc)) {
        checks.push(verifyDeclaration(decl, scan, symbolCache));
      }
    }
  }

  const verified = checks.filter((c) => c.state === 'verified').length;
  const absent = checks.filter((c) => c.state === 'absent').length;
  const unscannable = checks.filter((c) => c.state === 'unscannable').length;
  return {
    checks,
    verified,
    missing: absent,
    unscannable,
    total: checks.length,
    sourceRoot: sourceRoots[0] ?? null,
    scannedFiles: absFiles.length,
  };
}
