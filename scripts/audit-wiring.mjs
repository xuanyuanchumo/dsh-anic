#!/usr/bin/env node
/**
 * 接线审计（cycle-94 WS-D）—— 把「有定义无读数 / 有读数无出口 / 有出口无消费」变成机械可判的数字。
 *
 * ## 为什么要有这个脚本（不是重复闭环体检）
 *
 * `src/host/closureAudit/` 的三态矩阵回答的是**资产级**问题（一个工具 / 一条路由 / 一个词表键
 * 有没有人读）。它答不了**符号级**问题：某个 `export function` 是不是从没人 import 过？
 * 一个客户端 fetch 的 URL 有没有对应的注册？——这两类缺口在本仓反复以「有壳无表体」的形态出现
 * （cycle-72 事故：分区装配了、数据腿零调用、面板照常渲染标题）。判据只有一条：
 * **全仓零文本证据**，而不是「我以为它没人用」。
 *
 * ## 三级严重度（为什么 P0 不是「所有死导出」）
 *
 * 本脚本是**并行执行者的裁决输入**，不是全仓清理工具。若把别域的 30 条死导出都算 P0，
 * 退出码会永久为 1 ⇒ 棘轮被学会忽略 ⇒ 比没有守卫更糟（本仓既有教训：告警级守卫等于没有守卫）。
 * 故分级按「本任务能不能当场裁决」：
 *
 *   P0 阻断（退出码 1）：① 幽灵路由（客户端 fetch 了没人注册的端点）；
 *                        ② 未声明的未消费路由（真缺口，且通道声明机制已存在却没登记）；
 *                        ③ **本域**（closureAudit / closure 面板 / diagnostics / 两条路由）的死导出
 *                           —— 这些是本次能接线/删除的。
 *   P1 记账（不阻断）：别域死导出。技术债登记，由各域 owner 裁决（本脚本只报事实，不越权改）。
 *   P2 提示（不阻断）：只有 tests/scripts 引用的导出 —— 那是测试缝，不是缺口。
 *
 * ## 拆分（cycle-94 · 守 ≤250 行）
 *
 * - `scripts/lib/auditWiringPrimitives.mjs` —— **判据原语**（扫文件、倒排索引、死导出判定、
 *   幽灵路由对账）。判据改错时审计会**在无声中给出错误的 0 条**，所以它单独成文件、值得单独审读。
 * - `scripts/lib/auditWiringReport.mjs` —— **呈现层**（JSON 形态 / 人类摘要 / 退出码三分语义）。
 * - 本文件 —— **编排**（先扫什么、再判什么、自检三腿接在哪）。
 *
 * ## 退出码（三种，语义不同 —— 别混）
 *
 *   0 = 零 P0 且自检通过；1 = 有 P0 断点；2 = **自检失败（判定器本身坏了，"0 条"不可信）**。
 *
 * 若把 1 和 2 都返回 1，「0 条断点」就失去意义 —— 这是本脚本最重要的一条设计。
 */
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  CODE_EXT, OWNED_PREFIXES, SCAN_DIRS,
  auditTools, buildOccurrences, collectConsumers, collectExports,
  isProductionConsumer, judgeExport, walk,
} from './lib/auditWiringPrimitives.mjs';
import { buildReport, exitCodeOf, printSummary } from './lib/auditWiringReport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

/* ── 扫描 ───────────────────────────────────────────────────────────── */

/** 装入源码文本（相对根、/ 分隔 → 内容）。读失败**静默跳过**：审计不该因一个坏文件而崩。 */
function loadTexts() {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), d));
  const texts = new Map();
  for (const rel of files) {
    if (!CODE_EXT.test(rel)) continue;
    try { texts.set(rel, readFileSync(join(ROOT, rel), 'utf8')); } catch { /* skip */ }
  }
  return texts;
}

/* ── 判定（复用 src 的单一实现，不重写第二套口径）──────────────────── */

const { stripComments } = await import(pathToFileURL(join(ROOT, 'src/host/closureAudit/textScan.ts')).href);
const { scanRouteDefs } = await import(pathToFileURL(join(ROOT, 'src/host/closureAudit/assetClosure.ts')).href);
const { CHANNEL_DECLARATIONS } = await import(pathToFileURL(join(ROOT, 'src/host/closureAudit/channelRegistry.ts')).href);

const raw = loadTexts();
// 去注释后才是"真实代码面"（纪律①：注释里提到一个名字不是消费）。
const texts = new Map([...raw.entries()].map(([rel, src]) => [rel, stripComments(src)]));

const occ = buildOccurrences(texts);
const exports = collectExports(texts);
const judged = exports.map((e) => ({ ...e, state: judgeExport(e, occ) }));

const registered = scanRouteDefs(texts);
const registeredIds = new Set(registered.map((d) => d.id));
const consumers = collectConsumers(texts, isProductionConsumer);
const ghostRoutes = [...consumers.entries()]
  .filter(([p]) => !registeredIds.has(p))
  .map(([p, refs]) => ({ path: p, refs: refs.slice(0, 3) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));

const declared = new Set(CHANNEL_DECLARATIONS.map((d) => d.route));
const unconsumedUndeclared = registered
  .filter((d) => !consumers.has(d.id) && !declared.has(d.id))
  .map((d) => ({ id: d.id, at: d.producedAt ?? d.declaredAt }))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

const isOwned = (rel) => OWNED_PREFIXES.some((p) => rel.startsWith(p));
const dead = judged.filter((j) => j.state === 'dead');
const p0Dead = dead.filter((j) => isOwned(j.file));
const p1Dead = dead.filter((j) => !isOwned(j.file));

const tools = auditTools(texts);
const toolNoConsumer = tools.filter((t) => t.codeConsumers === 0 && t.channelConsumers === 0);

/* ── 反向自检（没牙的守卫必须自己失败）──────────────────────────────── */

/**
 * 自检用的探针名**必须拼接构造**，不能写字面量。
 *
 * 踩过的坑（本脚本第一版实测）：把探针名写成字面量后，本脚本**自身的源码**就含该
 * 标识符 ⇒ 倒排索引里它「有引用」⇒ 假孤儿没被抓到 ⇒ 自检失败。这不是脚本写错，
 * 而是本仓守卫纪律②「不匹配自身」的又一次现形：**审计器的输入域包含审计器自己**。
 * 幽灵路由探针同理会污染 P0 清单。
 */
const CANARY_SYMBOL = ['auditWiring', 'Canary', 'Symbol'].join('');
const CANARY_PATH = ['/anic', '/api', '/canary', '-probe'].join('');
const CANARY_DIR = 'src/' + '__audit_canary__' + '.ts';

/** 假孤儿必须被抓到；补一处真引用后必须**不再**报到；假幽灵路由必须被点名。 */
function selfCheck() {
  const fake = new Map(texts);
  fake.set(CANARY_DIR, 'export const ' + CANARY_SYMBOL + ' = 1;\n');
  const fakeOcc = buildOccurrences(fake);
  const fakeJudged = collectExports(fake).map((e) => ({ ...e, state: judgeExport(e, fakeOcc) }));
  const caught = fakeJudged.some((j) => j.name === CANARY_SYMBOL && j.state === 'dead');
  // 反向腿：给假孤儿补一处真实引用后必须**不再**报 ⇒ 判据不是「见到即报」。
  const used = new Map(fake);
  used.set('src/__audit_canary_consumer__.ts',
    'import { ' + CANARY_SYMBOL + ' } from "./__audit_canary__.ts";\nvoid ' + CANARY_SYMBOL + ';\n');
  const usedOcc = buildOccurrences(used);
  const usedJudged = collectExports(used).map((e) => ({ ...e, state: judgeExport(e, usedOcc) }));
  const cleared = usedJudged.some((j) => j.name === CANARY_SYMBOL && j.state === 'used');
  // 假幽灵路由：消费方 URL 无注册必须被点名（用生产面白名单，证明它不是靠测试文件才报的）。
  const ghostFake = new Map(texts);
  ghostFake.set('src/client/__audit_canary_client__.ts',
    'const U = ' + String.fromCharCode(39) + CANARY_PATH + String.fromCharCode(39) + ';\n');
  const ghostCaught = collectConsumers(ghostFake, isProductionConsumer).has(CANARY_PATH);
  return { orphanCaught: caught, orphanCleared: cleared, ghostCaught };
}

const sc = selfCheck();

/* ── 输出（呈现层在 lib/auditWiringReport.mjs）────────────────────── */

const report = buildReport({
  auditedAt: new Date().toISOString(),
  scannedFiles: texts.size,
  exportTotal: exports.length,
  dead,
  p0Dead,
  p1Dead,
  selfOnly: judged.filter((j) => j.state === 'selfOnly').length,
  testOnly: judged.filter((j) => j.state === 'testOnly').length,
  routes: {
    registered: registered.length,
    consumed: registered.filter((d) => consumers.has(d.id)).length,
    declaredChannel: registered.filter((d) => !consumers.has(d.id) && declared.has(d.id)).length,
    unconsumedUndeclared,
    ghostRoutes,
  },
  tools: {
    total: tools.length,
    noConsumer: toolNoConsumer.map((t) => t.id),
    channelOnly: tools.filter((t) => t.codeConsumers === 0 && t.channelConsumers > 0).map((t) => t.id),
  },
  selfCheck: sc,
});

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  printSummary(report);
}

const code = exitCodeOf(Number(report['p0']), sc);
if (code === 2) {
  console.error('[audit-wiring] SELF-CHECK FAILED — 判定器没有牙，"0 条断点" 不可信');
}
process.exit(code);
