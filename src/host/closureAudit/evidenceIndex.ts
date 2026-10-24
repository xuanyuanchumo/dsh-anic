/**
 * 闭环体检**证据倒排索引**（cycle-76：修 O(项数 × 全仓行数) 的算法缺口）。
 *
 * ## 被修的实测缺口（非功能性需求 —— 性能）
 *
 * `collectRefs` 的调用形态是：**每一项资产**都把**每个文件的每一行**扫一遍。实测
 * 419 项 × 519 文件 × 平均 156 行 ≈ **34 M 次行判定**，全量体检 **7.9 s**，
 * 而裸文件 I/O 只有 141 ms（56 倍放大）。面板侧的闭环分区是一次性拉取，
 * 7.9 s 的同步扫描会直接卡住渲染面。
 *
 * ## 修法：一次扫描建倒排表，之后每次查询 O(1)
 *
 * 数据结构（单一 pass 构建，`stripComments` 只做一次）：
 *   `tool`    : `anic_*` 标识符        → 证据（file:line）
 *   `route`   : `/anic/...` 路径 token → 证据
 *   `literal` : 引号字面量内容         → 证据（词表键等）
 *
 * 查询从「全仓扫描」变成「哈希查表 + 短列表过滤」，复杂度
 * O(files × lines) + O(items × 命中数)，而非 O(items × files × lines)。
 *
 * ## 为什么这不会改变判定语义（三条边界，逐条对应既有纪律）
 *
 * ① **精确边界**由「最大化取 token」天然保证：`/anic/api/ledger` 在
 *    `/anic/api/ledger/append` 的文本里不会单独成为条目（正则取最长匹配），
 *    故按 id 精确查表与既有 `boundaryContains` 等价。
 * ② **去注释**在建索引时统一做（`stripComments` 保留行号 ⇒ 证据行号与磁盘一致）。
 * ③ **证据上限**：建表时每 token 截断到 `EVIDENCE_CAP` 条（多于消费者需要的 3 条，
 *    留出「按消费面过滤后再取 3 条」的余量）。
 *
 * 纯只读、纯函数；不写工作区（R-31）。空扫描集由调用方 `assertScanNonEmpty` 兜。
 */
// ★必须从 textScan 取（不能从 scanPrimitives）：后者反过来要 import 本模块的
// `evidenceFor`，双向即形成运行时环（被 skillConvergenceContract 的 importGraph 守卫抓到）。
import { stripComments } from './textScan.ts';

/**
 * 每个 token 保留的证据条数上限 —— **不设上限**（cycle-76 实测教训）。
 *
 * 曾设 `EVIDENCE_CAP = 12` 以求省内存，结果**语义回退**：建表按文件遍历顺序截断，
 * 若某 token 前 12 次出现全在 docs/tests/locale 里（被消费面排除），真实消费者的
 * 证据位就被吃掉 ⇒ tools consumed 21→15、routes 19→16。
 * 旧的 `collectRefs` 是**边扫边按 allowFiles 过滤**，不存此问题——
 * 索引化不能改变判定语义，故建表**不截断**，截断只发生在 `evidenceFor` 的
 * 「过滤后取前 N 条」。内存代价可控：条目数 = 全仓 token 出现次数（≈数万），
 * 远小于文本本身。
 */

/** token → 证据（file:line，保序、去重、≤EVIDENCE_CAP）。 */
export type EvidenceMap = Map<string, string[]>;

export interface EvidenceIndex {
  /** `anic_*` 工具/标识符。 */
  tool: EvidenceMap;
  /** `/anic/...` 路径。 */
  route: EvidenceMap;
  /** 引号字面量内容（点分形式，如词表键）。 */
  literal: EvidenceMap;
  /** 参与建索引的文件数（供「扫描集非空」断言）。 */
  fileCount: number;
}

function push(map: EvidenceMap, key: string, at: string): void {
  const cur = map.get(key);
  if (cur === undefined) { map.set(key, [at]); return; }
  // 只去「相邻重复」（同文件同行被多次命中），**不截断**——截断会吃掉真实消费者证据位。
  if (cur[cur.length - 1] === at) return;
  cur.push(at);
}

const TOOL_RE = /\banic_[a-z0-9_]+/g;
const ROUTE_RE = /\/anic\/[A-Za-z0-9_/.-]+/g;
/** 引号字面量（三种引号；内容不含引号与换行）。 */
const LITERAL_RE = /(['"`])([^'"`\n]{1,200})\1/g;
/** 只有点分形态才当词表键（避免把任意字符串灌进索引）。 */
const KEY_LIKE = /^[a-zA-Z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/;

/**
 * 建索引（单次 pass）。
 *
 * `allowFiles` 缺省为「全部参与」；推荐**不传**（一次建全量索引，查询时再按各族
 * 消费面过滤）——这样三个族共用一份索引，避免三次扫描。
 */
export function buildEvidenceIndex(files: Map<string, string>, allowFiles?: (rel: string) => boolean): EvidenceIndex {
  const tool: EvidenceMap = new Map();
  const route: EvidenceMap = new Map();
  const literal: EvidenceMap = new Map();
  let fileCount = 0;

  for (const [rel, raw] of files) {
    if (allowFiles !== undefined && !allowFiles(rel)) continue;
    fileCount += 1;
    const stripped = stripComments(raw);
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const at = rel + ':' + String(i + 1);
      // 工具 id：最大化取 token（边界由 token 本身保证）
      for (const m of line.matchAll(TOOL_RE)) push(tool, m[0], at);
      // 路径：同样最大化
      for (const m of line.matchAll(ROUTE_RE)) push(route, m[0], at);
      // 字面量：只收点分形态（词表键）
      if (line.indexOf('"') >= 0 || line.indexOf("'") >= 0 || line.indexOf('`') >= 0) {
        for (const m of line.matchAll(LITERAL_RE)) {
          const inner = m[2];
          if (inner !== undefined && KEY_LIKE.test(inner)) push(literal, inner, at);
        }
      }
    }
  }
  return { tool, route, literal, fileCount };
}

/**
 * 按消费面过滤后取前 `max` 条证据（与 `collectRefs` 的契约一致：保序、每文件至多 1 条、
 * 返回 file:line 字符串，供 `kindOf` 判证据类别）。
 */
export function evidenceFor(
  index: EvidenceMap,
  key: string,
  allowFiles: (rel: string) => boolean,
  max = 3,
): string[] {
  const hits = index.get(key);
  if (hits === undefined) return [];
  const out: string[] = [];
  const seenFiles = new Set<string>();
  for (const at of hits) {
    const rel = at.slice(0, at.lastIndexOf(':'));
    if (seenFiles.has(rel)) continue;
    if (!allowFiles(rel)) continue;
    seenFiles.add(rel);
    out.push(at);
    if (out.length >= max) break;
  }
  return out;
}
