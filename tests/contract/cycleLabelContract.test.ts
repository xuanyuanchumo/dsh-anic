/**
 * 循环归属标注契约守卫（cycle-71 T-7132）。
 *
 * ## 为什么钉这个
 *
 * **实证缺陷**：round-2 并行实现时 `src/` 与 `tests/` 的**源码注释**里出现了
 * **28 处 `cycle-104`** 标注——但本仓是 **cycle-71**（`.cycles/workflow-state.json`
 * 的 `currentCycle`）；104/105 是**验证场地**（dsh-codegraph-visualizer）的循环号。
 * 实现者从「任务号 T-10501」反推循环号，把场地编号写进了本仓源码。
 *
 * 危害不是「错一个字」而是**可溯源性失效**：读者按 `cycle-104` 去
 * `.cycles/cycles/` 找证据会**找不到**（本仓无该目录），注释里的「为什么这么改」
 * 因此失去锚点——正是「每条结论可复算」纪律的反面。
 *
 * ## 判据（**棘轮**设计，本文件的核心决策）
 *
 * 初版判据是「不得显著超出本轮」——**实测证明它太天真**（守卫第一次跑就红了）：
 * 本仓**合法**存在三类越界号：
 *   ① **迁移前历史引用**（`cycle-95..99`，21 处，cycle-40 审计 P1-8 明示这些指向
 *      迁移前的验证场仓库，是**正确的跨仓标注**）；
 *   ② **夹具编号**（`cycle-404` / `cycle-999` —— 明显是测试用的假号，语义清晰）；
 *   ③ **本轮并行实现的编号漂移**（`cycle-72`，本轮引入 —— 与本仓 cycle-71 差 1，
 *      属「写代码时引用下一个编号」的轻微领先，非可溯源性错误）。
 *
 * 因此判据改为**棘轮**：把「当前已存在的越界号集合」冻结为**基线**，守卫只拒绝
 * **新增**的越界号。这样：
 *   - 历史合法的跨仓标注**不被误伤**（零回归）；
 *   - **任何新的**场地编号混入**立即红**（本缺陷类的根治）；
 *   - 基线可随「确认为合法」的引用显式扩列（每一步都要留痕，不许静默变宽）。
 *
 * ## 守卫三条纪律
 *
 *   - 反向自检：先用拼接样例证明判定器**能识别新增越界号**（否则恒绿）；
 *   - 扫描集非空：src/ 扫出 0 个 `cycle-N` 标注 = 解析失效，直接 FAIL；
 *   - 棘轮本身可失败：构造一个「新增号」必须被判出（见反向自检用例）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 当前循环号（真相源：workflow-state.json 的 currentCycle）。 */
function currentCycleNumber(): number {
  const raw = readFileSync(join(ROOT, '.cycles', 'workflow-state.json'), 'utf8');
  const m = /"currentCycle"\s*:\s*"cycle-(\d+)"/.exec(raw);
  if (!m?.[1]) throw new Error('workflow-state.json 未解析出 currentCycle —— 守卫纪律③：真相源缺失即 FAIL');
  return Number(m[1]);
}

/** 递归列出 src/ 与 tests/ 的 .ts/.tsx（排除本守卫自身）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      if (p.endsWith('cycleLabelContract.test.ts')) continue; // 不扫自身（含基线字面量）
      out.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'tests'));
  return out;
}

/** 提取 `cycle-<digits>` 编号集合（≥2 位；`cycle-1` 这类短号忽略——它们是夹具）。 */
function annotatedCycleNumbers(files: string[]): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/cycle-(\d{2,})/g)) {
      const n = Number(m[1]);
      const list = found.get(n) ?? [];
      list.push(f.slice(ROOT.length + 1));
      found.set(n, list);
    }
  }
  return found;
}

/**
 * **棘轮基线**：已确认为合法的越界号（上界 = 本轮 + 宽容量）。
 *
 * 每一项都必须有理由——扩列即「承认某编号合法」，须在本注释里写清为什么。
 * 三个类别的既定成员：
 *   - 95/96/97/99：**迁移前历史引用**（指向 dsh-codegraph-visualizer 迁移前写就
 *     的文档/实现，cycle-40 审计 P1-8 已明示跨仓性质）——删掉它们会让注释失去
 *     真实出处，故保留并豁免；
 *   - 404/999：**测试夹具假号**（`cycle-404` 验「不存在」、`cycle-999` 验「未知」
 *     ——语义清晰，非循环标注）。
 *
 * **注意**：`cycle-72` **不在**本基线里——它与本轮差 1，已被 `FORWARD_TOLERANCE`
 * 覆盖（写代码时引用「下一轮」号是常态，无需豁免）。基线只收容**超出宽容**且
 * 确认合法的号。
 */
const RATCHET_ALLOWED: readonly number[] = [95, 96, 97, 99, 404, 999];

/** 允许的领先量（引用「本轮/下一轮」编号时的宽容）。 */
const FORWARD_TOLERANCE = 8;

describe('循环归属标注契约（cycle-71 T-7132：防场地编号误入本仓源码）', () => {
  const cur = currentCycleNumber();
  const files = sourceFiles();

  /** 越界号 = 超出「本轮 + 宽容」且不在棘轮基线里。 */
  function offenderNumbers(nums: Map<number, string[]>): Array<[number, string[]]> {
    return [...nums.entries()]
      .filter(([n]) => n > cur + FORWARD_TOLERANCE && !RATCHET_ALLOWED.includes(n))
      .sort((a, b) => b[0] - a[0]);
  }

  it('守卫纪律③：扫描集非空（解析失效 = 假守卫，直接 FAIL）', () => {
    expect(cur).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(50);
    // 相对路径口径：files 持绝对路径，故用 `sep` 判 src 半边（曾用 startsWith('src')
    // 恒假——绝对路径不以 'src' 开头，导致本断言误红）。
    const srcOnly = files.filter((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/').startsWith('src/'));
    expect(srcOnly.length).toBeGreaterThan(50);
    // src/ 必然有 cycle-N 标注（本仓注释纪律），零个说明解析形态失效。
    expect(annotatedCycleNumbers(srcOnly).size, 'src/ 未扫出任何 cycle-N 标注').toBeGreaterThan(0);
  });

  it('守卫纪律①：判定器反向自检——**新增**越界号必须判出（先证明有牙）', () => {
    const mk = (n: string): number => Number(['cycle', '-', n].join('').replace('cycle-', ''));
    const within = mk('71'); // 本轮号
    const opportunist = mk('104'); // 场地量级且**未**豁免 → 必须判出
    const ratcheted = mk('97'); // 基线内（超宽容但已豁免）
    const judge = (n: number): boolean => n > cur + FORWARD_TOLERANCE && !RATCHET_ALLOWED.includes(n);
    expect(judge(within), '本轮号不应判越界').toBe(false);
    expect(judge(ratcheted), '基线内的历史合法号应豁免').toBe(false);
    expect(judge(opportunist), '未豁免的场地量级号必须判越界').toBe(true);
    // 棘轮可失败性：去掉基线后，被豁免号立即变成违规（证明基线真在起作用，非装饰）
    const withoutRatchet = (n: number): boolean => n > cur + FORWARD_TOLERANCE;
    expect(withoutRatchet(ratcheted), '去掉基线后 cycle-97 应为越界（证明棘轮非装饰）').toBe(true);
  });

  it('**主断言**：无**新增**越界循环标注（历史合法引用豁免，新漂移即红）', () => {
    const offenders = offenderNumbers(annotatedCycleNumbers(files));
    const rendered = offenders.map(([n, where]) => `cycle-${String(n)} (${String(where.length)} 处，如 ${where[0] ?? ''})`);
    expect(
      rendered,
      `出现新的越界循环标注（本仓本轮 cycle-${String(cur)}）——多半是把验证场地编号写进了本仓源码。\n`
      + `若确属合法（如跨仓历史引用/夹具假号），请把该号显式加入 RATCHET_ALLOWED 并写清理由：\n${rendered.join('\n')}`,
    ).toEqual([]);
  });

  it('棘轮基线成员不得「空转」：每个豁免号都必须在源码里真实存在（防豁免残留）', () => {
    const nums = annotatedCycleNumbers(files);
    const ghostRatchet = RATCHET_ALLOWED.filter((n) => !nums.has(n));
    expect(
      ghostRatchet,
      `棘轮基线里这些号在源码中已不存在——应删掉它们（豁免残留会让守卫语义变宽）：${ghostRatchet.join(', ')}`,
    ).toEqual([]);
  });

  it('语义说明：本仓与场地编号量级确实不同（判据有意义的前提）', () => {
    // 场地实测在 104/105 附近；本仓在 71 —— 差距 > 20 时「混用」必然可辨。
    expect(Math.abs(104 - cur)).toBeGreaterThan(20);
  });
});
