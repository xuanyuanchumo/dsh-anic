/**
 * 闭环体检**双向真值**契约（cycle-75 · T5）——证明扫描器「自述」== 「代码真值」。
 *
 * 缺陷类（contract 冻结册 §0.1 实测）：上一版路由扫描器把路由文件里**任意** `/anic/...`
 * 字面量当注册（JSDoc 头注 / 错误消息 / 响应字段全算），一次报 63 条而真值 55，
 * 其中 10 条代码里根本不存在（**幽灵注册**）；同时 5 条真注册（`path: IDENT` 形态）
 * 漏报；`produced` 又只看 `routes/index.ts` 是否含 id 子串 ⇒ 恒为 1。
 * registered / produced / unconsumed 三个数没有一个可信 —— 这就是本守卫存在的理由。
 *
 * 守卫纪律（开发规范-守卫与约束 §10 三条全族适用）：
 *   ① **独立真值腿**：代码真值**不复用扫描器**，而用**不同算法**（括号配平取实参、
 *      无 600 字窗口、无 producedAt 概念）独立重算。同源的重算只能发现打字错，
 *      发现不了判据设计错 —— 只有独立算法才能证伪扫描器。
 *   ② **反向自检**：每处判据都要能判「有/无」两态（变异后必红），不写恒真断言。
 *   ③ **扫描集非空下限**：三族各有下限，空扫描 = 响亮失败（`assertScanNonEmpty`）。
 *
 * 只读：本文件只读工作区文本构造内存 Map，绝不写盘、不改源码（R-31）。
 * 源码直读：**不经 dist/**（dist 对 src/ 变更惰性，先 build 才可见 —— 那是假绿来源）。
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertScanNonEmpty,
  buildFileIndex,
  buildTextMap,
  stripComments,
  tallyProduced,
} from '../../src/host/closureAudit/scanPrimitives.ts';
import { routeGhosts, scanRouteDefs } from '../../src/host/closureAudit/assetClosure.ts';
import { dynamicKeyPrefixes, endsWithSeparator, i18nClosure } from '../../src/host/closureAudit/i18nClosure.ts';
import { MCP_SERVER_FILE, mcpSurface, type McpSurface } from '../../src/host/closureAudit/skillClosure.ts';
import {
  CLOSURE_BUCKETS,
  UNCONSUMED_VIEW_LIMIT,
  assertClustersPresent,
  bucketOf,
  bucketsOf,
  isProduced,
  runClosureAudit,
  toClosureView,
} from '../../src/host/closureAudit/registryClosure.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BS = String.fromCharCode(92);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BT = String.fromCharCode(96);
/** 三引号字符类（经 RegExp 构造 —— 正则字面量里的引号会让去注释状态机失衡）。 */
const Q = '[' + SQ + DQ + BT + ']';
const ROUTE_FILE = new RegExp('^src/host/(routes/[A-Za-z0-9_]+' + BS + '.ts|snapshotRoute' + BS + '.ts)$');

const FILES: Map<string, string> = buildTextMap(ROOT, buildFileIndex(ROOT));
const SUMMARY = runClosureAudit(ROOT);

/* ── 独立真值腿：与扫描器不同算法 ─────────────────────────────────── */

/**
 * 括号配平取实参：从 `(` 起到**深度归零**为止，引号内括号不计。
 * 扫描器用的是「600 字窗口 + handler: 截断」启发式；本腿不用任何窗口，
 * 故能独立证伪窗口过窄/过宽两类缺陷。
 */
function balancedArgs(text: string, open: number): string {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inStr !== null) {
      if (c === BS) { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === SQ || c === DQ || c === BT) { inStr = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** 代码里**真**注册的 path 集合（独立算法：注册调用词 + path 实参字面量/常量回溯）。 */
function codeTruthRoutePaths(files: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const constRe = new RegExp('const' + BS + 's+([A-Za-z_][A-Za-z0-9_]*)' + BS + 's*=' + BS + 's*'
    + Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q, 'g');
  const callRe = new RegExp('(?:^|[^A-Za-z0-9_])(?:reg|register)' + BS + 's*' + BS + '(', 'g');
  const pathRe = new RegExp('path' + BS + 's*:' + BS + 's*');
  const idRe = new RegExp('path' + BS + 's*:' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)');
  for (const rel of [...files.keys()].sort()) {
    if (!ROUTE_FILE.test(rel) || rel === 'src/host/routes/routeContext.ts') continue;
    // 判定纪律⑥：去注释后再扫（注释里的示例路径不是注册）。
    const text = stripComments(files.get(rel) as string);
    const consts = new Map<string, string>();
    for (const m of text.matchAll(constRe)) if (m[1] && m[2]) consts.set(m[1], m[2]);
    for (const m of text.matchAll(callRe)) {
      const open = (m.index ?? 0) + m[0].lastIndexOf('(');
      const args = balancedArgs(text, open);
      const pathPos = pathRe.exec(args);
      const seg = pathPos ? args.slice(pathPos.index) : args;
      const lit = new RegExp(Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q).exec(seg);
      if (lit && lit[1]) { out.add(lit[1]); continue; }
      const idm = pathPos ? idRe.exec(args) : null;
      const resolved = idm && idm[1] ? consts.get(idm[1]) : undefined;
      if (resolved) { out.add(resolved); continue; }
      // 形态 B（动词 + 常量）：`register('POST', REVIEW_ROUTE, handler)` ——
      // 无 path: 键，路径在第二个实参的**常量**里。这一态正是「漏报」的来源：
      // 扫描器靠 `,\s*IDENT\s*,` 命中，本腿独立用「动词位置参数」判据复核。
      const verbArg = new RegExp('^' + BS + 's*' + Q + '(?:GET|POST|PUT|DELETE|PATCH)'
        + Q + BS + 's*,' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)').exec(args);
      const viaVerb = verbArg && verbArg[1] ? consts.get(verbArg[1]) : undefined;
      if (viaVerb) { out.add(viaVerb); continue; }
      // 形态 C（首位常量）：`reg(FLOWS_VIEW_ROUTE, handler)` —— 路径常量在**第一个**
      // 实参位。cycle-101 新增此形态时本腿未跟上，于是资产腿多报 1 条 ⇒ 双向真值假红。
      // 三条腿（资产扫描器 / mutation 真值腿 / 本真值腿）必须认同一种形态集合。
      const leadingArg = new RegExp('^' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)' + BS + 's*,').exec(args);
      const viaLeading = leadingArg && leadingArg[1] ? consts.get(leadingArg[1]) : undefined;
      if (viaLeading) out.add(viaLeading);
      // 形态 B（裸路径 + 处理器常量）：`reg('/anic/x', ...)` 由上方字面量分支覆盖。
    }
  }
  return out;
}

/** 双向真值判定：两侧都必须为空（漏报=missing，幽灵=extra）。 */
interface TruthVerdict { scanned: number; truth: number; missing: string[]; extra: string[]; }

function evalTruth(files: Map<string, string>): TruthVerdict {
  const scannedSet = new Set(scanRouteDefs(files).filter((d) => d.producedAt !== null).map((d) => d.id));
  const truthSet = codeTruthRoutePaths(files);
  return {
    scanned: scannedSet.size,
    truth: truthSet.size,
    missing: [...truthSet].filter((p) => !scannedSet.has(p)).sort(),
    extra: [...scannedSet].filter((p) => !truthSet.has(p)).sort(),
  };
}

const PRISTINE = evalTruth(FILES);

describe('cycle-75 T5 路由族双向真值（扫描器 ⇄ 代码，逐 id 双向相等）', () => {
  it('纪律③ 扫描集非空下限：两侧各 ≥40，否则响亮失败（空集恒绿 = 假守卫）', () => {
    expect(PRISTINE.scanned).toBeGreaterThanOrEqual(40);
    expect(PRISTINE.truth).toBeGreaterThanOrEqual(40);
    // 响亮失败本体：0 必须抛错，而不是静默返回
    expect(() => assertScanNonEmpty(0, 'probe')).toThrow();
    expect(() => assertScanNonEmpty(1, 'probe')).not.toThrow();
  });

  it('双向真值钉：produced 集合 === 代码真注册集合（漏报与幽灵同时为零）', () => {
    expect(PRISTINE.missing, '漏报：代码里真注册但扫描器没看见').toEqual([]);
    expect(PRISTINE.extra, '幽灵：扫描器报了代码里不存在的 path').toEqual([]);
    expect(PRISTINE.scanned).toBe(PRISTINE.truth);
  });

  it('纪律② 反向自检：删掉一条真注册 ⇒ 该 id 必从 produced 集合消失（判据非恒真）', () => {
    const rel = 'src/host/routes/flowsRoute.ts';
    const mutated = cutStatement(FILES.get(rel) as string, 'reg(' + SQ + '/anic/flows' + SQ);
    // 前向：变异确实改变了文本（否则下面的「消失」是恒真装饰）
    expect(mutated).not.toBe(FILES.get(rel));
    const after = evalTruth(withFile(FILES, rel, mutated));
    // 反向：该 id 必从扫描器 produced 集合消失 —— 证明判据读的是**真注册调用**
    expect(after.scanned).toBe(PRISTINE.scanned - 1);
    const stillScanned = scanRouteDefs(withFile(FILES, rel, mutated)).filter((d) => d.producedAt !== null);
    expect(stillScanned.map((d) => d.id)).not.toContain('/anic/flows');
    // 变异只影响被删的那一条（不误伤邻居）—— 集合差恰好 = {/anic/flows}
    expect(new Set(scanRouteDefs(FILES).filter((d) => d.producedAt !== null).map((d) => d.id)))
      .not.toEqual(new Set(stillScanned.map((d) => d.id)));
    // 用 PRISTINE 的实测值派生，而不是写死 64/63：
    // 写死数字的代价在本条上已经付过一次（cycle-82 新增 /anic/api/config 后
    // 64→65 立刻红，但红的是"钉子过期"而不是"判据失灵"）。判据语义是
    // 「删一条 ⇒ 恰好少一条」，与注册总数无关，故从实测值派生即可。
    expect(scanRouteDefs(FILES).filter((d) => d.producedAt !== null).length).toBe(PRISTINE.scanned);
    expect(stillScanned.length).toBe(PRISTINE.scanned - 1);
  });

  it('纪律② 反向自检（幽灵腿）：删掉**有真实消费者**的注册 ⇒ 幽灵必现（非空转）', () => {
    /*
     * 为什么单列这一条：`/anic/flows` 的引用全在注释里（去注释后无一消费），
     * 删它**不会**产生幽灵 —— 用它冒充「幽灵判据有牙」就是空转。
     * 必须挑一个**去注释后仍有引号字面量消费者**的 path：
     *   src/client/features/cycles/renderCyclesTimeline.ts 的
     *   `export const CYCLE_LIST_URL = '/anic/cycle/list';`
     */
    const rel = 'src/host/routes/cycleRoute.ts';
    const mutated = cutStatement(FILES.get(rel) as string, 'path: ' + SQ + '/anic/cycle/list' + SQ);
    expect(mutated).not.toBe(FILES.get(rel));
    const m = withFile(FILES, rel, mutated);
    const stillScanned = scanRouteDefs(m).filter((d) => d.producedAt !== null);
    expect(stillScanned.length).toBe(PRISTINE.scanned - 1);
    expect(stillScanned.map((d) => d.id)).not.toContain('/anic/cycle/list');
    const ghosts = routeGhosts(m, stillScanned.map((d) => d.id));
    expect(ghosts).toContain('/anic/cycle/list');
    // 对照：原树同一判据零幽灵（证明判据不是「逢扫必报」的恒真噪声）
    expect(routeGhosts(FILES, scanRouteDefs(FILES).map((d) => d.id))).toEqual([]);
  });

  it('幽灵注册为零（全仓），且判据非空转：代码面确实存在只在注释里的 /anic/ 字面量', () => {
    const gh = routeGhosts(FILES, scanRouteDefs(FILES).map((d) => d.id));
    expect(gh, '消费者引用了未注册端点：\n' + gh.join('\n')).toEqual([]);
    // 非空下限：确有「去注释后才消失」的 /anic/ 字面量（若为 0，上面的零就是空转）
    const litRe = new RegExp(Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q, 'g');
    const commentOnly: string[] = [];
    for (const [rel, raw] of FILES) {
      if (!/^(src|scripts|bin)\//.test(rel)) continue;
      const naive = new Set([...raw.matchAll(litRe)].map((m) => m[1]));
      const stripped = new Set([...stripComments(raw).matchAll(litRe)].map((m) => m[1]));
      for (const p of naive) if (!stripped.has(p)) commentOnly.push(rel + ' -> ' + p);
    }
    expect(commentOnly.length, '注释里没有 /anic/ 字面量——幽灵判据的空转下限失守').toBeGreaterThanOrEqual(1);
  });

  it('去注释纪律（判定⑥）：注释掉的注册**不得**算注册，注释外的必须算（两态）', () => {
    const fixture = 'src/host/routes/probeRoute.ts';
    const live = [
      'const p = ' + SQ + '/anic/probe/live' + SQ + ';',
      'ws.register({ kind: ' + SQ + 'exact' + SQ + ', path: p, handler: () => {} });',
    ].join('\n');
    const commented = '// ws.register({ kind: ' + SQ + 'exact' + SQ + ', path: ' + SQ + '/anic/probe/ghost' + SQ + ', handler: () => {} });';
    const seen = scanRouteDefs(new Map([[fixture, live + '\n' + commented]]));
    expect(seen.map((d) => d.id)).toEqual(['/anic/probe/live']);
    expect(seen.some((d) => d.id === '/anic/probe/ghost')).toBe(false);
    expect(seen[0]?.producedAt).not.toBeNull();
  });
});

describe('cycle-75 T5 produced 逐项证据 + 分类互斥穷尽（逐族）', () => {
  it('produced 逐项证据：producedAt!==null ⇒ 类别非声明态且证据非空（逐项）', () => {
    let anchored = 0;
    for (const c of SUMMARY.clusters) {
      for (const it of c.items) {
        if (it.producedAt !== null) {
          anchored += 1;
          expect(it.producedKind, c.cluster + '|' + it.id + ' 有产出锚点却是声明态').not.toBe('declaration-only');
          expect(it.producedKind).not.toBe('no-write-point');
          expect(it.producedEvidence.length, c.cluster + '|' + it.id + ' 无证据').toBeGreaterThan(0);
          expect(isProduced(it)).toBe(true);
        } else {
          // 反向：没有产出锚点就必须是诚实标注的两种非产出态（不许自报已生产）
          expect(['declaration-only', 'no-write-point']).toContain(it.producedKind);
          expect(isProduced(it)).toBe(false);
        }
      }
    }
    expect(anchored, '全仓 produced 锚点为 0 —— 逐项证据断言空转').toBeGreaterThanOrEqual(10);
  });

  it('produced 类别分布 ⇄ 逐项统计（自报数字必须有比对面，缺键即假统计）', () => {
    for (const c of SUMMARY.clusters) {
      const tallied = tallyProduced(c.items);
      expect({ ...c.producedByKind }).toEqual(tallied);
      const sum = Object.values(c.producedByKind).reduce((s, n) => s + n, 0);
      expect(sum, c.cluster + ' producedByKind 合计 != total（漏一类即静默丢资产）').toBe(c.total);
    }
  });

  it('分类互斥且穷尽：六类合计 === total，且未消费三键之和 === unconsumed（逐族）', () => {
    for (const c of SUMMARY.clusters) {
      const b = bucketsOf(c.items);
      const sum = CLOSURE_BUCKETS.reduce((s, k) => s + b[k], 0);
      expect(sum, c.cluster + ' 六分类合计 != total').toBe(c.total);
      // ★cycle-78：未消费 = 已声明通道 + 两缺口（语义升级，不是放宽）。
      expect(b.declaredChannel + b.consumedGap + b.producedGap, c.cluster + ' 未消费三键 != unconsumed').toBe(c.unconsumed);
      expect(b.code + b.dynamicClaimed + b.channelOnly, c.cluster + ' 已消费三类 != consumed').toBe(c.consumed);
    }
    // 全量口径与分族汇总同源
    const all = bucketsOf(SUMMARY.clusters.flatMap((c) => c.items));
    expect(all.consumedGap).toBe(SUMMARY.totals.consumedGap);
    expect(all.producedGap).toBe(SUMMARY.totals.producedGap);
    expect(all.dynamicClaimed).toBe(SUMMARY.totals.dynamicClaimed);
    expect(all.declaredChannel).toBe(SUMMARY.totals.channelDeclared);
  });

  it('四族齐备：缺任一族 `assertClustersPresent` 必须响亮抛错（反向自检，逐族）', () => {
    /*
     * 为什么必须逐族反向自检：cycle-75 接线第四族（skills）之前，技能/MCP 面**零覆盖**
     * 却不被任何断言发现——「有壳无表体」的同族形态。若只断言「四族在场」而不证明
     * 「缺族会红」，一旦期望族清单漏写 skills，守卫会静默放行。
     */
    const EXPECTED = ['tools', 'i18n', 'routes', 'skills'];
    expect([...SUMMARY.clusters.map((c) => c.cluster)].sort()).toEqual([...EXPECTED].sort());
    // 前向：齐备时不抛
    expect(() => assertClustersPresent(SUMMARY.clusters)).not.toThrow();
    // 反向：抹掉任一族都必须抛错
    for (const missing of EXPECTED) {
      const subset = SUMMARY.clusters.filter((c) => c.cluster !== missing);
      expect(() => assertClustersPresent(subset), '抹掉 ' + missing + ' 族后未响亮抛错').toThrow();
    }
    // 空集合（零族）同样必须抛错，不能静默通过
    expect(() => assertClustersPresent([])).toThrow();
    // 每族非空下限：任一 total 为 0 即假守卫
    for (const c of SUMMARY.clusters) expect(c.total, c.cluster + ' 族为空').toBeGreaterThan(0);
  });

  it('增族后 totals 自洽：registered/consumed/unconsumed 与分族汇总同源（逐项）', () => {
    const sum = (pick: (c: (typeof SUMMARY.clusters)[number]) => number): number =>
      SUMMARY.clusters.reduce((s, c) => s + pick(c), 0);
    expect(SUMMARY.totals.registered).toBe(sum((c) => c.total));
    expect(SUMMARY.totals.consumed).toBe(sum((c) => c.consumed));
    expect(SUMMARY.totals.codeConsumed).toBe(sum((c) => c.codeConsumed));
    expect(SUMMARY.totals.unconsumed).toBe(SUMMARY.totals.registered - SUMMARY.totals.consumed);
    expect(SUMMARY.totals.unconsumed).toBe(sum((c) => c.unconsumed));
    // 分类合计（全量）= 各族分类合计之和（增族不得让分类账漏算）
    const all = bucketsOf(SUMMARY.clusters.flatMap((c) => c.items));
    const perCluster = { code: 0, dynamicClaimed: 0, channelOnly: 0, consumedGap: 0, producedGap: 0, declaredChannel: 0 };
    for (const c of SUMMARY.clusters) {
      const b = bucketsOf(c.items);
      for (const k of CLOSURE_BUCKETS) perCluster[k] += b[k];
    }
    expect(all).toEqual(perCluster);
    expect(CLOSURE_BUCKETS.reduce((s, k) => s + all[k], 0)).toBe(SUMMARY.totals.registered);
  });
});

describe('cycle-75 T5 技能/MCP 族（第四族）——四族分类 + MCP 清单⇄分分成对性', () => {
  const skillCl = SUMMARY.clusters.find((c) => c.cluster === 'skills');

  it('skills 族分类互斥穷尽：五类合计 === total（新族不得绕过分账）', () => {
    expect(skillCl, 'skills 族缺席 —— 第四族未接进编排器').toBeDefined();
    expect(skillCl?.total ?? 0, 'skills 族为空 —— 假守卫').toBeGreaterThan(0);
    const b = bucketsOf(skillCl?.items ?? []);
    expect(CLOSURE_BUCKETS.reduce((s, k) => s + b[k], 0)).toBe(skillCl?.total);
    expect(b.consumedGap + b.producedGap).toBe(skillCl?.unconsumed);
    expect(b.code + b.dynamicClaimed + b.channelOnly).toBe(skillCl?.consumed);
  });

  it('skills 族 produced 逐项证据：每项 producedAt!==null ⇒ 证据非空且非声明态', () => {
    const items = skillCl?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      if (it.producedAt === null) continue;
      expect(it.producedKind, 'skills|' + it.id).not.toBe('declaration-only');
      expect(it.producedKind).not.toBe('no-write-point');
      expect(it.producedEvidence.length, 'skills|' + it.id + ' 无证据锚点').toBeGreaterThan(0);
    }
    // 非空下限：至少一项真有产出锚点（否则上面的逐项断言空转）
    expect(items.filter((it) => it.producedAt !== null).length).toBeGreaterThan(0);
  });

  it('MCP 成对性：declaredTools ⇄ dispatchCases 集合相等（清单⇄分发无静默缺口）', () => {
    /*
     * 缺口形态（本守卫的目标）：MCP 清单声明了工具但分发器没实现该 case ⇒
     * 工具「看得见、调不动」；或分发器有 case 而清单没声明 ⇒ 幽灵工具。
     * 两者都必须为零，且**数量相等**（集合相等的直接证据）。
     */
    const mcp = mcpSurface(FILES, new Map());
    expect(mcp.declaredTools.length, 'MCP 清单为空 —— 成对性断言空转').toBeGreaterThan(0);
    expect(mcp.dispatchCases.length, 'MCP 分发面为空 —— 成对性断言空转').toBeGreaterThan(0);
    expect(mcp.declaredWithoutDispatch, '声明了却没实现分发').toEqual([]);
    expect(mcp.dispatchWithoutDeclared, '有分发却没声明').toEqual([]);
    expect([...mcp.declaredTools].sort()).toEqual([...mcp.dispatchCases].sort());
    // 每个分发分支必须落到 runScript（否则该 MCP 工具什么都做不了）
    expect(mcp.declaredWithoutWiring, '声明项的分发分支未接 runScript').toEqual([]);
    // 本仓内无 src 启动点 ⇒ 通道级（诚实标注，不硬算 consumed）
    expect(mcp.consumed).toBe(false);
  });

  it('纪律② 反向自检：MCP 成对性判据能判三态（缺 case / 缺声明 / 未接线）', () => {
    const FIXTURE = [
      "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [",
      "  { name: 'init_workflow', description: 'x', inputSchema: {} },",
      "  { name: 'gate_check', description: 'x', inputSchema: {} },",
      "] }));",
      "server.setRequestHandler(CallToolRequestSchema, async (req) => {",
      "  switch (req.params.name) {",
      "    case 'init_workflow': return runScript('init-workflow', req.params.arguments);",
      "    case 'gate_check': return runScript('gate-check', req.params.arguments);",
      "  }",
      "});",
    ].join('\n');
    const at = (text: string): McpSurface => mcpSurface(new Map([[MCP_SERVER_FILE, text]]), new Map());
    // 前向：完整夹具成对
    const base = at(FIXTURE);
    expect(base.declaredWithoutDispatch).toEqual([]);
    expect(base.dispatchWithoutDeclared).toEqual([]);
    expect(base.declaredWithoutWiring).toEqual([]);
    // 变异 1：删掉一个分发 case ⇒ declaredWithoutDispatch 必现
    const dropCase = at(FIXTURE.replace(/\n\s*case 'gate_check'[^\n]*/, ''));
    expect(dropCase.declaredWithoutDispatch).toEqual(['gate_check']);
    // 变异 2：删掉一条声明 ⇒ dispatchWithoutDeclared 必现
    const dropName = at(FIXTURE.replace(/\n\s*\{ name: 'gate_check'[^\n]*/, ''));
    expect(dropName.dispatchWithoutDeclared).toEqual(['gate_check']);
    // 变异 3：case 里不接 runScript ⇒ declaredWithoutWiring 必现
    const unwired = at(FIXTURE.replace("case 'gate_check': return runScript('gate-check', req.params.arguments);",
      "case 'gate_check': return { content: [] };"));
    expect(unwired.declaredWithoutWiring).toEqual(['gate_check']);
    // 响亮失败：缺文件必须抛错（不是静默空表）
    expect(() => mcpSurface(new Map(), new Map())).toThrow();
  });
});

describe('cycle-75 T5 词表计算键分支纪律（两条模板分支 + 调用边界 + 注释 + 消费面）', () => {
  /**
   * 为什么这组断言必须存在（Lead 独立复核 + T2 实测收口的四条）：
   *   ① `dynamicKeyPrefixes` 有两条模板分支（反引号 `${}` / 引号 `+` 拼接），
   *      上一版的模板分支**恒不命中**（搜「反引号紧接 ${」而反引号在首位）——
   *      死代码伪装成功能。必须各喂最小夹具，证明两条分支**都**命中 ≥1。
   *   ② 真实根因是**调用边界**：`agentCards.get(`anic.agent.${…}`)` 的 `get(` 尾串
   *      曾被 `indexOf('t(')` 当成 i18n 调用，凭空造出 `anic.agent.` 前缀。
   *   ③ 注释里的模板写法（文档示例）不得造前缀（stripComments 挡住）。
   *   ④ `assets/**` 是**目标项目**词表的读取方，不是本插件 locale/zh.json 的消费方。
   */
  const allowAll = (): boolean => true;
  /** 单文件夹具。 */
  const fixture = (code: string): Map<string, string> => new Map([['src/client/features/probe/probe.ts', code]]);
  const prefixesOf = (files: Map<string, string>): string[] =>
    dynamicKeyPrefixes(files, allowAll).map((p) => p.prefix);

  it('两条模板分支**各命中 ≥1**（反引号 `${}` 与引号 `+` 拼接；死分支必红）', () => {
    const backtick = prefixesOf(fixture('const a = t(`ns.sub_' + '${x}`);'));
    const plusConcat = prefixesOf(fixture("const b = t('ns.sub.' + x);"));
    expect(backtick, '反引号模板分支未命中 —— 死分支（HEAD 曾恒不命中）').toContain('ns.sub_');
    expect(plusConcat, '引号 + 拼接分支未命中 —— 死分支').toContain('ns.sub.');
    // 分开断言而非合并：两条分支各自独立有牙（合并会让一条命中掩盖另一条死掉）
    expect(backtick).toHaveLength(1);
    expect(plusConcat).toHaveLength(1);
  });

  it('`t(` 词法边界有牙：`get(` 尾串不得造前缀，而 `i18n.t(` 方法调用仍合法', () => {
    // 实测根因形态：agentCards.get(`anic.agent.${gate}.${role}`)
    const viaGet = prefixesOf(fixture('const c = agentCards.get(`anic.agent_' + '${gate}_${role}`);'));
    expect(viaGet, '`get(` 尾串被当成 t( 调用 —— 假阳性发生器复活').toEqual([]);
    // 对照：真的 t( 调用（含 `i18n.t(` 方法形态）必须仍命中 —— 边界不能宽到误杀合法调用
    const viaMethod = prefixesOf(fixture("const d = i18n.t('a.b.' + x);"));
    expect(viaMethod, '`i18n.t(` 是合法翻译调用，不得被边界误杀').toEqual(['a.b.']);
    const viaBare = prefixesOf(fixture('const e = t(`ns.sub_' + '${x}`);'));
    expect(viaBare).toEqual(['ns.sub_']);
  });

  it('实仓前缀集不得含 `anic.agent.`（假阳性已修），生产代码唯一真前缀是 budget.status_', () => {
    /*
     * 自指陷阱（守卫纪律②）：本文件自身躺在 tests/ 里，而 i18n 消费面包含 tests/——
     * 上面几条夹具把 `a.b.` / `ns.sub.` 写进了源码文本，若不排除本文件，
     * 那些**夹具字符串**会被当成「实仓真前缀」，断言就变成同义反复。
     * 故本条只认生产代码面（src/），并把本文件的相对路径从扫描面里剔掉。
     */
    const SELF_REL = fileURLToPath(import.meta.url).slice(ROOT.length + 1).split('\\').join('/');
    const allow = (rel: string): boolean => rel.startsWith('src/') && rel !== SELF_REL;
    const real = [...new Set(dynamicKeyPrefixes(FILES, allow).map((p) => p.prefix))].sort();
    // 前缀集非空下限：空集会让「不含 anic.agent.」变成恒真断言
    expect(real.length, '生产代码前缀集为空 —— 下面的「不含」断言是空转').toBeGreaterThan(0);
    expect(real, '`anic.agent.` 假阳性复活（get( 尾串被当成 t( 调用）').not.toContain('anic.agent.');
    /*
     * 精确集合（不是"至少包含"）：多一个前缀 = 多一个「闭包扫描器认领一整族键」的
     * 出口，而认领是**免死键判定**的通行证——它必须逐条来路明确。
     *   budget.status_    renderBudget 的 t(`budget.status_${…}`)（cycle-74 既有）
     *   config.           配置编辑器的 cfgText/cfgGroupText（cycle-82；曾因前缀经
     *                     常量中转而认领 0 条，导致 55 条 config.* 全判死键——见
     *                     configTypes.ts 的注解与 configEditClient 的回归钉）
     *   graph.lane.      图区类型 lane 名（cycle-82）
     *   graph.verdict.   图区裁决名（cycle-82）
     *   graph.edge.      图区**边类型名**（cycle-91 边语义图例：`graphEdgeLegend.ts`
     *                    的 `t('graph.edge.' + type)`）。登记理由与 graph.lane. 同源——
     *                    边类型的键名是**数据驱动**的（`EDGE_STYLES` 的键），
     *                    静态扫描器看不见具体键名，只能靠前缀族认领。
     *                    边类型键与 lane 键是**同类**：都来自闭合的类型表，
     *                    都必须在 locale 里逐条存在（否则是死键）。
     *   graph.           图区 cycle-83 新增键族（`gt('短名')` → `t('graph.' + suffix)`）：
     *                    tooltip 邻居数 / 小地图说明 / 面包屑五段 / 工具栏分组标签。
     *                    登记理由与 config. 同源——新键在合并进 locale **之前**不得被
     *                    报成幽灵消费，合并**之后**不得被报成死键，前缀形态是唯一同时
     *                    满足两头的形状。逐键清单见 docs/anic/cycle-83-graph-i18n.md。
     *   graph.nodeRole.   图区**节点角色名**（cycle-95 WS-B：`graphNodeCard.ts` 的
     *                    `t('graph.nodeRole.' + role)`，role ∈ hub/orphan/leaf/entry）。
     *                    来路与 graph.lane. / graph.edge. 同源：角色名是**数据驱动**的
     *                    （`NodeRole` 联合），静态扫描器看不见具体键名，只能靠前缀族认领。
     *                    ⚠️ 这 4 个键此前**只存在于 locale、没有消费点**（cycle-94 加键
     *                    未接线）。本前缀的登记标志它们**已经接线**：`graphNodeCard`
     *                    把角色写进节点 aria-label（形状标记是 AT 读不到的第二通道，
     *                    只画形状不播报等于对屏幕阅读器用户不存在）。
     *   workspace.        工作区徽标词族（cycle-95 WS-D：`features/org/workspaceBadge.ts`
     *                    的 `wsText()` → `t('workspace.' + suffix)`；键 = badge / badgeAria /
     *                    unknown / crossProject / crossProjectLine / crossProjectCount）。
     *                    登记理由与 graph. 同源：「徽标六段文案」是**数据驱动**的短名族，
     *                    静态扫描器看不见具体键名，只能靠前缀族认领；且这 6 个键在 locale
     *                    与消费点**同轮新增**（不是先加键后接线的旧形态）。
     *   diag.controlBandStatus.  控制带三态判定名（cycle-96：`renderControlBandRow.ts` 的
     *                    `t(`diag.controlBandStatus.${status}`)`，status ∈ normal/warn/alarm）。
     *                    来路与 graph.verdict. 同源：判定名是**数据驱动**的闭合三值，
     *                    静态扫描器看不见具体键名，只能靠前缀族认领。且 3 个键已与消费点同轮落地。
     * 新增前缀必须同时在这里登记并说明来路，否则本断言红——这是设计意图。
     */
    expect(real, '生产代码前缀集变化：新增前缀须在此登记来路（认领 = 免死键通行证）')
      .toEqual(['budget.status_', 'config.', 'diag.controlBandStatus.', 'graph.', 'graph.edge.', 'graph.lane.', 'graph.nodeRole.', 'graph.verdict.', 'workspace.']);
    expect(endsWithSeparator('budget.status_')).toBe(true);
    expect(endsWithSeparator('a.')).toBe(true);
    expect(endsWithSeparator('a')).toBe(false);
  });

  it('注释不造前缀：把模板写进注释，前缀集不得包含它（去注释纪律）', () => {
    const commented = fixture('// t(`closure.cluster_' + '${x}`)');
    expect(prefixesOf(commented), '注释里的模板写法造出了假前缀').toEqual([]);
    // 对照：同样的模板在**活代码**里必须命中（证明不是判据整体失效）
    const live = fixture('const z = t(`closure.cluster_' + '${x}`);');
    expect(prefixesOf(live)).toEqual(['closure.cluster_']);
  });

  it('assets/ 不构成消费：只在 assets/** 引用的键必须 consumed=false', () => {
    const files = new Map<string, string>([
      ['locale/zh.json', JSON.stringify({ probe: { key: 'x' } })],
      ['assets/skill.mjs', "const v = t('probe.key');"],
    ]);
    const audit = i18nClosure(files);
    expect(audit.total).toBe(1);
    expect(audit.consumed, 'assets/ 被当成本插件词表的消费方（语义错误）').toBe(0);
    expect(audit.items[0]?.consumed).toBe(false);
    expect(audit.items[0]?.evidence).toEqual([]);
  });
});

describe('cycle-75 T5 投影截断与排序（总数永不截断，真缺口排在前面）', () => {
  /**
   * 冻结契约 §1.4 的优先级（真缺口在前）。
   * ★cycle-78：新增 declaredChannel 在**末尾**——已声明通道无待办（只需维持文档），
   * 截断时应当最先被丢弃；与宿主 closureView.VIEW_ORDER 的权重同序。
   * 与 CLOSURE_BUCKETS 同步由下方断言钉住。
   */
  const PRIORITY = ['consumedGap', 'producedGap', 'dynamicClaimed', 'channelOnly', 'code', 'declaredChannel'];

  it('优先级表与冻结契约的桶集完全同步（漏同步即红）', () => {
    expect([...PRIORITY].sort()).toEqual([...CLOSURE_BUCKETS].sort());
    expect(UNCONSUMED_VIEW_LIMIT).toBeGreaterThan(0);
  });

  it('总数永不截断：truncation.total === 服务端未消费总数；明细 ≤ 上限', () => {
    const view = toClosureView(SUMMARY);
    const t = view.truncation.unconsumed;
    expect(t.total, '总数被截断了 —— 计数必须永远完整').toBe(SUMMARY.unconsumed.length);
    expect(t.shown).toBe(view.unconsumed.length);
    expect(view.unconsumed.length).toBe(Math.min(t.total, UNCONSUMED_VIEW_LIMIT));
    expect(t.truncated).toBe(t.total > t.shown);
    expect(view.unconsumed.length).toBeLessThanOrEqual(UNCONSUMED_VIEW_LIMIT);
  });

  it('截断时真缺口一条不落：全部 consumedGap/producedGap 必须在明细里（排序判据的实证）', () => {
    const view = toClosureView(SUMMARY);
    /*
     * ★cycle-78 语义升级：本仓的 consumedGap 现为 **0**——那 46 条「生产了没人读」的
     * 路由已被通道声明认领为 declaredChannel（声明 ≠ 豁免：它们仍是未消费，只是
     * 不再是「未知缺口」）。故基线改用**两缺口之和**（producedGap=39 词表键仍非零），
     * 断言本体不变：截断只许丢已声明通道，不许丢任何待办缺口。
     */
    const gapKeys = SUMMARY.unconsumed
      .filter((i) => bucketOf(i) === 'consumedGap' || bucketOf(i) === 'producedGap')
      .map((i) => i.cluster + '|' + i.id);
    expect(gapKeys.length, '本仓无待办缺口 —— 排序断言空转').toBeGreaterThan(0);
    if (!view.truncation.unconsumed.truncated) return;
    const shown = new Set(view.unconsumed.map((i) => i.cluster + '|' + i.id));
    const hiddenGaps = gapKeys.filter((k) => !shown.has(k));
    expect(hiddenGaps, '真缺口被截断藏起来了：\n' + hiddenGaps.join('\n')).toEqual([]);
  });

  it('明细排序非降（真缺口在前）+ 只含未消费项 + 两次投影确定性相等', () => {
    const view = toClosureView(SUMMARY);
    const rank = (b: string): number => PRIORITY.indexOf(b);
    const seq = view.unconsumed.map((i) => rank(bucketOf(i)));
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i], '排序违反「真缺口在前」').toBeGreaterThanOrEqual(seq[i - 1] as number);
    }
    // 只含未消费项（bucketOf 需要真实 ClosureItem —— 用服务端清单反查）
    const unconsumedKeys = new Set(SUMMARY.unconsumed.map((i) => i.cluster + '|' + i.id));
    for (const i of view.unconsumed) expect(unconsumedKeys.has(i.cluster + '|' + i.id)).toBe(true);
    // 确定性：同一输入两次投影逐 id 相等（排序依赖 Map/对象遍历顺序即为不确定）
    const again = toClosureView(SUMMARY).unconsumed.map((i) => i.cluster + '|' + i.id);
    expect(again).toEqual(view.unconsumed.map((i) => i.cluster + '|' + i.id));
  });
});

/* ── 变异原语（内存夹具；供本文件与 mutation 契约共用思路）── */

/** 复制 Map 并替换单文件内容（**不写盘**）。 */
function withFile(files: Map<string, string>, rel: string, text: string): Map<string, string> {
  const clone = new Map(files);
  clone.set(rel, text);
  return clone;
}

/** 从 marker 所在行的**整条语句**（配平到 `;`）删掉——保证变异后语法仍完整。 */
function cutStatement(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  const start = text.lastIndexOf('\n', at) + 1;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inStr !== null) {
      if (c === BS) { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === SQ || c === DQ || c === BT) { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) {
        const semi = text.indexOf(';', i);
        return text.slice(0, start) + text.slice(semi + 1);
      }
    }
  }
  throw new Error('unbalanced statement at ' + marker);
}
