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
 * 分界（T3 结构守卫：单文件 ≤250 行）：
 *   - `factBaseAnchors.ts` = 抽取与定位（正则、扫描、符号导出点）。
 *   - 本文件 = 裁决与聚合（三态、config 命令核验、结果计数）。
 *
 * 向后兼容：`checks` / `verified` / `missing` / `total` 字段语义保留，
 * 新增 `unscannable` / `sourceRoot` / `scannedFiles`，`FactCheck.state` 为三态。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  findSymbol,
  extractDeclarations,
  resolveSourceRoot,
  scanFiles,
  type Declaration,
} from './factBaseAnchors.ts';

/** 单条声明的核验状态（核不了不等于缺失）。 */
export type FactState = 'verified' | 'absent' | 'unscannable';

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
  /** 解析到的源码根（null = 无法扫描）。 */
  sourceRoot: string | null;
  /** 已扫描源码文件数（0 + sourceRoot=null 即「没核过」）。 */
  scannedFiles: number;
}

/** 单条声明核验 → 三态。 */
function verifyDeclaration(
  decl: Declaration,
  sourceRoot: string | null,
  files: readonly string[],
  symbolCache: Map<string, string | null>,
): FactCheck {
  const base = { declaration: decl.id, source: decl.source, line: decl.line };
  if (decl.pathAnchors.length === 0 && decl.symbolAnchors.length === 0) {
    return { ...base, found: false, state: 'unscannable', reason: 'no verifiable anchor (path or symbol in backticks)' };
  }
  if (sourceRoot === null || files.length === 0) {
    return { ...base, found: false, state: 'unscannable', reason: 'source tree not scannable from this workspace' };
  }
  for (const anchor of decl.pathAnchors) {
    if (files.includes(anchor)) return { ...base, found: true, state: 'verified', evidence: anchor };
  }
  for (const anchor of decl.symbolAnchors) {
    const found = findSymbol(files, sourceRoot, anchor, symbolCache);
    if (found !== null) return { ...base, found: true, state: 'verified', evidence: found };
  }
  const tried = [...decl.pathAnchors.map((a) => `path:${a}`), ...decl.symbolAnchors.map((a) => `symbol:${a}`)];
  return { ...base, found: false, state: 'absent', reason: `no anchor resolved (tried ${tried.join(', ')})` };
}

/** config.yml 声明的命令是否真的落在 package.json scripts 里（保留 v1 唯一正确的检查）。 */
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
      pkg = {}; // 损坏的 package.json = 无 scripts，不猜
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
 * 运行事实基线验证（v2 证据接地）。
 *
 * @param workspaceRoot 工作区根（含 `.cycles/` 与源码树）
 */
export function runFactBaseVerify(workspaceRoot: string): FactBaseResult {
  const checks: FactCheck[] = [...verifyConfigCommands(workspaceRoot)];

  const sourceRoot = resolveSourceRoot(workspaceRoot);
  const files: string[] = [];
  if (sourceRoot !== null) scanFiles(sourceRoot, sourceRoot, files);

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
        checks.push(verifyDeclaration(decl, sourceRoot, files, symbolCache));
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
    sourceRoot,
    scannedFiles: files.length,
  };
}
