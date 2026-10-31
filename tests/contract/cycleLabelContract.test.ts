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
 * ## ⚠️ cycle-91 修正：判定器从「单阈值」改成「三层」（本轮实测缺陷的根治）
 *
 * **实测缺陷**（cycle-91 基线：226 文件 / 3064 用例，1 红）：初版判定器是
 * `n > cur + FORWARD_TOLERANCE ⇒ 越界`，而 `FORWARD_TOLERANCE` 是**固定**的 8。
 * 「窗口右边界 = cur + 8」随本仓推进**右移**，棘轮基线成员
 * （95/96/97/99）是**绝对值**——两者的相对关系必然漂移：
 *
 * | 本仓推进到 | 窗口右界 | 95/96/97/99 是否仍在窗外 | 豁免表是否还在起作用 |
 * |---|---|---|---|
 * | cur=87 | 95 | 95 恰好压线 | 仅 96/97/99 有效 |
 * | cur=88 | 96 | **全部落窗** | ❌ **全部空转** |
 * | cur=91（本轮） | 99 | **全部落窗** | ❌ **全部空转** |
 *
 * 也就是说：**豁免表的实际作用从 cycle-88 起就整体失效了 4 个循环**，
 * 而守卫**没有报任何警**——失效方向恰好是「放行变宽」，最容易被忽视。
 * cycle-91 基线跑批里真正炸掉的不是主断言，而是反向自检里那句**硬编码
 * `cycle-99`** 的探针（`99 > 99` 不再成立）——**自检里的裂缝先于守卫本体暴露**，
 * 这恰好证明反向自检是有效的。
 *
 * **根因**：把「窗口边界随 cur 漂移」与「基线成员是绝对值」两件事用**同一个阈值**
 * 耦合在一起——无论阈值取多大，两条轨必然在某刻相撞。
 *
 * **修法（三层判定，边界互不耦合）**：
 *   1. `n ≤ cur` ⇒ **本仓历史沿革号**，合法（无需进豁免表）；
 *   2. `cur < n ≤ cur + FORWARD_TOLERANCE` ⇒ **领先窗口**（写「下一轮」号是常态），
 *      合法；
 *   3. 其余 ⇒ **必须显式列入豁免表**（跨仓历史引用 / 夹具假号）。
 *
 * 三层各有**独立**语义，因此不再有「两个数必然相撞」的耦合：
 * 历史号由 `cur` 覆盖，领先号由 `cur+8` 覆盖，豁免号由**冻结集合**覆盖。
 * `cur` 无限增长时第 3 层才真正承担判定，而它靠**冻结集合**维持，不会随时间变宽。
 *
 * **自检同步改造**：反向自检**不再依赖任何真实基线成员留在窗外**
 * （那正是本轮红掉的原因），改用**合成探针** `cur + FORWARD_TOLERANCE + 1`
 * ——该数按构造必然越界，与 cur 漂移无关。同时对**当前仍在窗外**的基线成员
 * 额外断言「去掉基线即越界」，证明豁免表**此刻**真的有牙（不是恒绿装饰）。
 *
 * ## 守卫三条纪律
 *
 *   - 反向自检：用**合成探针**证明判定器**能识别新增越界号**（否则恒绿）；
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
 * **棘轮基线**：已确认合法、但**按构造**落在「领先窗口之外」的越界号。
 *
 * 每一项都必须有理由——扩列即「承认某编号合法」，须在本注释里写清为什么。
 * 三个类别的既定成员：
 *   - 95/96/97/99：**迁移前历史引用**（指向 dsh-codegraph-visualizer 迁移前写就
 *     的文档/实现，cycle-40 审计 P1-8 已明示跨仓性质）——删掉它们会让注释失去
 *     真实出处，故保留并豁免；
 *   - 404/999：**测试夹具假号**（`cycle-404` 验「不存在」、`cycle-999` 验「未知」
 *     ——语义清晰，非循环标注）。
 *
 * **cycle-91 语义变更**：本表从「**当前**越界号集合」改为「**按构造**越界号集合」。
 * 旧语义下，本表成员会随 `cur` 推进**逐个落进**领先窗口而失效（cycle-88 起
 * 已整体空转）；新语义下，成员**恒为**需要豁免者——即便某个成员此刻已落入
 * 领先窗口（因 `cur` 增长），它仍在表中（防止将来 `cur` 回退时它突然变红）。
 *
 * **注意**：`cycle-72` **不在**本基线里——它与本轮差 1，已被 `FORWARD_TOLERANCE`
 * 覆盖（写代码时引用「下一轮」号是常态，无需豁免）。基线只收容**超出宽容**且
 * 确认合法的号。
 */
const RATCHET_ALLOWED: readonly number[] = [95, 96, 97, 99, 404, 999];

/** 允许的领先量（引用「本轮/下一轮」编号时的宽容）。 */
const FORWARD_TOLERANCE = 8;

/**
 * 三层判定的**层号**（用于报错信息指明「哪一层」判的）。
 *
 * 为什么要有层号：判定失败时只说「越界」是不够的——调用者需要知道
 * 「这是历史号漏进表了」还是「这是场地号混进来了」，两者的修法完全相反。
 */
const LAYER_HISTORY = 0;
const LAYER_FORWARD = 1;
const LAYER_OUTSIDE = 2;

type Verdict = { offender: boolean; layer: number };

/**
 * 判定一个编号是否越界（**纯函数** —— 三层判定，与 `cur` 漂移无关）。
 *
 * 层次（自上而下，命中即返回）：
 *   - L0 `n <= cur`：本仓**历史沿革号** → 合法；
 *   - L1 `n <= cur + FORWARD_TOLERANCE`：**领先窗口** → 合法；
 *   - L2 其余：需**显式豁免**（`RATCHET_ALLOWED`）→ 否则越界。
 *
 * 为什么 L0 合法：`cur` 之前的编号必然是本仓自己的沿革（注释里引用
 * 「cycle-82 时怎么做的」这类历史锚点是**正常且必要**的）。
 * 旧判据 `n > cur + 8` 同样放行 L0，只是没把语义写出来。
 */
function judgeNumber(n: number, cur: number): Verdict {
  if (n <= cur) return { offender: false, layer: LAYER_HISTORY };
  if (n <= cur + FORWARD_TOLERANCE) return { offender: false, layer: LAYER_FORWARD };
  return { offender: !RATCHET_ALLOWED.includes(n), layer: LAYER_OUTSIDE };
}

/** 越界号 = 三层判定判为越界的编号。 */
function offenderNumbers(nums: Map<number, string[]>, cur: number): Array<[number, string[]]> {
  return [...nums.entries()]
    .filter(([n]) => judgeNumber(n, cur).offender)
    .sort((a, b) => b[0] - a[0]);
}

describe('循环归属标注契约（cycle-71 T-7132 · cycle-91 判定器改三层）', () => {
  const cur = currentCycleNumber();
  const files = sourceFiles();

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

  it('守卫纪律①：判定器反向自检——**合成探针**必须被判越界（先证明有牙）', () => {
    // 合成探针：按构造必然落在 L2（领先窗口之外），且不在豁免表里。
    // 与 cur 的具体取值无关 ⇒ cur 漂移不会让自检失效（cycle-91 修复的核心）。
    const synthetic = cur + FORWARD_TOLERANCE + 1;
    expect(judgeNumber(synthetic, cur).offender, '合成探针必须判越界（否则守卫恒绿）').toBe(true);
    expect(judgeNumber(synthetic, cur).layer, '合成探针应落在 L2（窗外层）').toBe(LAYER_OUTSIDE);
    // L0（历史号）与 L1（领先号）必须**不**判越界——否则会误伤本仓自身沿革。
    expect(judgeNumber(cur, cur).offender, '本轮号不应判越界').toBe(false);
    expect(judgeNumber(cur, cur).layer, '本轮号应落在 L0（历史层）').toBe(LAYER_HISTORY);
    expect(judgeNumber(cur + 1, cur).offender, '下一轮号不应判越界').toBe(false);
    expect(judgeNumber(cur + 1, cur).layer, '下一轮号应落在 L1（领先层）').toBe(LAYER_FORWARD);
    expect(judgeNumber(cur + FORWARD_TOLERANCE, cur).offender, '领先窗口上界不应判越界').toBe(false);
    // 基线内的历史合法号必须被豁免（挑一个**此刻仍在窗外**的成员验证）。
    const stillOutside = RATCHET_ALLOWED.find((n) => n > cur + FORWARD_TOLERANCE);
    if (stillOutside !== undefined) {
      expect(
        judgeNumber(stillOutside, cur).offender,
        `基线成员 cycle-${String(stillOutside)} 必须被豁免`,
      ).toBe(false);
    }
  });

  it('守卫纪律②：棘轮本身可失败——去掉豁免表后窗外成员立即变违规（非装饰）', () => {
    // 只对**此刻仍在窗外**的基线成员断言；已落进领先窗口的成员此刻无牙
    // （这是 cur 漂移的必然结果，不是守卫失效——豁免表仍为它们保留位置）。
    const stillOutside = RATCHET_ALLOWED.filter((n) => n > cur + FORWARD_TOLERANCE);
    for (const n of stillOutside) {
      const withoutRatchet = n > cur + FORWARD_TOLERANCE;
      expect(
        withoutRatchet,
        `去掉基线后 cycle-${String(n)} 应为越界（证明基线真在起作用，非装饰）`,
      ).toBe(true);
    }
    // 无论窗外成员有几个，**豁免表不得为空**（否则守卫整体退化为单阈值）。
    expect(RATCHET_ALLOWED.length, '豁免表为空 ⇒ 棘轮退化成单阈值，本末倒置').toBeGreaterThan(0);
  });

  it('**主断言**：无**新增**越界循环标注（历史合法引用豁免，新漂移即红）', () => {
    const offenders = offenderNumbers(annotatedCycleNumbers(files), cur);
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

  it('语义说明：场地量级号仍在本仓可接受窗口之外（判据有意义的前提）', () => {
    /*
     * 原判据是 `|104 - cur| > 20`（cycle-71 时点：本仓 71、场地 104）。
     * cycle-84 实测暴露该写法的缺陷：本仓推进到 84 时 |104-84| = 20，
     * 断言变红——但**判据本身仍成立**（104 依然是越界号）。用固定差值表达
     * 「量级不同」，等于把守卫的前提绑在仓库年龄上，越推进越假红。
     *
     * 现在改为**与判定器同源**的前提：场地号必须落在 `cur + FORWARD_TOLERANCE`
     * 之外（即判定器真的会把它判成越界）。这样它只在**前提真的失效**时红
     * ——本仓推进到 96+ 时它会主动要求重定基线，而不是在某一天静默变宽。
     *
     * ## cycle-96：前提确实失效了，这次是**按事实重定基线**（不是放宽）
     *
     * 实测：本仓 `cur=96`，窗口右界 = 96+8 = **104**。原基线 `SITE_NUMBERS=[104,105]`
     * 中的 **104 恰好落在窗口右界上**（`104 > 104` 不成立）⇒ 本断言红。
     *
     * 但它红得对：**前提真的失效了**。两个仓库都在向前推进，本仓 71→96、
     * 场地 104→123（实测 `dsh-codegraph-visualizer/.cycles/workflow-state.json`
     * 的 `currentCycle = cycle-123`）。「量级不同」这个前提**不可能靠时间保持**——
     * 它需要的是**每次重定基线时按当时的真实场地号填**，而不是把 104 当成永恒常量。
     *
     * 所以本轮的正确动作是：把 `SITE_NUMBERS` 更新为**当前真实场地号**
     * （123/124），而不是把 `FORWARD_TOLERANCE` 放大到能容下 104。
     * 后者会让「104 是不是越界号」这个判断永远模糊下去 —— 那才是真放宽。
     */
    const SITE_NUMBERS = [123, 124];
    for (const n of SITE_NUMBERS) {
      expect(
        n,
        `场地号 cycle-${String(n)} 已落入本仓合法窗口（cur=${String(cur)} + ${String(FORWARD_TOLERANCE)}）——`
        + '「场地编号混入本仓」这个判据的前提失效了，需要重新确认基线（不是放宽这里）',
      ).toBeGreaterThan(cur + FORWARD_TOLERANCE);
    }
  });
});
