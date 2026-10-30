/**
 * cycle-80 WS-2 · coverage 证据链契约（测量面 → 判定面）
 *
 * 被守卫缺陷：`.cycles/config.yml` 的 `gates.G2.coverage_threshold` 声明 lines 80 / branches 65，
 * 但 `@vitest/coverage-v8` 从未安装（require.resolve 直接失败），G2 实际只查测试报告与
 * journey 覆盖——"声明了阈值却从不测量"= 装饰性声明：没有测量的阈值否决不了任何东西。
 *
 * 实测（2026-10-26 `node scripts/coverage.mjs` 全量；当次套件 2064 passed / 2 failed，两个红项是
 * objectiveConformance ⑨（循环 test-reports 为空）与 ⑫（带插桩时全量体检 2.7s > 2.5s 预算），
 * 均与测量面无关）：
 *   lines 87.27% (13795/15806) · statements 87.27% (13795/15806)
 *   functions 88.69% (902/1017) · branches 83.26% (5125/6155)
 *    （同日多次运行为 lines 87.15–87.27 / branches 83.22–83.27——并发改动带来 ±0.12pp 抖动，
 *      故契约只对阈值做断言，不钉实测快照数字，避免"测量值变一点就假红"。）
 *   → **达到**声明阈值（80/65），故本契约做「达标断言」，不设地板棘轮。
 *   225 个 src 源码文件计入分母（all:true：未被测试导入的客户端文件按 0% 计，不隐藏）。
 *
 * 最差 5 文件（按行数权重的真实拖累，非 0% 噪声）：
 *   src/host/routes/flowsRoute.ts       lines 77.84% (176) branches 40.69% (86)
 *   src/host/tools.ts                   lines 59.28% (167) branches 62.50% (16)
 *   src/host/flows/gateCheckFlow.ts     lines 23.62% (127) branches 100.00% (0 分支可测)
 *   src/client/features/graph/gateColors.ts lines 35.53% (121)
 *   src/client/WorkflowGraphPanel.ts    lines  0.00% (120)
 * 另有 8 个文件 0%：全部是 client/ 面（由 offline-smoke 经 dist 机制冒烟覆盖，
 * 不进 vitest 断言面）——这是诚实的边界，不是漏测。
 *
 * 判定四层（全部真读 JSON / 真读配置，不读文本、不硬编码实测值）：
 *   ① wiring：vitest.config.ts 声明 v8 + text-summary/json-summary + 循环工件目录 +
 *      reportOnFailure（否则测试一红就不产摘要，证据在最需要时消失）；
 *   ② 工件：coverage-summary.json 必须存在——缺失即**明确失败**（不 SKIP：没有证据 ≠ 通过）；
 *   ③ 达标：config.yml 声明值与承诺值 80/65 双向绑定（防悄悄下调），再断言实测不低于声明值；
 *   ④ 防伪造：四指标的文件级 covered/total 合计必须逐项等于 total，且路径必须在 src/ 下、
 *      文件数 ≥100（否则 1 个文件的手写摘要就能冒充全量）。
 *
 * 时序分工（先踩坑后设计）：契约在测试**进行中**运行，而本轮摘要在测试结束后才写；vitest 的
 * clean 又发生在 start() 阶段（先删上一轮）。所以本契约只能守护"上一次已落盘的证据"，
 * 本轮数字是否达标的判定放在 scripts/coverage.mjs 第 4 步（运行结束现场判定）。配置里因此
 * 显式 `clean: false`——否则同一次 coverage 运行里本契约必然读到"文件不存在"而假红（实测 3 红）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_TS = join(ROOT, 'vitest.config.ts');
const GATE_CONFIG = join(ROOT, '.cycles', 'config.yml');
/**
 * coverage 证据文件的**解析器**（cycle-86：不再硬编码轮号）。
 *
 * 原实现写死 `cycles/cycle-80/coverage/coverage-summary.json`。cycle-86 执行基线重置后，
 * cycle-80 被搬进 `.cycles/archive/`，本契约立刻变成"证据缺失"假红——而证据其实还在，
 * 只是换了位置。硬编码轮号让"归档"这个**被鼓励的运维动作**反过来弄红测试，是判据设计错误。
 *
 * 现在的判据是**语义**的：在活跃区与归档区里找**最新一轮带 coverage 摘要的工件**；
 * 一个都没有才失败（"没有测量"依然是红的，不放宽）。
 */
function findCoverageSummary(): string | null {
  const bases = [join(ROOT, '.cycles', 'cycles'), join(ROOT, '.cycles', 'archive')];
  const candidates: Array<{ num: number; path: string }> = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const m = /^cycle-(\d+)$/.exec(name);
      if (!m) continue;
      const p = join(base, name, 'coverage', 'coverage-summary.json');
      if (existsSync(p)) candidates.push({ num: Number(m[1]), path: p });
    }
  }
  if (candidates.length === 0) return null;
  // 取**最新**一轮（编号最大）；同号并存时活跃区优先（bases 顺序已保证）。
  candidates.sort((a, b) => b.num - a.num);
  return candidates[0]?.path ?? null;
}

/** 声明阈值的承诺值：config.yml 与这两个数字必须一致（两侧任一被改都判红）。 */
const PROMISED = { lines: 80, branches: 65 };
/** 全量摘要的文件数下限（当前 225；防"手写 1 个文件"的假摘要冒充全量证据）。 */
const MIN_FILES = 100;
const METRICS = ['lines', 'statements', 'functions', 'branches'] as const;

interface Metric { pct?: number; covered?: number; total?: number }
interface FileMetrics { lines?: Metric; statements?: Metric; functions?: Metric; branches?: Metric }
type Summary = Record<string, FileMetrics | Metric> & { total?: FileMetrics };

/** 从 config.yml 读 G2.coverage_threshold（唯一声明源；缺失返回 null）。 */
function declaredThresholds(): { lines: number | null; branches: number | null } {
  const text = existsSync(GATE_CONFIG) ? readFileSync(GATE_CONFIG, 'utf8') : '';
  const m = /coverage_threshold:\s*\n\s*(?:#.*\n\s*)*lines:\s*(\d+)\s*\n\s*(?:#.*\n\s*)*branches:\s*(\d+)/.exec(text);
  return { lines: m ? Number(m[1]) : null, branches: m ? Number(m[2]) : null };
}

/** 读证据。缺失时抛出**可执行**的失败信息（先测量，再判定）。 */
function readSummary(): Summary {
  const path = findCoverageSummary();
  if (path === null) {
    throw new Error('coverage 证据缺失：活跃区与归档区都没有 coverage/coverage-summary.json。'
      + '先运行 `node scripts/coverage.mjs`（约 40s）生成证据——没有证据 ≠ 通过。');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Summary;
}

/** 纯判定函数：返回证据问题清单（空数组 = 通过）。抽成纯函数以便反向自检。 */
function evidenceProblems(summary: Summary, thresholds: { lines: number; branches: number }): string[] {
  const problems: string[] = [];
  const total = summary.total;
  if (!total) return ['缺少 total 字段（摘要格式异常）'];
  for (const metric of ['lines', 'branches'] as const) {
    const pct = total[metric]?.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) problems.push(`${metric} 百分比不可读：${String(pct)}`);
    else if (pct < thresholds[metric]) problems.push(`${metric} 未达标：${pct.toFixed(2)}% < ${String(thresholds[metric])}%`);
  }
  const files = Object.entries(summary).filter(([key]) => key !== 'total');
  if (files.length < MIN_FILES) problems.push(`文件数异常：${String(files.length)} < ${String(MIN_FILES)}（疑似局部/伪造摘要）`);
  for (const [file] of files) {
    if (!/[/\\]src[/\\].*\.ts$/.test(file)) problems.push(`文件不在 src/ 下：${file}`);
  }
  for (const metric of METRICS) {
    let covered = 0;
    let count = 0;
    for (const [, m] of files) {
      covered += (m as FileMetrics)[metric]?.covered ?? 0;
      count += (m as FileMetrics)[metric]?.total ?? 0;
    }
    if (covered !== total[metric]?.covered || count !== total[metric]?.total) {
      problems.push(`${metric} 合计不一致：文件合计 ${String(covered)}/${String(count)} ≠ total ${String(total[metric]?.covered)}/${String(total[metric]?.total)}`);
    }
  }
  return problems;
}

describe('cycle-80 WS-2 coverage 证据链', () => {
  it('① wiring：config 声明 v8 + 双 reporter + 循环工件目录 + reportOnFailure + clean:false；脚本与 npm script 存在', () => {
    const cfg = readFileSync(CONFIG_TS, 'utf8');
    expect(cfg).toContain("provider: 'v8'");
    expect(cfg).toContain("'text-summary'");
    expect(cfg).toContain("'json-summary'");
    /*
     * cycle-86：不再钉轮号。原断言写死 `cycle-80`——报告目录按循环滚动（本仓纪律），
     * 于是每次滚轮都要同时改配置与这条断言（"两处必须同轮改"的耦合本身就是缺陷源：
     * 忘了改就是假红，改错就是假绿）。现在的判据是**形状**：必须落在某个
     * `.cycles/cycles/cycle-N/coverage` 下（滚动合法，写错位置不合法）。
     */
    expect(cfg).toMatch(/reportsDirectory: '\.cycles\/cycles\/cycle-\d+\/coverage'/);
    // 红套件也必须产摘要（vitest 默认 false，实测会整份摘要消失）
    expect(cfg).toContain('reportOnFailure: true');
    // clean 默认 true 会先删上一轮摘要 → 同一次 coverage 运行里的本契约假红（实测 3 红）
    expect(cfg).toContain('clean: false');
    expect(existsSync(join(ROOT, 'scripts', 'coverage.mjs'))).toBe(true);
    // 最新鲜数字的阈值门在脚本里（测试期间本轮摘要尚不存在，见文件头"分工"注）
    expect(readFileSync(join(ROOT, 'scripts', 'coverage.mjs'), 'utf8')).toContain('coverage_threshold');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['coverage']).toBe('node scripts/coverage.mjs');
  });

  it('② 工件存在：缺失即明确失败（不 SKIP——没有证据 ≠ 通过）', () => {
    const evidence = findCoverageSummary();
    expect(evidence, '活跃区与归档区都没有 coverage-summary.json（先跑 node scripts/coverage.mjs）').not.toBeNull();
    expect(() => readSummary()).not.toThrow();
  });

  it('③ 阈值未被悄悄下调：config.yml 声明 == 承诺 80/65', () => {
    const declared = declaredThresholds();
    expect(declared).toEqual(PROMISED);
  });

  it('④ 达标断言：lines ≥ 80% 且 branches ≥ 65%（真读 JSON 数值，不读文本）', () => {
    const summary = readSummary();
    const declared = declaredThresholds();
    const problems = evidenceProblems(summary, { lines: declared.lines ?? PROMISED.lines, branches: declared.branches ?? PROMISED.branches });
    expect(problems).toEqual([]);
    // 四指标必须都在（不只看两个阈值：functions/statements 缺失 = 摘要被裁剪过）
    for (const metric of METRICS) expect(typeof summary.total?.[metric]?.pct).toBe('number');
  });

  it('⑤ 反向自检：低于阈值 / 合计被篡改 / 局部伪造的摘要必须判红（守卫有牙）', () => {
    const summary = readSummary();
    const thresholds = { lines: 80, branches: 65 };
    expect(evidenceProblems(summary, thresholds)).toEqual([]); // 对照：真实证据必须通过

    const lowLines = structuredClone(summary);
    (lowLines.total as FileMetrics).lines = { pct: 79.99, covered: 1, total: 2 };
    expect(evidenceProblems(lowLines, thresholds).join(' ')).toContain('lines 未达标');

    const lowBranches = structuredClone(summary);
    (lowBranches.total as FileMetrics).branches = { pct: 64.99, covered: 1, total: 2 };
    expect(evidenceProblems(lowBranches, thresholds).join(' ')).toContain('branches 未达标');

    // 伪造：total 报高分但文件合计对不上（手写假摘要的典型形态）
    const doctored = structuredClone(summary);
    (doctored.total as FileMetrics).lines = { pct: 99, covered: 999999, total: 1000000 };
    expect(evidenceProblems(doctored, thresholds).join(' ')).toContain('lines 合计不一致');

    // 局部摘要冒充全量 + 路径不在 src/
    const tiny: Summary = { total: { lines: { pct: 100, covered: 1, total: 1 }, branches: { pct: 100, covered: 0, total: 0 }, statements: { pct: 100, covered: 1, total: 1 }, functions: { pct: 100, covered: 1, total: 1 } }, 'C:/elsewhere/fake.ts': { lines: { pct: 100, covered: 1, total: 1 }, branches: { pct: 100, covered: 0, total: 0 }, statements: { pct: 100, covered: 1, total: 1 }, functions: { pct: 100, covered: 1, total: 1 } } };
    const tinyProblems = evidenceProblems(tiny, thresholds).join(' ');
    expect(tinyProblems).toContain('文件数异常');
    expect(tinyProblems).toContain('文件不在 src/ 下');

    const noTotal: Summary = { 'C:/proj/src/a.ts': {} };
    expect(evidenceProblems(noTotal, thresholds)).toContain('缺少 total 字段（摘要格式异常）');
  });
});
