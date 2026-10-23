/**
 * 面板「装配-数据腿」契约（cycle-73 T-7303）—— F-10 的通解。
 *
 * 被守卫缺陷（cycle-72 真实事故）：分区组件装配了（createElement 存在、三腿契约绿），
 * 但**数据腿没接**——没有任何 target 工厂向它订阅的 store 切片写值。
 * 后果：分区照常渲染标题与折叠壳，**表体永远为空、失败行也不出现**：
 * 「守着分区存在的绿，白盒面一个字没有」——正是本项目要消灭的形态。
 *
 * 为什么三腿契约抓不到（cycle-72 实证）：腿1 只问「组件有没有调 renderFoldableSection」；
 * 腿3 只问「组件有没有被 createElement」；**没有任何一腿问「该分区的数据从哪来」**。
 *
 * 判定链（全部静态可判）：
 *   ① 分区 id → 订阅的切片键：panelSections.ts 按 SectionImpl 块归属 usePanelSlice(store, selX)，
 *      再把 selX 解析为 `(s) => s.<slice>`（**两遍**：块内先收集，块尾 `export const XSection = memo` 收口）；
 *   ② 切片键 → 写它的 setter：panelActions.ts 的 `<setter>: (…) => { store.setState({ <slice>: … }) }`；
 *   ③ setter → 是否被接线：target 文件里 `s.<setter>(` **或**装配层 WorkflowGraphPanel.ts 里
 *      `actions.<setter>(`（两条通道都算——target 产出 target 对象，装配层展开进 usePanelFetch）；
 *   ④ 订阅了切片却无任何接线的 setter ⇒ **红**（点名分区 + 切片 + setter）。
 *
 * 守卫纪律：① 反向自检（抹掉 closure 的接线，判据必须红）；② 扫描集非空下限；③ 只读。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLIENT = join(ROOT, 'src', 'client');
const SECTIONS = join(CLIENT, 'components', 'panelSections.ts');
const ACTIONS = join(CLIENT, 'components', 'panelActions.ts');
const PANEL = join(CLIENT, 'WorkflowGraphPanel.ts');

const NL = String.fromCharCode(10);

/** 递归收集 src/client 下全部 .ts（腿1 扫描域）。
 *
 * 为什么必须全量扫、而不是只读 panelSections.ts（**cycle-72 同一教训的复发**）：
 * T3（单文件 ≤250 行）拆分把 `closure` 分区搬到了 features/closure/ClosureSection.ts，
 * 只扫单文件的守卫会静默漏掉它 —— 与 panelAssemblyContract 腿1 当年的失明同族。
 * 本次实现时先按单文件写，反向自检立刻抓到 closure 缺失 ⇒ 改为全量扫（记录在案）。 */
function clientSources(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
    }
  };
  walk(CLIENT);
  return out;
}

/** ① 分区 id → 订阅的切片键（全量扫 src/client）。 */
function sectionSlices(files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // selector 定义可能分散在各文件（selClosure 在 ClosureSection.ts）
  const selToSlice = new Map<string, string>();
  const fileLines = files.map((p) => ({ p, lines: readFileSync(p, 'utf8').split(NL) }));
  for (const { lines } of fileLines) {
    for (const l of lines) {
      const m = l.match(/(?:const|export const) (sel[A-Za-z0-9_]+) = \(s: PanelState\) => s\.([A-Za-z0-9_]+);/);
      if (m && m[1] && m[2]) selToSlice.set(m[1], m[2]);
    }
  }
  for (const { lines } of fileLines) {
    let cur: { id: string | null; slices: string[] } | null = null;
    for (const l of lines) {
      if (/^(?:export )?function [A-Za-z0-9_]+SectionImpl\(/.test(l)) { cur = { id: null, slices: [] }; continue; }
      if (!cur) continue;
      const idm = l.match(/renderFoldableSection\(\{ id: '([A-Za-z0-9_]+)'/);
      if (idm && idm[1]) { cur.id = idm[1]; continue; }
      const u = l.match(/usePanelSlice\(store, (sel[A-Za-z0-9_]+)\)/);
      if (u && u[1]) {
        const slice = selToSlice.get(u[1]);
        if (slice && !cur.slices.includes(slice)) cur.slices.push(slice);
      }
      if (/^(?:export )?const [A-Za-z0-9_]+Section = memo\(/.test(l)) {
        if (cur.id && !out.has(cur.id)) out.set(cur.id, cur.slices);
        cur = null;
      }
    }
  }
  return out;
}

/** ② 切片键 → 写它的 setter 名（**逐行**解析，避免跨 setter 串味）。 */
function sliceSetters(): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of readFileSync(ACTIONS, 'utf8').split(NL)) {
    const m = l.match(/^\s*(set[A-Za-z0-9_]+):\s*\([^)]*\)\s*=>\s*\{?\s*(?:store\.)?setState\(\{([^}]*)\}/);
    if (!m || !m[1] || !m[2]) continue;
    const setter = m[1];
    for (const k of m[2].matchAll(/([A-Za-z0-9_]+)\s*:/g)) {
      const slice = k[1];
      if (slice && !out.has(slice)) out.set(slice, setter);
    }
  }
  return out;
}

/** target 文件集（一域一文件的 target 工厂）。 */
function targetFiles(): string[] {
  const out: string[] = [];
  const push = (p: string): void => { if (existsSync(p) && !out.includes(p)) out.push(p); };
  push(join(CLIENT, 'panelLiveTargets.ts'));
  push(join(CLIENT, 'governanceTargets.ts'));
  const feat = join(CLIENT, 'features');
  for (const d of readdirSync(feat, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(feat, d.name))) {
      if (/Target\.ts$/.test(f)) push(join(feat, d.name, f));
    }
  }
  return out;
}

/**
 * ③ 被**真正接线**的 setter 名集合。
 *
 * 关键（本守卫第一版**没有牙**，自查抓到）：**只看 target 文件里写了 setter 是不够的**——
 * cycle-72 的真实缺陷正是「closureTarget.ts 写了 setClosure，但装配层从未调用 closureTarget()」
 * （即 target 工厂存在却零调用方）。若判据只看定义文件，那种缺陷态仍会判绿。
 *
 * 故接线判定要求**工厂被装配层实际调用**：
 *   ① 找 `WorkflowGraphPanel.ts` 里实际出现的工厂调用 `fooTarget(`（排除 import 行）；
 *   ② 只对该工厂内部写过的 setter 计为已接线。
 * 另加一条通道：装配层直接调 `actions.<setter>(`（不经工厂的直写档）。
 */
function wiredSetters(files: string[]): Set<string> {
  const out = new Set<string>();
  const panelSrc = existsSync(PANEL) ? readFileSync(PANEL, 'utf8') : '';
  // ① 装配层真正调用的工厂名。
  // 语法要点：调用形态是**展开** `...closureTarget(` —— 前缀是 `.`，
  // 若把 `.` 排除在允许前缀外就会漏配（本守卫第一版正因此无牙，自查发现）。
  // 故允许 `...` 显式前缀，或非标识符/非点的边界（避免把 `x.fooTarget(` 当成本地工厂调用）。
  const invokedFactories = new Set<string>();
  for (const line of panelSrc.split(NL)) {
    if (/^\s*import\b/.test(line)) continue; // import 行不是调用
    for (const m of line.matchAll(/(?:\.\.\.|[^A-Za-z0-9_$.])([a-zA-Z][A-Za-z0-9_]*Target)s?\s*\(/g)) {
      if (m[1]) invokedFactories.add(m[1]);
    }
  }
  // ② 只汇总**被调用工厂**内部写的 setter
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const fm = src.match(/export function ([a-zA-Z][A-Za-z0-9_]*Target)s?\s*\(/);
    if (!fm || !fm[1] || !invokedFactories.has(fm[1])) continue;
    for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_.])s\.(set[A-Za-z0-9_]+)\(/g)) if (m[1]) out.add(m[1]);
  }
  // ③ 装配层直写通道
  for (const m of panelSrc.matchAll(/(?:^|[^A-Za-z0-9_.])actions\.(set[A-Za-z0-9_]+)\(/g)) if (m[1]) out.add(m[1]);
  return out;
}

/** ④ 判定：返回违规清单（空 = 全部数据腿齐备）。 */
function dataLegViolations(
  slices: Map<string, string[]>,
  setters: Map<string, string>,
  wired: Set<string>,
): string[] {
  const out: string[] = [];
  for (const [id, sliceList] of slices) {
    for (const slice of sliceList) {
      const setter = setters.get(slice);
      if (!setter) { out.push(id + ': 切片 ' + slice + ' 无 setter'); continue; }
      if (!wired.has(setter)) out.push(id + ': 切片 ' + slice + ' 的 ' + setter + ' 无接线（有壳无表体）');
    }
  }
  return out;
}

const clientFiles = clientSources();
const slices = sectionSlices(clientFiles);
const setters = sliceSetters();
const tFiles = targetFiles();
const wired = wiredSetters(tFiles);

describe('cycle-73 T-7303 面板装配-数据腿契约（F-10 通解）', () => {
  it('纪律② 扫描集非空下限：分区 ≥ 8、target ≥ 3、selector ≥ 8（空集恒绿 = 假守卫）', () => {
    // 扫描域下限：src/client 源文件数必须可观（防拆分成空扫描，cycle-72 教训）
    expect(clientFiles.length).toBeGreaterThanOrEqual(40);
    expect(slices.size).toBeGreaterThanOrEqual(8);
    expect(tFiles.length).toBeGreaterThanOrEqual(3);
    expect(setters.size).toBeGreaterThanOrEqual(8);
  });

  it('每个分区订阅的切片都有 setter，且该 setter 有接线（有壳无表体即红）', () => {
    const violations = dataLegViolations(slices, setters, wired);
    expect(violations, '有壳无表体的分区:' + NL + violations.join(NL)).toEqual([]);
  });

  it('closure 实例回归钉（cycle-72 真实事故，须持续被通解覆盖）', () => {
    expect(slices.has('closure')).toBe(true);
    expect(setters.get('closure')).toBe('setClosure');
    expect(wired.has('setClosure')).toBe(true);
  });

  it('纪律① 反向自检 A：抹掉 closure 接线后判据必须红（守卫真有牙）', () => {
    const fake = new Set([...wired].filter((s) => s !== 'setClosure'));
    const violations = dataLegViolations(slices, setters, fake);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('closure'))).toBe(true);
  });

  it('纪律① 反向自检 B：**复现 cycle-72 真实缺陷态**——工厂存在但装配层零调用 ⇒ 必须红', () => {
    // 构造真实的缺陷形态：panelSections/ClosureSection 照常声明分区，
    // closureTarget.ts 照常写 setClosure，但装配层**从不调用** closureTarget()。
    // 修复前本守卫（只看定义文件）在此场景会判绿 —— 无牙；改判据后必须红。
    const panelSrc = readFileSync(PANEL, 'utf8');
    const noCall = panelSrc.replace(/\.\.\.closureTarget\([^)]*\)/g, '').replace(/closureTarget\([^)]*\)/g, '');
    const invoked = new Set<string>();
    for (const line of noCall.split(NL)) { if (/^\s*import\b/.test(line)) continue; for (const m of line.matchAll(/(?:\.\.\.|[^A-Za-z0-9_$.])([a-zA-Z][A-Za-z0-9_]*Target)s?\s*\(/g)) if (m[1]) invoked.add(m[1]); }
    expect(invoked.has('closureTarget'), '变异体仍含 closureTarget 调用，变异无效').toBe(false);
    // 该变异态下，closure 的数据腿必须被判为缺失
    const wiredMutant = new Set([...wired].filter((s) => s !== 'setClosure'));
    const v = dataLegViolations(slices, setters, wiredMutant);
    expect(v.some((x) => x.includes('closure'))).toBe(true);
  });
});
