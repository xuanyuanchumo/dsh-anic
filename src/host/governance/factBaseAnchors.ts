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

/**
 * 产物锚点前缀（cycle-98）：`.cycles/` 下的运行时产物（账本 / 状态机 / 图谱）也是
 * 「事实」的载体——`ledger.json`、`workflow-state.json` 这类声明不该去源码里搜
 * 符号（恒 miss → 假 absent），而应核验产物文件**是否真的存在**。
 */
export const ARTIFACT_PREFIXES: readonly string[] = ['.cycles/'];

/** 锚点可接受的前缀 = 源码树前缀 ∪ 运行时产物前缀 ∪ 仓库根相对文件。 */
export const ANCHOR_PREFIXES: readonly string[] = [...SOURCE_PREFIXES, ...ARTIFACT_PREFIXES];

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

/** 目录形态锚点（cycle-98）：`src/host/closureAudit/` —— 模块目录也是事实载体
 *  （"该目录存在且有实现"）。核验 = 目录存在 + 目录下有已扫描文件。 */
const DIR_ANCHOR_RE = /^(?:[\w.-]+\/)+$/;

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
  /** 裸文件名锚点（cycle-98）：`README.md`/`ledger.json` 这类无路径前缀的
   *  产物文件名——在 FILE_ANCHOR_DIRS 候选目录里查存在性，不进符号搜索。 */
  fileAnchors: string[];
  /** 否定式锚点（cycle-98）：「无 `X`」——X **缺席**才算 verified。 */
  invertedAnchors: string[];
}

/** 裸文件名锚点的存在性候选目录（相对工作区根；相对根由调用方决定基准）。 */
export const FILE_ANCHOR_DIRS: readonly string[] = ['.', 'assets/skill', '.cycles', '.cycles/gates'];

/** 裸文件名形态：单段、带已知产物扩展名（与 PATH_RE 的多段路径形态互补）。 */
const BARE_FILE_RE = /^[\w.-]+\.(?:ts|tsx|mjs|js|json|jsonl|ya?ml|md|svg)$/;

/** 否定式锚点：行内「无 `X`」「不存在 `X`」。 */
const NEGATED_TICK_RE = /(?:无|不存在|缺席)\s*`([^`\n]{2,160})`/g;

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
    if (id === null) {
      // 续行锚点（cycle-98）：声明行自身无反引号锚点时，紧随其后的反引号行
      // 是同一声明的锚点续行（如 `>   - 实现见 `x.ts``）。丢弃它会制造
      // 假 unscannable——本轮实测 71 条 unscannable 中大量源于此。
      // 策略：上一个声明的锚点为空 且 当前行是列表/缩进/引用续行 → 并入上一声明。
      if (out.length > 0) {
        const last = out[out.length - 1] as Declaration;
        const isContinuation = /^\s*(?:[-*+]\s|>\s|\d+\.\s)/.test(line) || /^\s{2,}/.test(line);
        if (isContinuation && last.pathAnchors.length === 0 && last.symbolAnchors.length === 0
          && last.fileAnchors.length === 0 && last.invertedAnchors.length === 0) {
          for (const span of line.matchAll(TICK_SPAN_RE)) {
            const raw = (span[1] ?? '').trim();
            if (raw.length === 0 || DECL_ID_RE.test(raw)) continue;
            if (PATH_RE.test(raw) && ANCHOR_PREFIXES.some((p) => raw.startsWith(p))) last.pathAnchors.push(raw);
            else if (BARE_FILE_RE.test(raw)) last.fileAnchors.push(raw);
            else if (SYMBOL_RE.test(raw)) last.symbolAnchors.push(raw);
          }
        }
      }
      continue;
    }
    const pathAnchors: string[] = [];
    const symbolAnchors: string[] = [];
    const fileAnchors: string[] = [];
    const invertedAnchors: string[] = [];
    for (const span of line.matchAll(NEGATED_TICK_RE)) {
      const raw = (span[1] ?? '').trim();
      if (raw.length > 0) invertedAnchors.push(raw);
    }
    for (const span of line.matchAll(TICK_SPAN_RE)) {
      const raw = (span[1] ?? '').trim();
      if (raw.length === 0 || DECL_ID_RE.test(raw)) continue;
      if (PATH_RE.test(raw) && ANCHOR_PREFIXES.some((p) => raw.startsWith(p))) pathAnchors.push(raw);
      else if (PATH_RE.test(raw) && /^[\w-]+\//.test(raw)) pathAnchors.push(raw); // 仓库根一级子目录文件（dsh-anic/package.json）
      else if (DIR_ANCHOR_RE.test(raw) && ANCHOR_PREFIXES.some((p) => raw.startsWith(p))) pathAnchors.push(raw);
      else if (BARE_FILE_RE.test(raw)) fileAnchors.push(raw);
      else if (SYMBOL_RE.test(raw)) symbolAnchors.push(raw);
    }
    out.push({ id, source, line: i + 1, text: line.trim().slice(0, 200), pathAnchors, symbolAnchors, fileAnchors, invertedAnchors });
  }
  return out;
}

/** 在已扫描文件中找符号的导出点（返回 `rel:line` 或 null）。命中结果进缓存。 *  cycle-98：改为吃**绝对路径清单**——多扫描根下相对路径会撞名，相对定位交给
 *  evidenceBase（工作区根）统一裁剪，证据形态保持 `src/.../x.ts:12` 不变。 */
export function findSymbol(
  absFiles: readonly string[],
  symbol: string,
  cache: Map<string, string | null>,
  evidenceBase: string,
): string | null {
  const hit = cache.get(symbol);
  if (hit !== undefined) return hit;
  const re = exportRegex(symbol);
  for (const abs of absFiles) {
    if (!/\.(ts|tsx|mjs|js)$/.test(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const m = text.match(re);
    if (m !== null && m.index !== undefined) {
      const line = text.slice(0, m.index).split('\n').length;
      const rel = abs.slice(evidenceBase.length + 1).replace(/\\/g, '/');
      const found = `${rel}:${line}`;
      cache.set(symbol, found);
      return found;
    }
  }
  cache.set(symbol, null);
  return null;
}
