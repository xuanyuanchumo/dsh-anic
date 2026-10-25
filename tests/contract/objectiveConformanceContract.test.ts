/**
 * **目标一致性契约**（objective conformance，cycle-76 建立）。
 *
 * ## 为什么把「目标」写成测试
 *
 * 用户诉求是复合句：「确保所有功能业务的**注册、生产与消费**，确保**连通性逻辑性**，
 * 同时要**白盒透明化、可视化流动**等可观测性」。复合目标最容易的失败形态是
 * **完成了其中几项就宣布全部完成**——没有任何东西会拦住这种自述。
 *
 * 本文件把目标**逐词拆成可判定的断言**，每条给出实测证据；任一条不成立即红。
 * 它是「目标层」的守卫：下面的专项契约（真值 / 分类 / 连通性 / 渲染 / 流动）
 * 各自守一面，本文件守**它们必须同时在位**。
 *
 * ## 逐条对应（判据均可机器复算）
 *
 * ① 注册 —— 四族来自**单一注册表**（工具/词表/路由/技能），不是手写清单；逐族非空
 * ② 生产 —— 每项 `producedAt` 非空者必须带**证据类别**，不得混入「仅声明 / 无写入点」
 * ③ 消费 —— 六分类**互斥且穷尽**（`clustersConsistent` 为空；cycle-78 增 declaredChannel）
 * ④ 连通性 —— 入口到资产的调用链**全通**且**零空转注册器**
 * ⑤ 逻辑性 —— 流恒等式 / 截断总数一致 / 缺口两分类覆盖 三条同时成立
 * ⑥ 白盒 —— 投影过 fail-closed 形状守卫，且**不含本地绝对路径**
 * ⑦ 可视化流动 —— 四族可建流、非空、节点/边由数据派生
 * ⑧ 真值 —— 路由注册点与 README 的**独立**计数器一致且逐项有真注册点
 *
 * 纪律：只读（R-31）；一次全仓扫描（真机面 ~7-15s，用显式 timeout）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClosureAudit, bucketOf, clustersConsistent, toClosureView, UNCONSUMED_VIEW_LIMIT, validateDeclarations } from '../../src/host/closureAudit/registryClosure.ts';
import { scanRouteDefs } from '../../src/host/closureAudit/assetClosure.ts';
import { buildConnectivity, assertConnectivityComplete } from '../../src/host/closureAudit/connectivity.ts';
import { buildClosureFlow } from '../../src/client/features/closure/closureFlowGraph.ts';
import { isClosureView } from '../../src/client/features/closure/closureTypes.ts';
import { buildFileIndex, buildTextMap } from '../../src/host/closureAudit/scanPrimitives.ts';

const ROOT = process.cwd();
const SEP = String.fromCharCode(92);
const FILES = buildTextMap(ROOT, buildFileIndex(ROOT));
const SUMMARY = runClosureAudit(ROOT);
const VIEW = toClosureView(SUMMARY);
const CONN = buildConnectivity(FILES);
const FLOW = buildClosureFlow(VIEW);

describe('目标一致性契约（注册·生产·消费 + 连通性逻辑性 + 白盒流动）', () => {
  it('① 注册：四族齐备且来自单一注册表（不是手写清单）', () => {
    expect(SUMMARY.clusters.map((c) => c.cluster)).toEqual(['tools', 'i18n', 'routes', 'skills']);
    for (const c of SUMMARY.clusters) {
      expect(c.total, c.cluster + ' 族为空（空集恒绿是假守卫）').toBeGreaterThan(0);
      expect(c.items.length).toBe(c.total);
    }
    expect(SUMMARY.totals.registered).toBe(SUMMARY.clusters.reduce((s, c) => s + c.total, 0));
  });

  it('② 生产：producedAt 非空者必须带证据类别（不得混入仅声明/无写入点）', () => {
    const produced = SUMMARY.clusters.flatMap((c) => c.items.filter((i) => i.producedAt !== null));
    expect(produced.length).toBeGreaterThan(0);
    const contaminated = produced.filter((i) => i.producedKind === 'declaration-only' || i.producedKind === 'no-write-point');
    expect(contaminated.map((i) => i.cluster + '|' + i.id)).toEqual([]);
    // 有产出的项必须有 evidence 锚点（一个数字没有证据就是自述）
    for (const i of produced) expect(i.producedEvidence.length).toBeGreaterThan(0);
  });

  it('③ 消费：六分类互斥且穷尽（自洽校验为空）', () => {
    expect(clustersConsistent(SUMMARY.clusters)).toEqual([]);
    const cl = SUMMARY.clusters;
    expect(cl.length).toBe(4);
    // cycle-78 升级恒等式（**不得放宽**）：未消费 = 已声明通道 + 两缺口。
    // 旧口径（consumedGap + producedGap === unconsumed）在 46 条通道声明注入后必然破：
    // 那 46 条不再是「未知缺口」，而是「已知通道」——这正是本轮的语义升级。
    expect(SUMMARY.totals.channelDeclared + SUMMARY.totals.consumedGap + SUMMARY.totals.producedGap)
      .toBe(SUMMARY.totals.unconsumed);
    // 已消费 = 生产代码 + 仅通道（计算键项的证据也是 code，故用 codeConsumed + channelOnly）。
    expect(SUMMARY.totals.consumed).toBe(SUMMARY.totals.codeConsumed + SUMMARY.totals.channelOnly);
    expect(SUMMARY.totals.registered).toBe(SUMMARY.totals.consumed + SUMMARY.totals.unconsumed);
  });

  it('④ 连通性：入口到资产的调用链全通且零空转注册器', () => {
    assertConnectivityComplete(CONN);
    expect(CONN.hops.map((h) => h.id)).toEqual([
      'entry→routes', 'routes→aggregator', 'aggregator→registrars',
      'entry→tools', 'tools→gateways', 'entry→skill',
    ]);
    for (const h of CONN.hops) expect(h.ok, '断链: ' + h.id).toBe(true);
    expect(CONN.routeRegistrars.filter((r) => r.wired).length).toBe(CONN.routeRegistrars.length);
    expect(CONN.toolRegistrars.filter((r) => r.wired).length).toBe(CONN.toolRegistrars.length);
    expect(CONN.orphanRegistrars).toEqual([]);
    expect(CONN.connected).toBe(true);
  });

  it('⑤ 逻辑性：流恒等式 + 截断总数一致 + 缺口两分类覆盖', () => {
    for (const c of FLOW.clusters) {
      expect(c.notProduced + c.producedNotConsumed, c.cluster + ' 流恒等式破').toBe(c.registered - c.consumed);
    }
    const tr = VIEW.truncation.unconsumed;
    expect(tr.total).toBe(SUMMARY.totals.unconsumed);
    expect(VIEW.unconsumed.length).toBe(Math.min(SUMMARY.totals.unconsumed, UNCONSUMED_VIEW_LIMIT));
    expect(tr.truncated).toBe(tr.total > tr.shown);
    // cycle-78：投影里的三键恒等式同样成立（服务端 totals 与投影同源，不得各算一套）。
    expect((VIEW.totals.channelDeclared ?? 0) + VIEW.totals.consumedGap + VIEW.totals.producedGap)
      .toBe(VIEW.totals.unconsumed);
  });

  it('⑥ 白盒：投影过 fail-closed 守卫且不含本地绝对路径', () => {
    expect(isClosureView(VIEW)).toBe(true);
    const json = JSON.stringify(VIEW);
    expect(json).not.toContain(String.fromCharCode(58, 92)); // ":\"（Windows 盘符）
    expect(VIEW.connectivity, '连通性必须进投影（否则白盒面看不见空心注册）').toBeDefined();
    expect(VIEW.notes.length).toBeGreaterThanOrEqual(4);
  });

  it('⑦ 可视化流动：四族建流、节点/边由数据派生', () => {
    expect(FLOW.empty).toBe(false);
    expect(FLOW.clusters.length).toBe(SUMMARY.clusters.length);
    expect(FLOW.nodes.length).toBeGreaterThan(0);
    expect(FLOW.edges.length).toBeGreaterThan(0);
    // 数据驱动：节点 id 必须带实际族名（不是硬编码清单）
    for (const c of SUMMARY.clusters) {
      expect(FLOW.nodes.some((n) => n.cluster === c.cluster), '缺族节点 ' + c.cluster).toBe(true);
    }
  });

  it('⑧ 真值：路由注册点与 README 独立计数器一致且逐项有真注册点', () => {
    const defs = scanRouteDefs(FILES);
    expect(defs.length).toBe(63); // README 契约口径（readmeNumbersContract 独立复算同一数）
    expect(defs.filter((d) => d.producedAt !== null).length).toBe(63);
  });

  /* ── 以下四条对应 objective 的**扩展限定**（质量属性与全生命周期评审体系）── */

  it('⑨ 质量产物：测试报告 / 非功能验证报告 / 交付清单 三项证据齐备（Q2+Q8 的可判形式）', () => {
    const cycles = join(ROOT, '.cycles', 'cycles');
    const dirs = readdirSync(cycles).filter((d) => /^cycle-\d+$/.test(d))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
    expect(dirs.length, '无循环工作区').toBeGreaterThan(0);
    // 取**最新**循环（本轮产物所在）——旧循环不必回溯补齐
    const latest = join(cycles, dirs[dirs.length - 1] as string);
    const reports = join(latest, 'test-reports');
    expect(existsSync(reports), '缺 test-reports 目录（Q2 判据）').toBe(true);
    expect(readdirSync(reports).filter((f) => f.endsWith('.md')).length, 'Q2：测试报告为空').toBeGreaterThan(0);
    expect(existsSync(join(latest, '非功能验证报告.md')), '缺非功能验证报告').toBe(true);
    const checklist = join(latest, '交付清单.md');
    expect(existsSync(checklist), '缺交付清单（Q8 判据）').toBe(true);
    const text = readFileSync(checklist, 'utf8');
    for (const item of ['最终测试报告', '非功能验证报告', '文档更新记录', '审计日志']) {
      expect(text.includes(item), '交付清单缺项：' + item).toBe(true);
    }
  });

  it('⑩ 中文注释：src/ 下**每个有注释的文件**都含中文注释（用户明确点名的工程化规范）', () => {
    const CJK = /[\u4e00-\u9fff]/;
    const pureEnglish: string[] = [];
    let withComments = 0;
    for (const [rel, raw] of FILES) {
      if (!rel.startsWith('src/') || !rel.endsWith('.ts')) continue;
      let commentLines = 0;
      let hasCjk = false;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
        if (!isComment) continue;
        commentLines += 1;
        if (CJK.test(line)) hasCjk = true;
      }
      if (commentLines === 0) continue;
      withComments += 1;
      if (!hasCjk) pureEnglish.push(rel + ' (' + String(commentLines) + ' 注释行)');
    }
    expect(withComments, '扫描集为空 = 假守卫').toBeGreaterThan(100);
    expect(pureEnglish, '纯英文注释文件：' + pureEnglish.slice(0, 5).join(', ')).toEqual([]);
  });

  it('⑪ 模块化生产级架构：无超 250 行文件 + 无运行时 import 环', async () => {
    // (a) 单文件上限（与 truthAudit T3 同口径，此处独立复算）
    const oversized: string[] = [];
    for (const [rel, raw] of FILES) {
      if (!rel.startsWith('src/')) continue;
      const n = raw.split('\n').length;
      if (n > 250) oversized.push(rel + '=' + String(n));
    }
    expect(oversized, '超 250 行：' + oversized.join(', ')).toEqual([]);

    // (b) 运行时 import 环 —— **复用技能包自带的分类器**（importGraph.mjs），
    //     不在此重写一份：它会正确排除 re-export / type-only 边（本仓既有教训：
    //     重写判定 = 两套口径漂移）。真实运行环才计入。
    const { collectImportGraph, findCircularDeps } = await import(
      pathToFileURL(join(ROOT, 'assets', 'skill', 'scripts', 'lib', 'importGraph.mjs')).href
    ) as { collectImportGraph: (d: string) => unknown; findCircularDeps: (g: unknown) => string[][] };
    const graph = collectImportGraph(ROOT);
    const cycles = findCircularDeps(graph);
    expect(cycles, '运行时 import 环：' + cycles.slice(0, 3).map((c) => c.join(' -> ')).join(' ; ')).toEqual([]);
  });

  it('⑫ 性能预算（棘轮）：全量体检必须 < 2500 ms —— 防回退到 7.9 s 的 O(项×全仓行) 实现', () => {
    // 实测 453 ms（倒排索引）；留 5.5× 余量防抖动。回退到旧实现（7933 ms）必红。
    const t0 = performance.now();
    runClosureAudit(ROOT);
    const elapsed = performance.now() - t0;
    expect(elapsed, '全量体检耗时 ' + elapsed.toFixed(0) + ' ms 超预算——检查 evidenceIndex 是否被绕过').toBeLessThan(2500);
  });

  /*
   * ★cycle-78（目标层的第 13 条）：把「46 条未消费路由」从**未知缺口**变成
   * **已声明通道**——这是「白盒透明化、可量化、可观测」在路由面的最后一段。
   *
   * 判据三重：① 每条未消费路由都带声明三元组（owner/docRef/reason）；
   * ② 归类为 declaredChannel（不是 consumedGap 红点）；③ 声明后**仍是未消费**
   * ——「声明 ≠ 豁免」，谁把它当白名单就该在这里被拦下。
   * 双向一致（幽灵声明 / 漏声明）由 closureAuditContract ④③ 逐项钉，此处只
   * 验证目标层「这一柄确实装上了」。
   */
  it('⑬ 通道声明：未消费路由全部有机器可读声明，且声明不是豁免（棘轮绿）', () => {
    const routeCl = SUMMARY.clusters.find((c) => c.cluster === 'routes');
    const unconsumedRoutes = (routeCl?.items ?? []).filter((i) => !i.consumed);
    expect(unconsumedRoutes.length, '无未消费路由 —— 本节断言空转').toBeGreaterThan(0);
    for (const i of unconsumedRoutes) {
      expect(i.declaredChannel, '未消费路由缺声明：' + i.id).toBeDefined();
      expect(bucketOf(i), i.id + ' 未被归入 declaredChannel').toBe('declaredChannel');
    }
    // 声明 ≠ 豁免：计数上仍算未消费，只是被点名归类。
    expect(SUMMARY.totals.channelDeclared).toBe(unconsumedRoutes.length);
    expect(SUMMARY.unconsumed.some((i) => i.cluster === 'routes'), '已声明通道被移出了未消费清单').toBe(true);
    // 双向一致 + 无漏声明（机器可判，不靠肉眼）。
    const m = validateDeclarations(
      (routeCl?.items ?? []).map((i) => i.id),
      unconsumedRoutes.map((i) => i.id),
    );
    expect(m.undeclaredRoutes, '漏声明的未消费路由：' + m.undeclaredRoutes.join(', ')).toEqual([]);
    expect(m.staleDeclarations, '幽灵声明：' + m.staleDeclarations.join(', ')).toEqual([]);
  });
}, 120_000);
