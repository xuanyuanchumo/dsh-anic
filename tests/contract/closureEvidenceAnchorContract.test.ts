/**
 * 闭环体检**证据锚点**契约（cycle-75 · 修 `keyAnchor` 误报后的守卫）。
 *
 * ## 被守卫的缺陷（T2 实测、Lead 复现证实）
 *
 * 旧 `keyAnchor()` 用 `key.split('.').pop()` 取**叶子名**再全文找第一处匹配，
 * 短叶子名会命中**别的键**。三例全部错位：
 *
 * ```
 * trace.statusDone  → 报 :79   真值 :123   （:79 是 live.statusDone）
 * state.loading     → 报 :24   真值 :60
 * gate.pending      → 报 :75   真值 :235   （:75 是 live.pending）
 * ```
 *
 * `ClosureItem.definedAt` 是白盒面上「这资产在哪定义」的锚点——**错的行号是
 * 可见性伪证**：读者按它跳转会看到无关内容，却以为定位成功。比「未定位」更糟。
 *
 * ## 修法（方案 A）
 *
 * `localeKeyAnchors.buildKeyLineIndex`：逐行扫文本（不 JSON.parse —— 解析后无行号），
 * 用**缩进栈**还原 JSON 完整路径 → 行号。未定位返回 **`:0`（显式「未定位」）**，
 * 不猜行号。
 *
 * ## 判据（全部可机器证伪）
 *
 * ① 覆盖：索引必须覆盖 `flattenKeys` 的**每一个**叶子键（漏一个 = 白盒面上有个洞）；
 * ② 正确：每个叶子键锚定的行，**该行必须真的含这个叶子名**（非平凡校验，
 *    不是「有行号就算过」）；
 * ③ 不撞车：同名叶子（`live.statusDone` vs `trace.statusDone`）必须指向**不同行**；
 * ④ 三例回归钉：上述三条错位行号必须等于磁盘真值；
 * ⑤ 未定位语义：不存在的键 → `locale/zh.json:0`（显式，不是猜一个行号）；
 * ⑥ **反向自检**：把某键在文本里移动后，锚点必须**跟随**（证明它是真定位，
 *    不是碰巧命中一个固定行）。
 *
 * 守卫纪律：扫描集非空抛错；只读（R-31）；不引入第二份词表真相源
 * （键集仍以 `flattenKeys(JSON.parse(...))` 为准，索引只补行号维）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenKeys, keyAnchor } from '../../src/host/closureAudit/i18nClosure.ts';
import { buildKeyLineIndex, lineOfKey } from '../../src/host/closureAudit/localeKeyAnchors.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8');
/** 去掉行尾 `\r` 再比（工作区是 CRLF；JS 的 `.` 不匹配行终止符，比错会假红）。 */
const LINES = RAW.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
const LEAVES = flattenKeys(JSON.parse(RAW) as Record<string, unknown>);
const INDEX = buildKeyLineIndex(RAW);

describe('cycle-75 词表证据锚点（definedAt 不许误报）', () => {
  it('守卫纪律：扫描集非空（叶子键/索引都必须解析出来，空集恒绿是假守卫）', () => {
    expect(LEAVES.length).toBeGreaterThan(200);
    expect(INDEX.size).toBeGreaterThan(200);
  });

  it('① 覆盖：索引覆盖每一个叶子键（漏一个 = 白盒面上有个洞）', () => {
    const missing = LEAVES.filter((k) => !INDEX.has(k));
    expect(missing, '未建索引的叶子键：' + missing.slice(0, 5).join(', ')).toEqual([]);
  });

  it('② 正确：每个键锚定的行必须真的含该叶子名（非平凡校验）', () => {
    const wrong: string[] = [];
    for (const key of LEAVES) {
      const n = lineOfKey(INDEX, key);
      const leaf = key.split('.').pop() as string;
      const text = LINES[n - 1] ?? '';
      if (n <= 0 || !text.includes('"' + leaf + '"')) wrong.push(key + '→' + String(n));
    }
    expect(wrong, '行号与叶子名不符：' + wrong.slice(0, 5).join(', ')).toEqual([]);
  });

  it('③ 不撞车：同名叶子在不同父级下必须指向不同行', () => {
    expect(INDEX.get('live.statusDone')).toBeDefined();
    expect(INDEX.get('trace.statusDone')).toBeDefined();
    expect(INDEX.get('live.statusDone')).not.toBe(INDEX.get('trace.statusDone'));
  });

  it('④ 三例回归钉：曾误报的三个键必须等于磁盘真值', () => {
    // 真值由「该行含叶子名」与「父级归属」同时确定（见 ② 的机械校验）。
    // cycle-79（WS-3 死键清理）：locale/zh.json 删除 32 条死键 ⇒ 三个键整体上移
    // （trace.statusDone 123→101、state.loading 60→50、gate.pending 244→216）。
    // cycle-80（WS-2）：org.* 新增 14 个构建/重载键（在 gate 段之前）⇒ gate.pending 216→228。
    // cycle-96：`diag.controlBand*` 3 键 + `diag.controlBandStatus.*` 3 键 + `flows.macroPhase*`
    // 7 键（均在 gate 段之前）⇒ gate.pending 228→242。前两个 pin 在 org 段之前，故不受影响。
    // cycle-108：`org.cycleDrift*` 8 键（org 段内，位于 gate 段之前）⇒ 242→251→259。
    // 钉的仍是**磁盘真值**（精度未放宽）：
    // locale 在当前键之前增删键时，本行必须同步（这也是本契约唯一的维护负担）。
    expect(lineOfKey(INDEX, 'trace.statusDone')).toBe(101);
    expect(lineOfKey(INDEX, 'state.loading')).toBe(50);
    expect(lineOfKey(INDEX, 'gate.pending')).toBe(259); // cycle-108：org.cycleDrift.* 8 键在前，242→251→259
    // 且 keyAnchor 的对外形态与索引同源
    expect(keyAnchor(RAW, 'trace.statusDone')).toBe('locale/zh.json:101');
  });

  it('⑤ 未定位语义：不存在的键 → locale/zh.json:0（显式，不猜行号）', () => {
    expect(lineOfKey(INDEX, 'no.such.key')).toBe(0);
    expect(keyAnchor(RAW, 'no.such.key')).toBe('locale/zh.json:0');
  });

  it('⑥ 反向自检：键在文本里移动后锚点必须跟随（证明是真定位而非碰巧）', () => {
    const sample = '{\n  "a": {\n    "x": "1"\n  },\n  "b": {\n    "y": "2"\n  }\n}\n';
    const idx = buildKeyLineIndex(sample);
    expect(lineOfKey(idx, 'a.x')).toBe(3);
    expect(lineOfKey(idx, 'b.y')).toBe(6);
    // 把 a.x 整块移到 b 之后 ⇒ 行号必须变（固定行号/叶子名匹配都会失效）
    const moved = '{\n  "b": {\n    "y": "2"\n  },\n  "a": {\n    "x": "1"\n  }\n}\n';
    const idx2 = buildKeyLineIndex(moved);
    expect(lineOfKey(idx2, 'a.x')).toBe(6);
    expect(lineOfKey(idx2, 'b.y')).toBe(3);
    // 两态可分：同一键在两个文本里行号不同，证明判据不是恒真
    expect(lineOfKey(idx, 'a.x')).not.toBe(lineOfKey(idx2, 'a.x'));
  });
});
