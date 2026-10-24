/**
 * 闭环体检扫描原语（cycle-72 · T-7207 首片：注册↔生产↔消费 三态矩阵）。
 *
 * 用户诉求（原文）：「技能插件的所有功能业务的注册、生产与消费如何确保；
 * 同时要白盒透明化、可视化流动等可观测性」。现状：本仓有 19 个工具、63 条 HTTP 路由
 * （README 契约口径，见 tests/contract/readmeNumbers.test.ts）、287 条 i18n 键
 * ——具体数字**以本模块运行时输出为准**（CLOSURE_SUMMARY），头注只给量级与来源，
 * 因为硬编码数字已被实测抓到三次陈旧（269→287、62→63，以及 62 残留在前半句）。
 * ——但没有任何机器可判的东西回答「注册了但没人消费 / 产出了但没人读」。
 *
 * 三态定义（每项资产 × 三态）：
 *   registered（定义） 资产在单一注册表里存在：工具 = src/host/tools*.ts 的
 *                      name 字面量；词表 = locale/zh.json 展平键；
 *                      路由 = src/host/{routes/*.ts,snapshotRoute.ts} 的注册行。
 *   produced（生产）   有 handler 或写入点。工具/路由的注册行本身即生产锚点
 *                      （注册即挂 handler）；词表条目没有独立写入点 →
 *                      producedAt=null，如实标注而不是假装有。
 *   consumed（消费）   有真实读取方：客户端 fetch 常量 / 宿主内部调用 / 技能或
 *                      CLI / 测试与 agent 卡引用。判定维度 = 谁能读到它。
 *
 * 判定纪律（与 docs/agents/开发规范-守卫与约束 同形）：
 *   ① 单一注册表：判定只读本模块的扫描结果，禁止第二份手写词表。
 *   ② 去注释 + 行号保真：stripComments 保留换行（panelLayoutContract 同款），
 *      否则注释里的示例路径会被误判成消费。
 *   ③ 精确边界：URL 判定要求后缀不得再跟 URL 字符，避免 /anic/api/ledger 把
 *      /anic/api/ledger/append 当成自己的消费。
 *   ④ 测试/文档引用 ≠ 生产消费：端点消费面分 client/host/skill-cli（真消费）与
 *      test/doc（记录证据但不计消费）。测试存在只证明注册可用。
 *   ⑤ 未消费 ≠ 缺陷：对外消费者可以是 DSH 宿主 agent（本仓看不见）——这类项
 *      如实进 unconsumed，由消费方标注口径，绝不硬算成 consumed。
 *
 * 诚实边界：只回答本仓内是否有消费者，不回答消费者是否真的跑过（那是
 * FlowTracker / invocationFeed 的职责）；本模块纯只读扫描，绝不改源码（R-31）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetDef, ClusterAudit, ClosureItem } from './closureModel.ts';
import { tallyProduced } from './closureModel.ts';
// cycle-76：倒排索引证据查询（O(1) 查表替代逐项全仓扫描）。
import { evidenceFor } from './evidenceIndex.ts';
// cycle-76：文本原语下沉到 textScan.ts（破 scanPrimitives ↔ evidenceIndex 的 import 环）。
export { quoteClasses, stripComments } from './textScan.ts';
import { quoteClasses, stripComments } from './textScan.ts';

// cycle-75 T3 拆分：数据模型下移到 closureModel.ts；此处**再导出**保消费者
// import 路径零变更（registryClosure / assetClosure / i18nClosure / 契约测试）。
// 注意：`export … from` 不把名字引入本模块作用域，故上面另有一行 import type。
export type { AssetDef, ClusterAudit, ClosureItem, ProducedKind } from './closureModel.ts';
export { emptyProducedTallies, tallyProduced } from './closureModel.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cycles', 'test-results', 'coverage', '.dsh', '.codegraph-visualizer', 'artifacts']);
const TEXT_EXT = /\.(ts|tsx|mjs|js|md|json)$/;
const MAX_EVIDENCE = 3;


/** 扫描集非空下限（守卫纪律：空集恒绿是假守卫，响亮失败而不是静默）。 */
export function assertScanNonEmpty(count: number, label: string): void {
  if (count <= 0) throw new Error('closure audit scan empty: ' + label);
}

/** 递归收集文本文件（相对根、/ 分隔）。 */
export function buildFileIndex(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const rel = base === '' ? name : base + '/' + name;
      let isDir = false;
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
      if (isDir) walk(abs, rel);
      else if (TEXT_EXT.test(name)) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/** 读入文件内容表（读失败跳过——并行清理夹具不是闭环发现）。 */
export function buildTextMap(root: string, files: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of files) {
    try { map.set(rel, readFileSync(join(root, rel), 'utf8')); } catch { /* 消失的夹具 */ }
  }
  return map;
}


function escapeRe(s: string): string {
  return s.split('.').join('\\.');
}

/** 精确边界包含判定（判定纪律③）：id 之后不得再跟标识符/URL 字符。 */
export function boundaryContains(text: string, id: string): boolean {
  return new RegExp(escapeRe(id) + '(?![A-Za-z0-9_/.-])').test(text);
}

/** 逐文件收集字面量引用（要求引号字面量行；每文件最多 1 条，保序）。 */
/** 证据类别判定：src/ 非注册文件的引用为 code，其余（tests/assets/scripts/bin）为 channel。 */
export function kindOf(evidence: readonly string[]): 'code' | 'channel' | 'none' {
  if (evidence.length === 0) return 'none';
  return evidence.some((h) => h.startsWith('src/')) ? 'code' : 'channel';
}

/** 逐文件收集字面量引用（要求引号字面量行；每文件最多 1 条，保序）。 */
export function collectRefs(
  files: Map<string, string>,
  match: (line: string) => boolean,
  allowFiles: (rel: string) => boolean,
  max = MAX_EVIDENCE,
): string[] {
  const hits: string[] = [];
  for (const [rel, raw] of files) {
    if (!allowFiles(rel)) continue;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (line.indexOf(quoteClasses().charAt(0)) < 0
        && line.indexOf(quoteClasses().charAt(1)) < 0
        && line.indexOf(quoteClasses().charAt(2)) < 0) continue;
      if (!match(line)) continue;
      hits.push(rel + ':' + String(i + 1));
      break;
    }
    if (hits.length >= max) return hits;
  }
  return hits;
}

/* ── 族 1：工具（19 个）────────────────────────────────────────────── */

/** 定义扫描：src/host/tools*.ts 的 name 字面量（注册代码即真相）。 */
export function scanToolAssets(files: Map<string, string>): AssetDef[] {
  const out: AssetDef[] = [];
  for (const rel of [...files.keys()].sort()) {
    if (!/^src\/host\/tools.*\.ts$/.test(rel)) continue;
    const lines = (files.get(rel) as string).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const nameRe = new RegExp('name:\\s*[' + quoteClasses() + ']((anic_[a-z0-9_]+))[' + quoteClasses() + ']');
      const m = nameRe.exec(lines[i] as string);
      if (m && m[1]) out.push({ id: m[1], definedAt: rel + ':' + String(i + 1) });
    }
  }
  return out;
}

/**
 * 工具真消费面：注册表**之外**的层读到该 id——客户端渲染、agent 卡、技能脚本、
 * 用例、CLI。三段排除（每段都是实测踩出来的假绿）：
 *   ① 注册层自身（tools*.ts）——注册即定义，不是消费；
 *   ② 投影层（toolIds.ts）——清单是注册代码的投影（该文件头注自认），回声不是消费；
 *   ③ 呈现层（presentation.ts）——工具的 presentCall/presentResult 是它自己的门面；
 *   ④ 散文（docs/*.md、README、CHANGELOG）与数据夹具（.json）——记载/夹具不是调用方。
 */
function toolConsumerUniverse(rel: string): boolean {
  if (/^src\/host\/tools.*\.ts$/.test(rel)) return false;
  if (rel === 'src/host/toolIds.ts' || rel === 'src/host/presentation.ts') return false;
  if (rel.startsWith('docs/') || rel.startsWith('locale/')) return false;
  if (rel.endsWith('.md') || rel.endsWith('.json')) return false;
  return /^(src|tests|scripts|bin|assets)\//.test(rel);
}

/**
 * 工具族闭环（cycle-76：支持传入**倒排索引**，把 O(项 × 全仓行) 降为 O(1) 查表）。
 *
 * `index` 缺省时回落到 `collectRefs`（既有逐项全扫路径）——保证外部调用点与测试
 * 行为不变；批量体检（runClosureAudit）统一传索引，全量耗时从 ~7.9s 降到亚秒级。
 */
export function toolClosure(files: Map<string, string>, index?: import('./evidenceIndex.ts').EvidenceIndex): ClusterAudit {
  const assets = scanToolAssets(files);
  assertScanNonEmpty(assets.length, 'tool-definitions');
  const items: ClosureItem[] = assets.map((a) => {
    const re = new RegExp('\\b' + a.id + '(?![A-Za-z0-9_])');
    // 倒排表是「最大化取 token」建的，故按 id 精确查表与 boundaryContains 等价。
    const evidence = index !== undefined
      ? evidenceFor(index.tool, a.id, toolConsumerUniverse)
      : collectRefs(files, (line) => re.test(line), toolConsumerUniverse);
    // cycle-75：produced 证据 = **同文件内 execute: 实现**（定义处的注册里挂了 handler）。
    const defFile = a.definedAt.split(':')[0] as string;
    const hasHandler = /execute\s*:/.test(files.get(defFile) ?? '');
    return {
      cluster: 'tools',
      id: a.id,
      definedAt: a.definedAt,
      producedAt: hasHandler ? a.definedAt : null,
      producedKind: hasHandler ? 'handler-in-file' : 'declaration-only',
      producedEvidence: hasHandler ? [a.definedAt] : [],
      consumed: evidence.length > 0,
      evidenceKind: kindOf(evidence),
      dynamic: false,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return { cluster: 'tools', unit: 'anic_* tool', total: items.length, consumed, codeConsumed, producedByKind: tallyProduced(items), unconsumed: items.length - consumed, items };
}
