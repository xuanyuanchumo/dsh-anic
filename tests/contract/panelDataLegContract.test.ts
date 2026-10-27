/**
 * 面板「装配-数据腿」契约（cycle-73 T-7303，cycle-82 重构判定核）—— F-10 的通解。
 *
 * ## 被守卫的缺陷（cycle-72 真实事故）
 *
 * 分区组件装配了（`createElement(XxxSection)` 存在、三腿契约绿），但**数据腿没接**——
 * 没有任何 target 工厂向它订阅的 store 切片写值。后果：分区照常渲染标题与折叠壳，
 * **表体永远为空、失败行也不出现**——「守着分区存在的绿，白盒面一个字没有」。
 *
 * 为什么三腿契约抓不到：腿1 只问「组件有没有调 renderFoldableSection」；腿3 只问
 * 「组件有没有被 createElement」；**没有任何一腿问「该分区的数据从哪来」**。
 *
 * ## cycle-82 重构判定核：从「三个正则猜结构」到「可达性」
 *
 * 旧实现靠三条互相独立的正则拼出结论（分区→selector、切片→setter、setter→接线），
 * 每条都要猜"源码长什么样"，于是 cycle-82 一次普通重构（数据面拆出
 * `panelPeriodicTarget.ts`、写侧搬进 `ConfigSection.ts`）就让三条同时假红：
 *   - 目标文件扫描域写死「根目录 + features 一层」⇒ 漏掉新增的根目录 target 文件；
 *   - 工厂名捕获组 `…Target)s?` 与定义侧 `…Targets?)` 拼写不一致 ⇒
 *     `panelLiveTargets` 被判"未被调用"；
 *   - 接线只看 `s.<setter>(`（形参名硬编码）与装配层 `actions.<setter>(`
 *     ⇒ 复合动作（`finishConfigWrite`）与经工厂内部调用的链全部漏判。
 *
 * 每一条都是同一个错误：**判据与源码结构耦合**。本版改为三层**可达性**判定：
 *
 *   ① 装配基座：`WorkflowGraphPanel.ts` 是面板唯一入口（装配层）。
 *   ② 可达模块集：从基座沿 `import` 边在该文件的依赖闭包里做传递闭包（只走 src/client
 *      内部相对 import）。**只有被装配层真正拉进图的模块才算数**——这保留了 cycle-72
 *      的核心牙口：「工厂文件写得再对，装配层没 import 它 ⇒ 它的动作不算接线」。
 *   ③ 动作调用面：在可达模块集里收集 `<任意标识符>.<action>(` 调用（去注释），
 *      排除 `panelActions.ts` 自身（定义处不是调用处）。
 *
 * 判定链：分区 → `usePanelSlice(store, selX)` → `s.<slice>` → 写该切片的动作
 * （在 panelActions.ts 的**块体归属**内解析，见 §sliceSetters）→ 该动作是否出现在
 * 可达调达面。任一环断 ⇒ 点名违规。
 *
 * 守卫纪律：① 反向自检（抹掉 closure 的接线，判据必须红）；② 扫描集非空下限；③ 只读。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLIENT = join(ROOT, 'src', 'client');
const ACTIONS_REL = 'components/panelActions.ts';
const ACTIONS = join(CLIENT, ACTIONS_REL);
const PANEL = join(CLIENT, 'WorkflowGraphPanel.ts');

const NL = String.fromCharCode(10);

/** 去注释（保留换行，行号可用于报错定位；不识别正则字面量——本域源码无含引号正则）。 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; i += 1; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; out += '  '; i += 2; } else { out += c === '\n' ? c : ' '; i += 1; } continue; }
    if (quote !== null) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === quote) quote = null; i += 1; continue; }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** 递归收集 src/client 下全部 .ts/.tsx（相对 CLIENT 的 / 分隔路径 → 去注释源码）。 */
function clientSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        out.set(relative(CLIENT, p).split('\\').join('/'), stripComments(readFileSync(p, 'utf8')));
      }
    }
  };
  walk(CLIENT);
  return out;
}

const FILES = clientSources();

/** 解析本文件的相对 import 目标（只认 `./` / `../`；包导入不属于本图）。 */
function importTargets(rel: string, src: string): string[] {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1] as string;
    const segs = (dir === '' ? spec : dir + '/' + spec).split('/');
    const stack: string[] = [];
    for (const s of segs) {
      if (s === '.' || s === '') continue;
      if (s === '..') { stack.pop(); continue; }
      stack.push(s);
    }
    let resolved = stack.join('/');
    if (!resolved.endsWith('.ts') && !resolved.endsWith('.tsx')) resolved += '.ts';
    if (FILES.has(resolved)) { if (!out.includes(resolved)) out.push(resolved); }
    else {
      // 目录 index（本仓 client 无此形态，但留着以免静默漏边）。
      const idx = resolved.replace(/\.ts$/, '/index.ts');
      if (FILES.has(idx) && !out.includes(idx)) out.push(idx);
    }
  }
  return out;
}

/**
 * 可达模块集：从装配基座出发的 import 传递闭包。
 *
 * 这替代了旧实现里"哪些文件叫 *Target.ts"的目录约定——**装配层拉不到的文件不算接线**，
 * 无论它写得多完整（cycle-72 的真实缺陷态正是这种：文件齐全、零调用方）。
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const src = FILES.get(cur);
    if (src === undefined) continue;
    for (const dep of importTargets(cur, src)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

/** ① 分区 id → 订阅的切片键（全量扫 src/client：selectors 可能定义在分区同域文件）。 */
function sectionSlices(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const selToSlice = new Map<string, string>();
  for (const src of FILES.values()) {
    for (const m of src.matchAll(/(?:const|export const)\s+(sel[A-Za-z0-9_]+)\s*=\s*\(s:\s*PanelState\)\s*=>\s*s\.([A-Za-z0-9_]+);/g)) {
      if (m[1] && m[2]) selToSlice.set(m[1], m[2]);
    }
  }
  for (const src of FILES.values()) {
    let cur: { id: string | null; slices: string[] } | null = null;
    for (const l of src.split(NL)) {
      if (/^(?:export )?function [A-Za-z0-9_]+SectionImpl\(/.test(l)) { cur = { id: null, slices: [] }; continue; }
      if (cur === null) continue;
      const idm = l.match(/renderFoldableSection\(\{\s*id:\s*'([A-Za-z0-9_]+)'/);
      if (idm && idm[1]) { cur.id = idm[1]; continue; }
      const u = l.match(/usePanelSlice\(store,\s*(sel[A-Za-z0-9_]+)\)/);
      if (u && u[1]) {
        const slice = selToSlice.get(u[1]);
        if (slice !== undefined && !cur.slices.includes(slice)) cur.slices.push(slice);
      }
      if (/^(?:export )?const [A-Za-z0-9_]+Section = memo\(/.test(l)) {
        if (cur.id !== null && !out.has(cur.id)) out.set(cur.id, cur.slices);
        cur = null;
      }
    }
  }
  return out;
}

/**
 * ② 切片键 → 写它的动作名（**块体归属**解析）。
 *
 * ## 为什么不再用「正则抠 setState 的补丁字面量」
 *
 * 旧实现追 `store.setState({ ... })` 的字面量文本。那在"补丁是一层扁平对象"时成立，
 * 但动作层里存在两类**结构合法的写法**它必然抓瞎：
 *   - 函数式补丁带体内计算：`setState((s) => { …; return { config: v, … } })`（草稿合并）；
 *   - 补丁值里含嵌套对象：`configDrafts: { ...s.configDrafts, [id]: value }` ——
 *     `[^}]*` 会在第一个 `}` 处截断，把 `configDrafts` 之后的键全丢掉。
 * 两者都会让切片被判「无写入动作」——**假红**，而且红在解析器能力上、不在被守卫的事实上。
 *
 * ## 现判定：以 PanelState 的切片名为**唯一词表**
 *
 * 切片名来自 `panelState.ts` 的 `interface PanelState`（真相源，不手抄）。动作块内
 * 出现 `<切片名>:` 形态即视为"该动作写这个切片"。这条与源码书写方式解耦：
 * 不管补丁是单行、多行、嵌套还是函数体 return，只要它在写那个键就认。
 *
 * 归属边界（保留旧实现正确的那部分）：从动作行起，到下一个动作行（缩进 4 的
 * `name: (`）或动作对象结束 `};` 为止 —— 防止相邻动作的键串味。
 */
function sliceSetters(): Map<string, string> {
  const out = new Map<string, string>();
  const src = FILES.get(ACTIONS_REL) ?? '';
  const lines = src.split(NL);
  for (let i = 0; i < lines.length; i += 1) {
    const head = (lines[i] as string).match(/^\s{4}([A-Za-z][A-Za-z0-9_]*):\s*\(/);
    if (head === null || head[1] === undefined) continue;
    const action = head[1];
    for (let j = i; j < lines.length; j += 1) {
      const body = lines[j] as string;
      if (j > i && /^\s{4}[A-Za-z0-9_]+:\s*\(/.test(body)) break; // 下一个动作
      if (j > i && /^\s{2}\};?\s*$/.test(body)) break; // 动作对象结束
      for (const slice of PANEL_STATE_KEYS) {
        if (out.has(slice)) continue;
        // 键取用形态：对象字面量的 `slice:`，或解构/赋值左侧的 `slice:`。
        if (new RegExp('(?:^|[{,\\s(])' + slice + '\\s*:').test(body)) out.set(slice, action);
      }
    }
  }
  return out;
}

/**
 * ③ 可达调用面：装配层 import 闭包里出现过 `.<action>(` 的动作名。
 *
 * 为什么排除 `panelActions.ts` 自身：那里是**定义**，把定义算成调用等于"写了就有接线"，
 * 正是 cycle-72 缺失的牙口。
 */
const REACHABLE = reachableFrom('WorkflowGraphPanel.ts');

/**
 * PanelState 的切片名（**真相源在这里**，不手抄）。
 *
 * 为什么从 `panelState.ts` 的 interface 文本解析而不是 import 类型：
 * 契约测试跑在 vitest 里、可以 import，但**类型在运行时不存在**——`interface PanelState`
 * 是纯类型，`Object.keys` 拿不到。逐行解析 interface 体是唯一能同时做到
 * 「零手抄」与「运行时可用」的办法。这也让"新增切片忘了接线"当天就红。
 */
const PANEL_STATE_KEYS: string[] = (() => {
  const src = FILES.get('panelState.ts') ?? '';
  const start = src.indexOf('export interface PanelState {');
  if (start < 0) throw new Error('panelState.ts 里找不到 `export interface PanelState {`——本守卫的切片词表失源');
  const tail = src.slice(start + 'export interface PanelState {'.length);
  const end = tail.indexOf('\n}');
  const body = end < 0 ? tail : tail.slice(0, end);
  const keys: string[] = [];
  for (const m of body.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\s*[?:]?\s*:/gm)) {
    if (m[1] !== undefined && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
})();

function wiredActions(): Set<string> {
  const out = new Set<string>();
  for (const rel of REACHABLE) {
    if (rel === ACTIONS_REL) continue;
    const src = FILES.get(rel) ?? '';
    for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_$])[A-Za-z][A-Za-z0-9_$]*\.([a-zA-Z][A-Za-z0-9_]*)\(/g)) {
      if (m[1] !== undefined) out.add(m[1]);
    }
  }
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
      if (setter === undefined) { out.push(id + ': 切片 ' + slice + ' 无 setter'); continue; }
      if (!wired.has(setter)) out.push(id + ': 切片 ' + slice + ' 的 ' + setter + ' 无接线（有壳无表体）');
    }
  }
  return out;
}

const slices = sectionSlices();
const setters = sliceSetters();
const wired = wiredActions();

describe('cycle-73 T-7303 面板装配-数据腿契约（F-10 通解 · cycle-82 可达性判定核）', () => {
  it('纪律② 扫描集非空下限：源文件 ≥40、分区 ≥8、可达模块 ≥10、动作 ≥8', () => {
    expect(FILES.size).toBeGreaterThanOrEqual(40);
    expect(slices.size).toBeGreaterThanOrEqual(8);
    expect(REACHABLE.size).toBeGreaterThanOrEqual(10);
    expect(setters.size).toBeGreaterThanOrEqual(8);
    // 可达性确实"走了图"：装配基座自身在集内，且它 import 的分区组件也在集内。
    expect(REACHABLE.has('WorkflowGraphPanel.ts')).toBe(true);
    expect(REACHABLE.has(ACTIONS_REL)).toBe(true);
    expect(REACHABLE.has('features/closure/ClosureSection.ts')).toBe(true);
    expect(REACHABLE.has('features/config/ConfigSection.ts')).toBe(true);
  });

  it('每个分区订阅的切片都有 setter，且该 setter 在可达调达面上（有壳无表体即红）', () => {
    const violations = dataLegViolations(slices, setters, wired);
    expect(violations, '有壳无表体的分区:' + NL + violations.join(NL)).toEqual([]);
  });

  it('closure 实例回归钉（cycle-72 真实事故，须持续被通解覆盖）', () => {
    expect(slices.has('closure')).toBe(true);
    expect(setters.get('closure')).toBe('setClosure');
    expect(wired.has('setClosure')).toBe(true);
  });

  it('config 实例回归钉（cycle-82：唯一可写分区，六切片各有一条数据腿）', () => {
    const sliceList = slices.get('config') ?? [];
    expect(sliceList.length).toBeGreaterThanOrEqual(6);
    for (const slice of sliceList) {
      const action = setters.get(slice);
      expect(action, '切片 ' + slice + ' 无写入动作').toBeDefined();
      expect(wired.has(action as string), '切片 ' + slice + ' 的 ' + String(action) + ' 无接线').toBe(true);
    }
  });

  it('纪律① 反向自检 A：抹掉 closure 接线后判据必须红（守卫真有牙）', () => {
    const fake = new Set([...wired].filter((s) => s !== 'setClosure'));
    const violations = dataLegViolations(slices, setters, fake);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('closure'))).toBe(true);
  });

  it('纪律① 反向自检 B：装配层零引用闭包 ⇒ 该模块里的动作全部不算接线（cycle-72 缺陷态）', () => {
    // 复现 cycle-72：工厂文件写得完整，但装配层从不 import/调用它。
    // 判定核用的是可达性 ⇒ 只要把它移出可达集，它内部的接线必须全部失效。
    const reachableWithout = new Set([...REACHABLE].filter((r) => r !== 'features/closure/closureTarget.ts'));
    const out = new Set<string>();
    for (const rel of reachableWithout) {
      if (rel === ACTIONS_REL) continue;
      const src = FILES.get(rel) ?? '';
      for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_$])[A-Za-z][A-Za-z0-9_$]*\.([a-zA-Z][A-Za-z0-9_]*)\(/g)) if (m[1] !== undefined) out.add(m[1]);
    }
    expect(out.has('setClosure'), '变异体仍含 setClosure 调用，变异无效').toBe(false);
    const v = dataLegViolations(slices, setters, out);
    expect(v.some((x) => x.includes('closure'))).toBe(true);
  });

  it('纪律① 反向自检 C：判据不认名字只认调用——把 setConfig 从调用面移除必红', () => {
    const fake = new Set([...wired].filter((s) => s !== 'setConfig'));
    const v = dataLegViolations(slices, setters, fake);
    expect(v.some((x) => x.includes('config'))).toBe(true);
  });
});
