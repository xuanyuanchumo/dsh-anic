/**
 * 事实基线的锚点解析层（L1 纯函数，零 IO 副作用除读取）。
 *
 * 从 `factBaseVerify.ts` 拆出（T3 结构守卫：单文件 ≤250 行）。分界：
 *   - 本文件 = 「怎么把声明找出来、怎么把锚点核掉」：声明行正则、锚点分类、
 *     源码树扫描、符号导出点定位。
 *   - `factBaseVerify.ts` = 「怎么裁决」：三态判定、config 命令核验、结果聚合。
 *
 * 判据来源（外部纪律）：
 *   - dsh-model-everything：结论必须带 `file:line`，核不了的直接说明，不猜。
 *   - dsh-plugin-veriscope：缺失不补零；「核不了」与「确实没有」是两种状态。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 可核路径锚点必须落在源码树前缀内（否则 `ledger.json` 这类文件名会被误判）。 */
export const SOURCE_PREFIXES: readonly string[] = ['src/', 'lib/', 'scripts/', 'assets/', 'tests/', 'bin/'];

/** 源码扫描时跳过的目录（避免把构建产物/依赖当实现）。 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git', '.cycles', 'coverage']);

/** 单次扫描的文件数上限（防超大工作区把诊断端点拖死）。 */
export const MAX_SCAN_FILES = 4000;

/** 声明行：只认「被定义」的编号行，正文里的偶然提及不算声明。 */
const DECL_LINE_RES: readonly RegExp[] = [
  /^#{1,6}\s+.*?\b([FNA]-?\d+[a-z]?)\b/, // 标题
  /^\s*[-*+]\s+\**([FNA]-?\d+[a-z]?)\b/, // 列表项
  /^\s*\|\s*([FNA]-?\d+[a-z]?)\s*\|/, // 表格首列
  /^\s*\*\*([FNA]-?\d+[a-z]?)\b/, // 加粗行首
];

/** 反引号内的候选锚点。 */
const TICK_SPAN_RE = /`([^`\n]{2,160})`/g;

/** 路径形态锚点：形如 `src/a/b.ts` 的源码树相对路径。 */
const PATH_RE = /^(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mjs|js|json|ya?ml|md|sh)$/;

/** 符号锚点：单个标识符（可带 . 或 # 分隔的方法名）。 */
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.#][A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** 编号形态（`F16`/`N-6`/`A1`）：反引号里的编号不是锚点，是被声明的对象本身。 */
const DECL_ID_RE = /^[FNA]-?\d+[a-z]?$/;

/** 导出点正则（找符号的 file:line 出处，而不是「文件里出现过」）。 */
export function exportRegex(symbol: string): RegExp {
  const head = symbol.split(/[.#]/)[0] ?? symbol;
  return new RegExp(
    `^\\s*export\\s+(?:async\\s+)?(?:function|const|let|class|type|interface|enum)\\s+${head}\\b`,
    'm',
  );
}

/** 递归列文件（相对 base，/ 分隔）；跳过构建产物与依赖目录。 */
export function scanFiles(dir: string, base: string, out: string[], limit = MAX_SCAN_FILES): void {
  if (out.length >= limit) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= limit) return;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // 并行测试下夹具可能消失：消失的条目不是发现
    }
    if (isDir) scanFiles(full, base, out, limit);
    else out.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
}

/** 解析源码根（候选序列，兼容独立仓库与旧嵌套布局）。 */
export function resolveSourceRoot(workspaceRoot: string): string | null {
  for (const candidate of [join(workspaceRoot, 'src'), join(workspaceRoot, 'dsh-anic', 'src')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 一条声明（含可核锚点）。 */
export interface Declaration {
  id: string;
  source: string;
  /** 文档内行号（1-based），便于回跳原文。 */
  line: number;
  /** 该行的原文摘录（≤200 字符）。 */
  text: string;
  pathAnchors: string[];
  symbolAnchors: string[];
}

/** 从文档抽取「被定义的编号声明」及其可核锚点。 */
export function extractDeclarations(docPath: string, sourceName?: string): Declaration[] {
  if (!existsSync(docPath)) return [];
  let content: string;
  try {
    content = readFileSync(docPath, 'utf-8');
  } catch {
    return [];
  }
  const source = sourceName ?? docPath.split(/[\\/]/).pop() ?? docPath;
  const out: Declaration[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let id: string | null = null;
    for (const re of DECL_LINE_RES) {
      const m = line.match(re);
      if (m?.[1] !== undefined) {
        id = m[1];
        break;
      }
    }
    if (id === null) continue;
    const pathAnchors: string[] = [];
    const symbolAnchors: string[] = [];
    for (const span of line.matchAll(TICK_SPAN_RE)) {
      const raw = (span[1] ?? '').trim();
      if (raw.length === 0 || DECL_ID_RE.test(raw)) continue;
      if (PATH_RE.test(raw) && SOURCE_PREFIXES.some((p) => raw.startsWith(p))) pathAnchors.push(raw);
      else if (SYMBOL_RE.test(raw)) symbolAnchors.push(raw);
    }
    out.push({ id, source, line: i + 1, text: line.trim().slice(0, 200), pathAnchors, symbolAnchors });
  }
  return out;
}

/** 在已扫描文件中找符号的导出点（返回 `rel:line` 或 null）。命中结果进缓存。 */
export function findSymbol(
  files: readonly string[],
  sourceRoot: string,
  symbol: string,
  cache: Map<string, string | null>,
): string | null {
  const hit = cache.get(symbol);
  if (hit !== undefined) return hit;
  const re = exportRegex(symbol);
  for (const rel of files) {
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue;
    let text: string;
    try {
      text = readFileSync(join(sourceRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    const m = text.match(re);
    if (m !== null && m.index !== undefined) {
      const line = text.slice(0, m.index).split('\n').length;
      const found = `${rel}:${line}`;
      cache.set(symbol, found);
      return found;
    }
  }
  cache.set(symbol, null);
  return null;
}
