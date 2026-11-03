/**
 * 闭环体检**变异测试**（cycle-75 · T5）——证明守卫**有牙**，不是装饰。
 *
 * 为什么单列一个变异测试文件（本轮核心）：
 * 「守卫存在」与「守卫能失败」是两件事。本仓的血泪教训是
 * **告警级守卫等于没有守卫** —— 一条断言如果在任何输入下都恒真，它就是装饰。
 * 本文件的做法：对扫描器做 **5 处定向变异**，每处都断言
 *   「同一套判据在原始树上无红旗（变异前绿）」+「在变异树上必有红旗（变异后红）」。
 * 只写「变异后红」是证明不了有牙的；必须**同一判据两态都跑**。
 *
 * 变异全部在**内存夹具**上做（构造 files Map，不写盘、不 spawn 进程）——
 * 守 R-31 只读纪律：闭环体检的扫描器与它的守卫都不许改工作区。
 *
 * ## 两态实测证据（可复现命令）
 *
 * ```bash
 * # ① 变异前绿（默认）
 * node scripts/run-vitest.mjs tests/contract/closureAuditMutation.test.ts
 * # ② 变异后红（把 M5 强加到真实树上，让严格判据**真红** —— 非模拟、非恒真）
 * CLOSURE_MUTANT_FORCE=M5-strip-path-key node scripts/run-vitest.mjs tests/contract/closureAuditMutation.test.ts
 * ```
 *
 * ② 之所以是必需证据：①只说明判据在真实树上通过，排不除「判据恒真」。
 * ② 让同一判据对着被破坏的树跑一次并真的红。该开关只影响本测试的局部夹具，
 * 不碰源码、不碰工作区（R-31）。
 *
 * ## 四个判据（「红旗」族）
 *
 * | 判据 | 含义 | 对应白盒诉求 |
 * |---|---|---|
 * | `truth-leg-missed-registration` | 独立真值腿看到了、扫描器没看到 ⇒ **漏报** | 注册必须报全 |
 * | `scanner-invented-registration` | 扫描器报出了代码真值里没有的 path ⇒ **幽灵注册** | 不许把注释/文本当注册 |
 * | `ghost-consumer` | 消费者引用了未注册端点 ⇒ **幽灵消费** | 删注册必现 |
 * | `produced-set-drift` | produced 集合偏离冻结基线（棘轮）⇒ **计数漂移** | 不许静默增减 |
 *
 * ## 5 处变异与它们各自击中的判据
 *
 * | # | 变异 | 击中的判据 | 现实对应缺陷 |
 * |---|---|---|---|
 * | M1 | 删掉 `reg('/anic/flows', …)` 整条语句 | drift | 路由注册被误删 |
 * | M2 | 删掉 `register({ path: '/anic/cycle/list' })` | ghost + drift | 代码删了注册、消费者还在 |
 * | M3 | `/anic/cycle/list` → `/anic/cycle/listX` | ghost + drift | 改名只改一半必红 |
 * | M4 | 把注册行**注释掉**（字面量仍在原文） | ghost + drift | 注释掉的代码冒充活代码 |
 * | M5 | 删掉 `register({ … })` 里的 `path:` 键 | ghost + drift | 没有路径的注册对象不是注册 |
 *
 * M1 只翻 `drift`（不翻 ghost）是**诚实的**：`/anic/flows` 的引用全在注释里，
 * 去注释后没有一个真实字面量消费者，删它不会产生幽灵消费。若强行断言「必现幽灵」，
 * 那条断言就是假的。M1 的价值在棘轮：删除真注册必须让 produced 集合漂移 → 红。
 *
 * ## M5 的来龙去脉：本轮抓到的真实缺陷（已修，此处转为回归钉）
 *
 * 变异测试最初对形态 A 做「把 `path:` 推到 600 字外」的变异，**真的红了**——
 * 那不是假想，是实测缺陷：`scanRouteDefs` 原用「`register({` 起 600 字固定窗口
 * + `handler:` 截断」定位 path，任何把 `path:` 推远的**无害重构**都会让注册
 * **静默漏报**，registered/produced/unconsumed 三个数同时漂移而无人察觉。
 * 该缺陷已由 Lead 复现并修复（改为 `balancedBraces()` 括号配平，不依赖距离）。
 *
 * 缺陷修完后，那个变异不再翻转 —— 于是它**必须改造，不能留成恒真断言**
 * （本仓纪律：一条永不失败的断言就是装饰）。现在的处理是：
 *   ① 原来的变异位（删掉 `path:` 键）改为一个**仍然有牙**的变异；
 *   ② 缺陷本身转成**回归钉**（`path:` 推远 700 字仍须识别 + 相邻注册不串台），
 *      若有人把配平退回固定窗口，回归钉立刻红；
 *   ③ `force 开关仍有牙` 一条对每个可强制 id 逐个证实翻转存在性，
 *      防止任何 id 退化成恒真开关。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFileIndex, buildTextMap, stripComments } from '../../src/host/closureAudit/scanPrimitives.ts';
import { routeGhosts, scanRouteDefs } from '../../src/host/closureAudit/assetClosure.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BS = String.fromCharCode(92);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BT = String.fromCharCode(96);
const Q = '[' + SQ + DQ + BT + ']';
const ROUTE_FILE = new RegExp('^src/host/(routes/[A-Za-z0-9_]+' + BS + '.ts|snapshotRoute' + BS + '.ts)$');

/* ── 变异原语（内存；不写盘）──────────────────────────────────────── */

/** 复制 Map 并替换单文件内容。 */
function withFile(files: Map<string, string>, rel: string, text: string): Map<string, string> {
  const clone = new Map(files);
  clone.set(rel, text);
  return clone;
}

/** 从 marker 所在行的整条语句（配平到 `;`）删掉——变异后语法仍完整。 */
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

/* ── 独立真值腿（与扫描器不同算法：括号配平，无 600 字窗口）────────── */

function truthPaths(files: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const constRe = new RegExp('const' + BS + 's+([A-Za-z_][A-Za-z0-9_]*)' + BS + 's*=' + BS + 's*'
    + Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q, 'g');
  const callRe = new RegExp('(?:^|[^A-Za-z0-9_])(?:reg|register)' + BS + 's*' + BS + '(', 'g');
  for (const rel of [...files.keys()].sort()) {
    if (!ROUTE_FILE.test(rel) || rel === 'src/host/routes/routeContext.ts') continue;
    const text = stripComments(files.get(rel) as string);
    const consts = new Map<string, string>();
    for (const m of text.matchAll(constRe)) if (m[1] && m[2]) consts.set(m[1], m[2]);
    for (const m of text.matchAll(callRe)) {
      const open = (m.index ?? 0) + m[0].lastIndexOf('(');
      let depth = 0;
      let inStr: string | null = null;
      let args = '';
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
          if (depth === 0) { args = text.slice(open + 1, i); break; }
        }
      }
      if (args === '') continue;
      const lit = new RegExp(Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q).exec(args);
      if (lit && lit[1]) { out.add(lit[1]); continue; }
      const idm = new RegExp('path' + BS + 's*:' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)').exec(args);
      const viaPath = idm && idm[1] ? consts.get(idm[1]) : undefined;
      if (viaPath) { out.add(viaPath); continue; }
      const verb = new RegExp('^' + BS + 's*' + Q + '(?:GET|POST|PUT|DELETE|PATCH)'
        + Q + BS + 's*,' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)').exec(args);
      const viaVerb = verb && verb[1] ? consts.get(verb[1]) : undefined;
      if (viaVerb) { out.add(viaVerb); continue; }
      // cycle-101：首位常量形态 `reg(FLOWS_VIEW_ROUTE, handler)` —— 与资产扫描器同口径。
      // 两条腿必须认同一组形态，否则「漏报/幽灵」判据会因为形态差异互相误伤
      // （实测：本腿漏认 ⇒ 资产腿多报 1 条 ⇒ scanner-invented-registration 假红）。
      const leading = new RegExp('^' + BS + 's*([A-Za-z_][A-Za-z0-9_]*)' + BS + 's*,').exec(args);
      const viaLeading = leading && leading[1] ? consts.get(leading[1]) : undefined;
      if (viaLeading) out.add(viaLeading);
    }
  }
  return out;
}

/* ── 判据（同一套判据跑原始树与变异树 —— 这是「有牙」的唯一证明方式）── */

interface Snapshot {
  produced: string[];
  truthCount: number;
  missing: string[];
  extra: string[];
  ghosts: string[];
  /** 去注释后仍存在的 /anic/ 字面量计数（M4：证明字面量还在原文、但不算注册）。 */
  literalsAfterStrip: number;
}

function snapshot(files: Map<string, string>): Snapshot {
  const defs = scanRouteDefs(files);
  const produced = defs.filter((d) => d.producedAt !== null).map((d) => d.id).sort();
  const truth = truthPaths(files);
  const producedSet = new Set(produced);
  const literalsAfterStrip = [...files]
    .filter(([rel]) => ROUTE_FILE.test(rel))
    .reduce((n, [, raw]) => n + [...stripComments(raw).matchAll(new RegExp(Q + '(/anic/[A-Za-z0-9_/.-]+)' + Q, 'g'))].length, 0);
  return {
    produced,
    truthCount: truth.size,
    missing: [...truth].filter((p) => !producedSet.has(p)).sort(),
    extra: [...producedSet].filter((p) => !truth.has(p)).sort(),
    ghosts: routeGhosts(files, produced),
    literalsAfterStrip,
  };
}

/** 红旗判据：对同一棵树跑四条判据，返回被违反的判据名（空 = 全绿）。 */
function redFlags(s: Snapshot, baselineProduced: readonly string[]): string[] {
  const flags: string[] = [];
  if (s.missing.length > 0) flags.push('truth-leg-missed-registration');
  if (s.extra.length > 0) flags.push('scanner-invented-registration');
  if (s.ghosts.length > 0) flags.push('ghost-consumer');
  if (s.produced.join('|') !== [...baselineProduced].join('|')) flags.push('produced-set-drift');
  return flags;
}

/* ── 变异注册表 ───────────────────────────────────────────────────── */

interface Mutation {
  id: string;
  /** 一句人话：这处变异模仿什么真实改动。 */
  what: string;
  /** 返回被破坏的夹具。 */
  apply: (files: Map<string, string>) => Map<string, string>;
  /** 该变异**必须**触发的红旗（逐变异钉死，防「碰巧红了别处」冒充）。 */
  expectFlags: readonly string[];
  /** 逐项翻转证据（判据的具体形态）。 */
  expectFlip: (before: Snapshot, after: Snapshot) => void;
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1-delete-reg',
    what: '删掉 flowsRoute.ts 里 reg(\'/anic/flows\', …) 整条语句',
    apply: (f) => withFile(f, 'src/host/routes/flowsRoute.ts',
      cutStatement(f.get('src/host/routes/flowsRoute.ts') as string, 'reg(' + SQ + '/anic/flows' + SQ)),
    // 诚实：/anic/flows 无真实字面量消费者 ⇒ 不会产生幽灵消费，只让 produced 集合漂移。
    expectFlags: ['produced-set-drift'],
    expectFlip: (b, a) => {
      expect(a.produced).toHaveLength(b.produced.length - 1);
      expect(a.produced).not.toContain('/anic/flows');
      expect(a.ghosts).toEqual([]);
    },
  },
  {
    id: 'M2-delete-register-call',
    what: '删掉 cycleRoute.ts 里 register({ path: \'/anic/cycle/list\' }) 整条语句',
    apply: (f) => withFile(f, 'src/host/routes/cycleRoute.ts',
      cutStatement(f.get('src/host/routes/cycleRoute.ts') as string, 'path: ' + SQ + '/anic/cycle/list' + SQ)),
    expectFlags: ['ghost-consumer', 'produced-set-drift'],
    expectFlip: (b, a) => {
      expect(a.produced).not.toContain('/anic/cycle/list');
      expect(b.ghosts).toEqual([]);
      expect(a.ghosts, '删了注册但消费者还在 ⇒ 幽灵消费必须出现').toContain('/anic/cycle/list');
    },
  },
  {
    id: 'M3-rename-literal',
    what: '把 \'/anic/cycle/list\' 字面量改成 \'/anic/cycle/listX\'（只改一半的改名）',
    apply: (f) => withFile(f, 'src/host/routes/cycleRoute.ts',
      (f.get('src/host/routes/cycleRoute.ts') as string).split(SQ + '/anic/cycle/list' + SQ)
        .join(SQ + '/anic/cycle/listX' + SQ)),
    expectFlags: ['ghost-consumer', 'produced-set-drift'],
    expectFlip: (b, a) => {
      // 两条腿都看到新名（改名后代码里确有此注册）⇒ 不产生「幽灵注册」；
      // 真正的红是**幽灵消费**：消费者仍引用旧名，而旧名已无注册。
      expect(a.extra, '两侧都看到 listX ⇒ extra 应为空（把它当红就是假红）').toEqual([]);
      expect(a.produced).not.toContain('/anic/cycle/list');
      expect(a.produced).toContain('/anic/cycle/listX');
      expect(a.ghosts, '旧名仍在被消费者引用 ⇒ 幽灵消费必须出现').toContain('/anic/cycle/list');
    },
  },
  {
    id: 'M4-comment-out-registration',
    what: '把 \'/anic/cycle/list\' 的注册行注释掉（字面量仍在原文里）',
    apply: (f) => {
      const rel = 'src/host/routes/cycleRoute.ts';
      const lines = (f.get(rel) as string).split('\n');
      const target = lines.findIndex((l) => l.includes('path: ' + SQ + '/anic/cycle/list' + SQ));
      if (target < 0) throw new Error('marker line not found');
      let start = target;
      while (start >= 0 && !lines[start]?.includes('register({')) start -= 1;
      return withFile(f, rel, lines.map((l, i) => (i >= start && i <= target ? '// ' + l : l)).join('\n'));
    },
    expectFlags: ['ghost-consumer', 'produced-set-drift'],
    expectFlip: (b, a) => {
      // 纪律⑥的锋利之处：字面量**没有**从原文消失，但去注释后它不算注册
      expect(a.literalsAfterStrip).toBeLessThan(b.literalsAfterStrip);
      expect(a.produced).not.toContain('/anic/cycle/list');
      expect(a.ghosts).toContain('/anic/cycle/list');
    },
  },
  {
    id: 'M5-strip-path-key',
    what: '把 register({ … }) 里的 `path:` 键整条删掉（留下没有路径的注册对象）',
    apply: (f) => withFile(f, 'src/host/routes/cycleRoute.ts',
      (f.get('src/host/routes/cycleRoute.ts') as string).replace('path: ' + SQ + '/anic/cycle/list' + SQ + ',', '')),
    expectFlags: ['ghost-consumer', 'produced-set-drift'],
    expectFlip: (b, a) => {
      // 没有 path 的注册对象**不是**注册 —— 不得被算成一条 produced
      expect(a.produced).not.toContain('/anic/cycle/list');
      expect(a.produced).toHaveLength(b.produced.length - 1);
      // 消费者仍引用该路径 ⇒ 幽灵消费必现
      expect(b.ghosts).toEqual([]);
      expect(a.ghosts).toContain('/anic/cycle/list');
    },
  },
];

const BASE: Map<string, string> = buildTextMap(ROOT, buildFileIndex(ROOT));
const BASELINE_PRODUCED = snapshot(BASE).produced;

/** 按需真红演示：CLOSURE_MUTANT_FORCE=<id> 把该变异强加到真实夹具上（只影响本测试局部）。 */
const FORCED = process.env.CLOSURE_MUTANT_FORCE ?? '';
const forcedMutation = FORCED === '' ? undefined : MUTATIONS.find((m) => m.id === FORCED);
if (FORCED !== '' && forcedMutation === undefined) {
  throw new Error('unknown CLOSURE_MUTANT_FORCE=' + FORCED + '（可选：' + MUTATIONS.map((m) => m.id).join(', ') + '）');
}
const EFFECTIVE = forcedMutation ? forcedMutation.apply(BASE) : BASE;
const PRISTINE = snapshot(EFFECTIVE);
const PRISTINE_FLAGS = redFlags(PRISTINE, BASELINE_PRODUCED);

/** 归一化哈希（统一换行）：证明本测试与变异过程**没有改动工作区**。 */
function normalizedHash(files: Map<string, string>): string {
  const h = createHash('sha256');
  for (const rel of [...files.keys()].sort()) {
    h.update(rel + '\u0000' + (files.get(rel) as string).replace(/\r\n/g, '\n') + '\u0001');
  }
  return h.digest('hex');
}

describe('cycle-75 T5 变异测试：守卫有牙（5 处定向变异，每处必须翻转判定）', () => {
  it('扫描集非空下限 + 变异注册表非空（空集恒绿 = 假守卫）', () => {
    expect(PRISTINE.produced.length).toBeGreaterThanOrEqual(40);
    expect(PRISTINE.truthCount).toBeGreaterThanOrEqual(40);
    expect(MUTATIONS.length, '变异数必须 ≥3（任务底线）').toBeGreaterThanOrEqual(3);
    expect(new Set(MUTATIONS.map((m) => m.id)).size).toBe(MUTATIONS.length);
    for (const m of MUTATIONS) {
      expect(m.expectFlags.length, m.id + ' 未声明它必须触发的红旗 ⇒ 无翻转证据').toBeGreaterThan(0);
      expect(typeof m.expectFlip).toBe('function');
    }
  });

  it('红旗判据自身可判两态（不是恒真）：合成漂移必被点名', () => {
    // 直接对判据函数做两态自检——否则下面「变异后必有红旗」可能是判据恒真的产物。
    // 基线取**该合成快照自身**的 produced，使本自检独立于「强制演示态」（否则演示时会误红）。
    const clean: Snapshot = { ...PRISTINE, missing: [], extra: [], ghosts: [] };
    const own = clean.produced;
    expect(redFlags(clean, own), '全绿快照不得被点名').toEqual([]);
    expect(redFlags({ ...clean, missing: ['/anic/probe/x'] }, own)).toContain('truth-leg-missed-registration');
    expect(redFlags({ ...clean, extra: ['/anic/probe/x'] }, own)).toContain('scanner-invented-registration');
    expect(redFlags({ ...clean, ghosts: ['/anic/probe/x'] }, own)).toContain('ghost-consumer');
    expect(redFlags({ ...clean, produced: ['/anic/probe/x'] }, own)).toContain('produced-set-drift');
    // 反向对照：把漂移「改回去」就不再点名（证明 drift 判据不是恒真噪声）
    expect(redFlags({ ...clean, produced: own }, own)).toEqual([]);
  });

  it('真实树（未变异）零红旗基线 —— 变异前绿', () => {
    if (forcedMutation !== undefined) return; // 强制演示态：基线已红，交由下方两条严格判据展示
    expect(PRISTINE.missing, '真值腿发现漏报').toEqual([]);
    expect(PRISTINE.extra, '扫描器报出代码里不存在的 path').toEqual([]);
    expect(PRISTINE.ghosts, '幽灵消费').toEqual([]);
    expect(PRISTINE_FLAGS).toEqual([]);
  });

  it('严格判据（漏报级）：真值腿漏报为零 —— 变异后此处即红（见文件头 ② 命令）', () => {
    // CLOSURE_MUTANT_FORCE 演示里**真正变红**的就是这一条（真跑，不是模拟）
    expect(PRISTINE.missing, '漏报：代码里真注册但扫描器没看见').toEqual([]);
  });

  it('严格判据（幽灵级）：扫描器零幽灵注册 + 零幽灵消费 —— 变异后此处即红', () => {
    expect(PRISTINE.extra, '幽灵：扫描器报了代码里不存在的 path').toEqual([]);
    expect(PRISTINE.ghosts, '幽灵消费：消费者引用了未注册端点').toEqual([]);
  });

  for (const mut of MUTATIONS) {
    it(mut.id + '：' + mut.what + ' ⇒ 同一判据必须翻转（绿→红）', () => {
      // 前向：变异前的树必须零红旗（否则本变异证明不了任何事）
      const before = snapshot(BASE);
      expect(redFlags(before, BASELINE_PRODUCED), '变异前必须全绿').toEqual([]);
      // 变异确实改了文本（否则下面的翻转是恒真装饰）
      const mutated = mut.apply(BASE);
      expect(normalizedHash(mutated)).not.toBe(normalizedHash(BASE));
      const after = snapshot(mutated);
      // ① 翻转存在性：必有红旗
      const flags = redFlags(after, BASELINE_PRODUCED);
      expect(flags, mut.id + ' 未使任何判据翻红 —— 该变异是装饰').not.toEqual([]);
      // ② 翻转的具体形态（逐变异钉死，防「碰巧红了别处」冒充）
      for (const f of mut.expectFlags) {
        expect(flags, mut.id + ' 未触发预期红旗 ' + f + '（实际：' + flags.join(',') + '）').toContain(f);
      }
      mut.expectFlip(before, after);
    });
  }

  it('纪律·只读：变异只作用于内存副本，绝不改动夹具本身（R-31）', () => {
    /*
     * 本测试的 R-31 主张是「**我**不改工作区」。故判据 = 跑完全部变异后，
     * 输入夹具 BASE 逐文件哈希不变（变异全部落在 withFile 的克隆上）。
     *
     * 为什么**不**去「重读磁盘与 BASE 比对」：本仓是多 writer 并行会话，
     * 磁盘内容在校验期间被他人合法改动是常态 ⇒ 那条断言会因**别人的写**
     * 而红，是假红（本仓纪律：不许用会产生假红的断言冒充守卫）。
     * 不改工作区的证明应当只依赖本测试的输入是否被自己污染。
     */
    const before = normalizedHash(BASE);
    /** 逐文件快照（键 → 内容引用）：变异后必须逐项未变。 */
    const snapshotOfBase = new Map(BASE);
    for (const mut of MUTATIONS) {
      const mutated = mut.apply(BASE);
      // ① 变异产物与原树不同（变异真的发生了）
      expect(normalizedHash(mutated)).not.toBe(before);
      // ② 夹具本身逐文件不变（变异没写回输入 —— 克隆纪律）
      expect(normalizedHash(BASE), mut.id + ' 污染了输入夹具').toBe(before);
      // ③ 逐文件粒度：键集与每个键的内容都与最初完全一致
      expect([...mutated.keys()].sort()).toEqual([...BASE.keys()].sort());
      for (const [rel, text] of snapshotOfBase) {
        expect(BASE.has(rel), mut.id + ' 删掉了夹具文件 ' + rel).toBe(true);
        expect(BASE.get(rel), mut.id + ' 改写了夹具文件 ' + rel).toBe(text);
      }
    }
    expect(BASE.size).toBe(snapshotOfBase.size);
  });

  it('M5 真实缺陷登记：固定窗口失明**不得**复现（`path:` 推远 700 字仍须识别）', () => {
    /*
     * 这是本轮变异测试抓到的**真实缺陷**的回归钉（Lead 已修：形态 A 改用
     * `balancedBraces()` 括号配平，不再用「600 字固定窗口 + handler: 截断」）。
     *
     * 缺陷原形：任何把 `path:` 推到 600 字之后的**无害重构**（长注释、参数增补、
     * 换行风格变化）都会让注册**静默漏报**——registered/produced/unconsumed
     * 三个数同时漂移而无人察觉。修前实测：path 推远 700 字 ⇒ produced 直接为空。
     *
     * 钉法：直接对 `scanRouteDefs` 喂夹具，断言 `producedAt !== null`。
     * 若有人把配平退回固定窗口，本断言立刻红。
     */
    const rel = 'src/host/routes/cycleRoute.ts';
    const raw = BASE.get(rel) as string;
    const head = 'const d5 = c.webServer.register({';
    const at = raw.indexOf(head);
    expect(at, '夹具定位失败：cycleRoute 的 register 形态已变，请同步本回归钉').toBeGreaterThan(0);
    const pad = ' /*pad*/ k: ' + JSON.stringify('y'.repeat(700)) + ',';
    const far = withFile(BASE, rel, raw.slice(0, at + head.length) + pad + raw.slice(at + head.length));
    const farDef = scanRouteDefs(far).find((d) => d.id === '/anic/cycle/list');
    expect(farDef, 'path 推远后该注册从扫描结果里消失了').toBeDefined();
    expect(farDef?.producedAt, '固定窗口失明复发：path: 距 register({ 700 字即漏报').not.toBeNull();
    // 反向自检：同一夹具在**删掉 path 键**后必须不再算注册（证明不是恒真）
    const stripped = withFile(BASE, rel, raw.replace('path: ' + SQ + '/anic/cycle/list' + SQ + ',', ''));
    expect(scanRouteDefs(stripped).find((d) => d.id === '/anic/cycle/list')?.producedAt ?? null).toBeNull();
  });

  it('M5 回归钉②：两条相邻 register({...}) 各归各的 path（配平不得串台）', () => {
    /*
     * 括号配平若采纳「第一个 } 即结束」的错判，相邻两条注册会互相污染：
     * 第二条的 path 被算成第一条的，或第一条吞掉第二条。用合成夹具正面钉住。
     */
    const fixture = [
      'ws.register({ kind: ' + SQ + 'exact' + SQ + ', path: ' + SQ + '/anic/probe/a' + SQ + ', handler: (q, s) => {} });',
      'ws.register({ kind: ' + SQ + 'exact' + SQ + ', path: ' + SQ + '/anic/probe/b' + SQ + ', handler: (q, s) => {} });',
    ].join('\n');
    const defs = scanRouteDefs(new Map([['src/host/routes/probeRoute.ts', fixture]]));
    expect(defs.map((d) => d.id)).toEqual(['/anic/probe/a', '/anic/probe/b']);
    expect(defs.map((d) => d.producedAt)).toEqual([
      'src/host/routes/probeRoute.ts:1',
      'src/host/routes/probeRoute.ts:2',
    ]);
    // 嵌套对象不得提前截断（配平深度 >1 仍正确）
    const nested = 'ws.register({ kind: ' + SQ + 'exact' + SQ + ', meta: { a: { b: 1 } }, path: '
      + SQ + '/anic/probe/c' + SQ + ', handler: (q, s) => {} });';
    expect(scanRouteDefs(new Map([['src/host/routes/probeRoute.ts', nested]])).map((d) => d.id))
      .toEqual(['/anic/probe/c']);
    // 字符串内的花括号不得参与配平（引号状态机保护）
    const braceInStr = 'ws.register({ note: ' + SQ + 'a } b { c' + SQ + ', path: '
      + SQ + '/anic/probe/d' + SQ + ', handler: (q, s) => {} });';
    expect(scanRouteDefs(new Map([['src/host/routes/probeRoute.ts', braceInStr]])).map((d) => d.id))
      .toEqual(['/anic/probe/d']);
  });

  it('force 开关仍有牙：每个可强制 id 都能让判据真红（无恒真开关）', () => {
    /*
     * CLOSURE_MUTANT_FORCE 的价值全在于「强制后真的红」。若某个 id 被强制后
     * 仍全绿，它就是个恒真开关（装饰）。这条对**每个** id 逐个证实其翻转存在性。
     */
    for (const m of MUTATIONS) {
      expect(redFlags(snapshot(m.apply(BASE)), BASELINE_PRODUCED), m.id + ' 强制后仍全绿 ⇒ 恒真开关')
        .not.toEqual([]);
    }
  });
});
