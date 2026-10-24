/**
 * 闭环体检扫描行为直测（cycle-72 T-7207）——可复算的实测出口。
 *
 * 本文件有两个职责：
 *   ① 单元面：三态矩阵的行为断言（未消费判定、幽灵为 0、计数自洽）；
 *   ② 复算出口：console.log 一行 JSON 汇总，任何人可用同一条命令独立复现数字。
 *
 * 复算命令（仓库根）：
 *   node node_modules/vitest/vitest.mjs run --config vitest.config.ts --root . \
 *     tests/unit/closureAuditScan.test.ts --reporter=verbose
 *
 * 纪律：本文件内凡是**已知缺口项**的引用一律拼接构造（['state','retry'].join('.')），
 * 否则测试自己就成了那个键的消费方，把被检测的缺口掩盖掉（自指陷阱）。
 */
import { describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  boundaryContains,
  buildFileIndex,
  buildTextMap,
  kindOf,
  quoteClasses,
  stripComments,
} from '../../src/host/closureAudit/scanPrimitives.ts';
import { keyAnchor, flattenKeys, i18nGhosts, routeGhosts } from '../../src/host/closureAudit/assetClosure.ts';
import {
  assertClustersPresent,
  clustersConsistent,
  runClosureAudit,
  toClosureView,
  UNCONSUMED_VIEW_LIMIT,
} from '../../src/host/closureAudit/registryClosure.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const summary = runClosureAudit(ROOT);

/** 缺口项拼接构造（见文件头自指陷阱说明）。 */
const gapKey = (...parts: string[]): string => parts.join('.');
const gapRoute = (...parts: string[]): string => parts.join('/');

describe('cycle-72 T-7207 闭环体检（可复算出口）', () => {
  it('打印一行 JSON 汇总（复算出口；同命令可独立复现）', () => {
    assertClustersPresent(summary.clusters);
    const line = JSON.stringify({
      scannedFiles: summary.scannedFiles,
      totals: summary.totals,
      clusters: summary.clusters.map((c) => ({
        cluster: c.cluster, total: c.total, consumed: c.consumed,
        codeConsumed: c.codeConsumed, unconsumed: c.unconsumed,
      })),
    });
    console.log('CLOSURE_SUMMARY ' + line);
    expect(summary.scannedFiles).toBeGreaterThan(100);
  });

  it('三族口径自洽：consumed/ unconsumed / codeConsumed 计数与逐项统计一致', () => {
    expect(clustersConsistent(summary.clusters)).toEqual([]);
    expect(summary.totals.unconsumed).toBe(summary.totals.registered - summary.totals.consumed);
    expect(summary.totals.codeConsumed).toBeLessThanOrEqual(summary.totals.consumed);
  });

  it('工具族消费面分两级：code（生产代码内）与 channel（测试/agent 卡）不混同', () => {
    const t = summary.clusters.find((c) => c.cluster === 'tools');
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.codeConsumed).toBeGreaterThan(0);
    expect(t.codeConsumed).toBeLessThanOrEqual(t.consumed);
    // 每一个 code 项都至少有一条 src/ 证据；channel 项则一条 src/ 证据都没有
    for (const it2 of t.items) {
      if (it2.evidenceKind === 'code') expect(it2.evidence.some((h) => h.startsWith('src/'))).toBe(true);
      else if (it2.evidenceKind === 'channel') expect(it2.evidence.some((h) => h.startsWith('src/'))).toBe(false);
    }
  });

  it('已知真实缺口可被报出（棘轮基线：修掉任一缺口必须同步更新本清单）', () => {
    const unconsumedIds = new Set(summary.unconsumed.map((x) => x.cluster + '|' + x.id));
    const known = [
      'i18n|' + gapKey('state', 'retry'),
      'i18n|' + gapKey('techdebt', 'title'),
      'i18n|' + gapKey('gate', 'PASS'),
      'routes|' + gapRoute('/anic', 'flows', 'gate-check', 'run'),
      'routes|' + gapRoute('/anic', 'self', 'gate-check'),
      'routes|' + gapRoute('/anic', 'api', 'trust'),
    ];
    const reported = known.filter((k) => unconsumedIds.has(k));
    expect(reported.length, '至少一个已知真实缺口必须被体检报出（报告器失效即红）').toBeGreaterThanOrEqual(1);
    // 基线快照：清单里的每一条当前都应为未消费（修好后请更新本清单，不要放宽断言）
    expect(known.filter((k) => !unconsumedIds.has(k)), '这些缺口已被消费——请更新棘轮清单').toEqual([]);
  });

  it('幽灵消费为 0（当前实测；若不为 0 必须红并解释原因）', () => {
    expect(summary.ghost.map((g) => g.cluster + '|' + g.id)).toEqual([]);
  });

  it('客户端投影不含本地绝对路径（rootDir 不出服务端）', () => {
    const view = toClosureView(summary);
    expect(JSON.stringify(view)).not.toContain(':\\');
    // 精确键集：这是「rootDir 不出服务端」的核心安全断言，**不得删除**。
    // cycle-75 additive 变更：新增 truncation（明细截断如实上报）——同步加入而非放宽。
    expect(Object.keys(view).sort()).toEqual(['clusters', 'generatedAt', 'ghost', 'notes', 'totals', 'truncation', 'unconsumed']);
    expect(view.notes.length).toBeGreaterThanOrEqual(4);
  });

  /*
   * cycle-75 投影截断语义（「总数永不截断」的证据）。
   *
   * 语义要点（易错）：`truncation.total` = **服务端未消费总数**，
   * 而 `view.unconsumed.length` = min(total, LIMIT)。故：
   *   未截断 ⇒ 两者相等；
   *   已截断 ⇒ 明细更短、且 truncated === true —— 计数仍然完整。
   */
  it('投影截断：总数永不截断，明细 ≤ 上限，且 truncated 与二者之差自洽', () => {
    const view = toClosureView(summary);
    const t = view.truncation.unconsumed;
    expect(t.total).toBe(summary.unconsumed.length);
    expect(t.shown).toBe(view.unconsumed.length);
    expect(view.unconsumed.length).toBe(Math.min(t.total, UNCONSUMED_VIEW_LIMIT));
    expect(t.truncated).toBe(t.total > t.shown);
    if (t.truncated) expect(view.unconsumed.length).toBeLessThan(t.total);
    else expect(view.unconsumed.length).toBe(t.total);
  });
});

describe('cycle-72 扫描原语行为（判定器有牙）', () => {
  it('boundaryContains 精确边界：/anic/api/ledger 不吞 /anic/api/ledger/append', () => {
    expect(boundaryContains("fetch('/anic/api/ledger')", '/anic/api/ledger')).toBe(true);
    expect(boundaryContains("fetch('/anic/api/ledger/append')", '/anic/api/ledger')).toBe(false);
    expect(boundaryContains('const x = 1 // /anic/api/ledger', '/anic/api/ledger/append')).toBe(false);
  });

  it('stripComments 保留换行：注释被清空但行号不变（正则字面量失衡的哨兵）', () => {
    const src = 'a\n// b /anic/x\nc\n';
    const out = stripComments(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('/anic/x');
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  it('quoteClasses 提供三种引号（正则构造不写字面引号，避免去注释状态机失衡）', () => {
    expect(quoteClasses()).toHaveLength(3);
    expect(quoteClasses()).toContain(String.fromCharCode(39));
    expect(quoteClasses()).toContain(String.fromCharCode(34));
    expect(quoteClasses()).toContain(String.fromCharCode(96));
  });

  it('自指哨兵：去注释后本仓体检模块的后续代码仍可见（若状态机失衡，标记会消失）', () => {
    const files = buildTextMap(ROOT, buildFileIndex(ROOT));
    for (const rel of ['src/host/closureAudit/scanPrimitives.ts', 'src/host/closureAudit/assetClosure.ts']) {
      const raw = files.get(rel);
      expect(raw, rel + ' 未进索引').toBeDefined();
      const cleaned = stripComments(raw ?? '');
      // 文件末段的导出标记必须仍在（失衡时整段被当成字符串吞掉）
      expect(cleaned).toContain('export function');
      expect(cleaned.split('\n').length).toBe((raw ?? '').split('\n').length);
    }
  });

  it('kindOf 分类：src/ 证据=code，其余=channel，空=none', () => {
    expect(kindOf([])).toBe('none');
    expect(kindOf(['tests/unit/a.test.ts:3'])).toBe('channel');
    expect(kindOf(['src/client/x.ts:1'])).toBe('code');
    expect(kindOf(['tests/unit/a.test.ts:3', 'src/client/x.ts:1'])).toBe('code');
  });

  it('flattenKeys / keyAnchor：词表展平与锚点行号可用（扫描集非空）', () => {
    expect(flattenKeys({ a: { b: 'x' }, c: 'y' })).toEqual(['a.b', 'c']);
    const raw = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8')) as Record<string, unknown>;
    expect(flattenKeys(raw).length).toBeGreaterThan(200);
    const anchor = keyAnchor(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'), 'meta.title');
    expect(anchor).toMatch(/^locale\/zh\.json:\d+$/);
  });
  it('反向自检：幽灵检出器本身可失败（夹具构造真幽灵 → 检出=1）', () => {
    // 纪律：只断言「ghost 为空」等于恒真装饰——必须证明检出器在真幽灵上确实会红。
    // 夹具用拼接构造（见文件头自指陷阱说明），避免测试自己成为该键的消费方。
    const fakeKey = gapKey('phantomzone', 'neverRegistered');
    const fakeFiles = new Map<string, string>([
      ['src/client/features/probe/probe.ts', "export const x = t('" + fakeKey + "');"],
    ]);
    expect(i18nGhosts(fakeFiles, [] as string[])).toEqual([fakeKey]);
    // 反向对照：同一键被登记后就不再是幽灵（证明判定读的是注册表而不是恒真）
    expect(i18nGhosts(fakeFiles, [fakeKey] as string[])).toEqual([]);
  });

  it('反向自检：幽灵**路由**检出器可失败（未注册的 /anic/... 引用必须被点名）', () => {
    const fakeRoute = gapRoute('', 'anic', 'api', 'phantom-zone');
    const fakeFiles = new Map<string, string>([
      ['src/client/features/probe/probe.ts', "export const u = '" + fakeRoute + "';"],
    ]);
    expect(routeGhosts(fakeFiles, [] as string[])).toEqual([fakeRoute]);
    expect(routeGhosts(fakeFiles, [fakeRoute] as string[])).toEqual([]);
  });
});
