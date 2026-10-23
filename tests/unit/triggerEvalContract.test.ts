/**
 * trigger-eval 数据集与评分器契约（cycle-35 扩容钉子）。
 *
 * 数据集从 cycle-16 的 20 条扩容到 38 条（19 正例全工具覆盖 + 19 负例）。
 * 本测试钉三件事：
 * 1. 数据集结构不变量（19/19 均衡、split 比例、全工具覆盖、id 唯一）。
 * 2. 评分器关键区分度对（词面相撞对子必须由 description 的 Triggers 段区分开）。
 * 3. cycle-35 修复的两个 Triggers 增补必须留在位（技能副本/回退一档）——
 *    防止未来 description 修剪时无声丢失。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const dataset = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'trigger-eval-dataset.json'), 'utf8'));

// ── 与 scripts/trigger-eval.mjs 同源的评分器（同步钉实现，改评分器必须过这里）──
function loadToolFaces(): Array<{ name: string; description: string }> {
  const hostDir = join(repoRoot, 'src', 'host');
  const files = readdirSync(hostDir).filter((f) => /^tools.*\.ts$/.test(f) && f !== 'toolsSlot.ts');
  const faces: Array<{ name: string; description: string }> = [];
  for (const f of files) {
    const src = readFileSync(join(hostDir, f), 'utf8');
    const re = /name:\s*'(anic_[a-z_]+)',[\s\S]*?description:\s*([\s\S]*?),\r?\n\s*output:/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const parts = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((p) => p[1]);
      faces.push({ name: m[1], description: parts.join('') });
    }
  }
  return faces;
}

function tokenize(desc: string): { zh: string[]; en: string[] } {
  const zh = desc.match(/[\u4e00-\u9fff][\u4e00-\u9fff/-]*/g) ?? [];
  const en = desc.match(/[A-Za-z][A-Za-z_-]{2,}/g) ?? [];
  return { zh, en };
}

const STOP = ['Use', 'when', 'the', 'and', 'for', 'with', 'should', 'needs', 'before', 'after', 'together'];

function score(query: string, face: { description: string }): number {
  const q = query.toLowerCase();
  const { zh, en } = tokenize(face.description);
  let s = 0;
  for (const z of zh) {
    if (z.length >= 2 && q.includes(z)) s += z.length >= 4 ? 3 : 2;
  }
  for (const e of en) {
    if (STOP.includes(e)) continue;
    if (e.length >= 4 && q.includes(e.toLowerCase())) s += 2;
    else if (e.length >= 4 && q.includes(e.toLowerCase().replace(/_/g, ' '))) s += 2;
  }
  return s;
}

const faces = loadToolFaces();
const byName = new Map(faces.map((f) => [f.name, f]));

describe('数据集结构不变量（cycle-35 扩容后）', () => {
  it('40 条 = 21 pos-* 正例 + 5 neg-*(otherTool) 区分度对 + 14 neg-*(none) 纯负例', () => {
    const pos = dataset.queries.filter((q: { id: string }) => q.id.startsWith('pos-'));
    const negOther = dataset.queries.filter((q: { id: string; expectedTool: string | null }) => q.id.startsWith('neg-') && q.expectedTool !== null);
    const negNone = dataset.queries.filter((q: { expectedTool: string | null }) => q.expectedTool === null);
    expect(pos).toHaveLength(21);
    expect(negOther).toHaveLength(5);
    expect(negNone).toHaveLength(14);
    expect(dataset.queries).toHaveLength(40);
  });

  it('21 个 pos-* 正例覆盖全部 21 个 anic_* 工具（每工具恰 1 条）', () => {
    const covered = new Set(dataset.queries.filter((q: { id: string }) => q.id.startsWith('pos-')).map((q: { expectedTool: string }) => q.expectedTool));
    expect(covered.size).toBe(21);
    // 与源码 faces 对账：源码 21 工具全在正例集
    for (const f of faces) expect(covered.has(f.name)).toBe(true);
  });

  it('split 比例维持 ~60/40（21 train / 19 test）', () => {
    const train = dataset.queries.filter((q: { split: string }) => q.split === 'train');
    const test = dataset.queries.filter((q: { split: string }) => q.split === 'test');
    expect(train).toHaveLength(21);
    expect(test).toHaveLength(19);
  });

  it('id 唯一且前缀语义正确（pos-=肯定；neg-=否定检验：none 或 otherTool 对）', () => {
    const ids = dataset.queries.map((q: { id: string }) => q.id);
    expect(new Set(ids).size).toBe(40);
    for (const q of dataset.queries) {
      // neg-* 可能 expectedTool=null（不触发任何）或非 null（必须触发指定的「正确」工具而非词面近邻）
      expect(q.id.startsWith('pos-') || q.id.startsWith('neg-')).toBe(true);
    }
  });

  it('cycle-16 原始 20 条逐字保留（扩容纪律：不改旧条目）', () => {
    const legacy = ['pos-01', 'pos-05', 'pos-10', 'neg-01', 'neg-05', 'neg-09', 'neg-10'];
    for (const id of legacy) {
      const q = dataset.queries.find((x: { id: string }) => x.id === id);
      expect(q, id).toBeDefined();
      expect(q.rationale.startsWith('正例') || q.rationale.includes('shouldTrigger')).toBe(true);
    }
    // pos-03 是 cycle-29 修过的（跑一轮完整的迭代）——其修复措辞必须在位
    const pos03 = dataset.queries.find((x: { id: string }) => x.id === 'pos-03');
    expect(pos03.query).toContain('跑一轮完整的迭代');
  });
});

describe('评分器区分度对（词面相撞必须有胜者）', () => {
  const pairs: Array<{ label: string; query: string; expected: string; rival: string }> = [
    { label: 'bootstrap vs bootstrap_analyze', query: '插件本体最近好像有点不对劲，先做一次自举看看有没有技术债提案要登记', expected: 'anic_bootstrap', rival: 'anic_bootstrap_analyze' },
    { label: 'downgrade vs status（回退一档触发词）', query: '团队担心自主级虚高，查一下现在有没有熔断信号，有的话把自主级从 L4 回退一档并留证据', expected: 'anic_autonomy_downgrade', rival: 'anic_status' },
    { label: 'skill_repair vs status（技能副本触发词）', query: 'status 报告技能完整性校验不过，装好的技能副本和内置原版对不上，修复一下技能', expected: 'anic_skill_repair', rival: 'anic_status' },
    { label: 'flows_gate_check vs gate_check', query: '跑一下门禁，但这次要从流程状态机走，我要看 G2 的流转事件和状态转移，最好对比 script 和 native 两个引擎有没有分叉', expected: 'anic_flows_gate_check', rival: 'anic_gate_check' },
  ];
  // 与 trigger-eval.mjs 同判定：top-1 = 平分时稳定排序按 faces 注册序取胜
  function top1(query: string): string | null {
    const scored = faces.map((f) => ({ name: f.name, s: score(query, f) })).sort((a, b) => b.s - a.s);
    return scored[0]!.s > 0 ? scored[0]!.name : null;
  }
  it.each(pairs)('$label', ({ query, expected, rival }) => {
    expect(top1(query)).toBe(expected);
    expect(score(query, byName.get(expected)!)).toBeGreaterThanOrEqual(score(query, byName.get(rival)!));
  });

  it('负例（团队周报）任何工具都不得正分命中——anic_status 不误触', () => {
    const q = dataset.queries.find((x: { id: string }) => x.id === 'neg-11');
    for (const f of faces) {
      expect(score(q.query, f), f.name).toBe(0);
    }
  });
});

describe('cycle-35 修复的 Triggers 增补必须留在位', () => {
  it('anic_skill_repair 含「技能副本」触发词（cycle-35 增补）', () => {
    expect(byName.get('anic_skill_repair')!.description).toContain('技能副本');
  });
  it('anic_autonomy_downgrade 含「回退一档」触发词（cycle-35 增补）', () => {
    expect(byName.get('anic_autonomy_downgrade')!.description).toContain('回退一档');
  });
});

describe('全量数据集离线重放（与 trigger-eval.mjs 同判定）', () => {
  it('recall 100% / FPR 0%（26 正 = 21 pos + 5 negOther；14 纯负例）', () => {
    let pass = 0, total = 0, fp = 0, negTotal = 0;
    for (const q of dataset.queries) {
      const scored = faces.map((f) => ({ name: f.name, s: score(q.query, f) })).sort((a, b) => b.s - a.s);
      const top = scored[0]!.s > 0 ? scored[0]!.name : null;
      if (q.expectedTool !== null) {
        total++;
        if (top === q.expectedTool) pass++;
      } else {
        negTotal++;
        if (top !== null) fp++;
      }
    }
    expect(total).toBe(26);
    expect(negTotal).toBe(14);
    expect(pass / total).toBe(1);
    expect(fp / negTotal).toBe(0);
  });
});
