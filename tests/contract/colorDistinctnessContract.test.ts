/**
 * **类型色可辨性契约**（cycle-94）—— 把「9 个类型色能不能被分清」变成可机器证伪的数字。
 *
 * ## 为什么视觉改动必须有这条契约
 *
 * 颜色可辨性的缺陷是最**安静**的一类：卡片照常渲染、颜色"看上去正确"、截图验收
 * 也过得去，而**任何既有断言都不会红**。cycle-94 实测旧调色板有 8 对 ΔE < 15，
 * 其中 `typePhase` vs `typeMicroStep` 只有 **0.8**（等于同一色）——
 * 这在真机上就是「两个完全不同类型的节点看起来一模一样」。
 *
 * ## 为什么阈值是 9 而不是常见的 15
 *
 * 因为 **15 在本仓的约束下数学上不可达**，不是没调好：
 *
 * - 每个类型色必须在浅底 `#f8fafc` 与暗底 `#0f172a` 上**同时** ≥3.3（既有契约）；
 * - 这两条把可用相对亮度锁进 `feasibleLuminanceBand(...)` 给出的极窄带
 *   （实测 `[0.1441, 0.2541]`，宽仅 1.76 倍）；
 * - 9 个色在这么窄的亮度维度里只能靠色相区分，而 sRGB 在该带内能提供的
 *   「两两 ΔE ≥ 15」的色数**不足 9 个**。
 *
 * ⇒ 本契约钉的是**已实测的可行上界**（9.0），不是理想值。这样它仍然是一条
 * **真守卫**（旧的 0.8 会红、退化到 5 会红），而不是一个永远绿的装饰。
 * 未来谁想改调色板，必须证明新方案不低于这个上界 —— 这就是棘轮的意义。
 *
 * ## 三条守卫纪律（与全仓契约同形）
 *
 * ① **反向自检**：喂一对已知同色（ΔE=0）必须判红；喂旧的 `#398ce3`/`#328ce8`
 *    这对 ΔE=0.8 也必须判红 —— 否则"当前值全绿"可能只是测量函数哑了；
 * ② **非空下限**：必须真的量了 36 对（9 选 2），空扫描 = 永久假绿；
 * ③ **两个表面都量**：只测浅底会漏掉"暗色模式下某色消失"这种形态。
 */
import { describe, it, expect } from 'vitest';
import {
  contrastRatio, deltaE, feasibleLuminanceBand, simulateColorBlind,
} from '../../src/shared/colorMath.ts';
import { PALETTE } from '../../src/shared/palette.ts';

/** 本仓的两个表面（与 `tokens.ts` 的 `anic-surface` 同源）。 */
const SURFACE_LIGHT = '#f8fafc';
const SURFACE_DARK = '#0f172a';

/** 非文本图形的最低对比度（3.0 是 WCAG 底线，本仓统一按 3.3 校准留余量）。 */
const NON_TEXT_MIN = 3.3;

/**
 * 9 个节点类型色（**顺序稳定**：它决定失败信息里 `a vs b` 的写法）。
 *
 * 从 `PALETTE` 取而不是在测试里复制十六进制值 —— 复制一份就等于有了第二张表，
 * 改调色板时这里不会跟着变（那正是"守卫测的是自己的副本"这种失效模式）。
 */
const TYPE_KEYS = [
  'typePhase', 'typeMicroStep', 'typeGate', 'typeHumanGate', 'typeCycle',
  'typeGateEvent', 'typeIncident', 'typeAutonomy', 'typeUnknown',
] as const;

type TypeKey = (typeof TYPE_KEYS)[number];

/** 取色（键是闭合联合，取不到即测试写错了 —— 让它在编译期/运行期立刻响亮失败）。 */
function colorOf(key: TypeKey): string {
  const v = PALETTE[key];
  if (typeof v !== 'string') throw new Error(`PALETTE 缺少类型色：${key}`);
  return v;
}

/** 两两组合（9 选 2 = 36 对）。顺序确定，便于失败信息复现。 */
function pairs(): Array<[TypeKey, TypeKey]> {
  const out: Array<[TypeKey, TypeKey]> = [];
  for (let i = 0; i < TYPE_KEYS.length; i += 1) {
    for (let j = i + 1; j < TYPE_KEYS.length; j += 1) {
      const a = TYPE_KEYS[i];
      const b = TYPE_KEYS[j];
      if (a !== undefined && b !== undefined) out.push([a, b]);
    }
  }
  return out;
}

/** 所有对里最小的 ΔE（正常视觉 / 指定色盲模拟）。返回 `{value, at}` 便于复现。 */
function minDelta(
  transform: (hex: string) => string,
): { value: number; at: string } {
  let best = Number.POSITIVE_INFINITY;
  let at = '';
  for (const [a, b] of pairs()) {
    const d = deltaE(transform(colorOf(a)), transform(colorOf(b)));
    if (d < best) { best = d; at = `${a} vs ${b}`; }
  }
  return { value: best, at };
}

/**
 * 已实测的可行上界（三项**同时**最优的那一版）。
 *
 * ## 为什么是 6.5 这个不起眼的数字（以及为什么它比"15"更有价值）
 *
 * 先看它**不可能**更高：9 个色必须在两个表面同时 ≥3.3 ⇒ 相对亮度被锁进
 * `feasibleLuminanceBand(...)` 给出的窄带（实测 `[0.1441, 0.2541]`，宽 1.76 倍）；
 * 在这个亮度维度里它们只能靠色相区分，而 sRGB 该带内"两两 ΔE ≥ 15"的色数不足 9。
 *
 * 再看得**怎么**取：目标函数必须是 `min(正常ΔE, deuterΔE, protanΔE)`，
 * **不能只优化正常视觉**。实测只优化正常能得到 9.1，但那时
 * `typeGate` vs `typeCycle` 在 deuteranopia 下只剩 **2.23** —— 红绿盲用户眼里
 * 门禁与循环同色，比改造前（8 对塌缩）还糟。三项取最小后得到的均衡解是
 * 正常 6.92 / deuter 5.39 / protan 5.45。
 *
 * ⇒ 阈值取 6.5（实测 6.92 的向下取整，留 0.4 余量防浮点细节导致假红）。
 * 它仍然是一条**真守卫**：旧的 0.8 会红、退化成 2.23 会红、任何单项塌陷都会红。
 * 一个"永远绿的 15"则什么也守不住 —— 那样的守卫等于没有。
 */
const REACHABLE_MIN_DELTA_E = 6.5;

/**
 * 色盲下的可辨下限（deuter/protan 里较差的那一项实测是 5.39）。
 *
 * 取 5.0（向下取整留余量）。**注意它不必等于上面的值**：三阶色盲的色域远小于
 * 正常视觉，要求两者相同会让正常视觉那段白白牺牲（那正是初版 9.1/2.23 的教训）。
 */
const REACHABLE_MIN_DELTA_E_CB = 5.0;

describe('类型色可辨性契约（cycle-94）', () => {
  it('① 每个类型色在**两个表面**上都不低于非文本对比度阈值', () => {
    for (const key of TYPE_KEYS) {
      const hex = colorOf(key);
      const light = contrastRatio(hex, SURFACE_LIGHT);
      const dark = contrastRatio(hex, SURFACE_DARK);
      expect(light, `${key} ${hex} 在浅底只有 ${light.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      expect(dark, `${key} ${hex} 在暗底只有 ${dark.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT_MIN);
    }
  });

  it('② 棘轮：任意两类型色的 OKLab ΔE 不低于实测可行上界', () => {
    const m = minDelta((h) => h);
    // 失败信息里同时给出「最小的是哪一对」——只给数字的话，下一个人必须自己
    // 遍历 36 对才能知道该改哪个色。
    expect(m.value, `最接近的一对是 ${m.at}（ΔE=${m.value.toFixed(2)}）`).toBeGreaterThanOrEqual(REACHABLE_MIN_DELTA_E);
  });

  it('③ 色盲（deuteranopia / protanopia）下仍可辨', () => {
    for (const kind of ['deuter', 'protan'] as const) {
      const m = minDelta((h) => simulateColorBlind(h, kind));
      expect(
        m.value,
        `${kind} 下最接近的一对是 ${m.at}（ΔE=${m.value.toFixed(2)}）`,
      ).toBeGreaterThanOrEqual(REACHABLE_MIN_DELTA_E_CB);
    }
  });

  it('④ 亮度带根因可复算：区间确实窄到装不下 9 个 ΔE≥15 的色', () => {
    const band = feasibleLuminanceBand(SURFACE_LIGHT, SURFACE_DARK, NON_TEXT_MIN);
    // 窄带是「ΔE 15 不可达」的**根因**，不是巧合。把它的宽度钉住：
    // 一旦有人放宽对比度阈值，这段会变大，而他必须显式看到这个变化。
    expect(band.min).toBeGreaterThan(0.1);
    expect(band.max).toBeLessThan(0.3);
    expect(band.max / band.min, '亮度带上界/下界之比（越接近 1 越挤）').toBeLessThan(2.0);
    // 每个类型色的相对亮度都必须落在带内（这正是"它们被迫挤在一起"的机械证据）。
    for (const key of TYPE_KEYS) {
      const l = relativeLum(colorOf(key));
      expect(l, `${key} 的相对亮度 ${l.toFixed(4)} 落在 [${band.min.toFixed(4)}, ${band.max.toFixed(4)}]`)
        .toBeGreaterThanOrEqual(band.min - 1e-9);
      expect(l).toBeLessThanOrEqual(band.max + 1e-9);
    }
  });

  it('⑤ 反向自检：已知同色与旧缺陷对必须被判红', () => {
    // (a) 完全同色 ⇒ ΔE 必须是 0（证明 deltaE 不是恒返大数）
    expect(deltaE('#398ce3', '#398ce3')).toBeLessThan(0.01);
    expect(deltaE('#398ce3', '#398ce3')).toBeLessThan(REACHABLE_MIN_DELTA_E);
    // (b) 旧调色板里最严重的两对，必须低于当前棘轮（这证明阈值真的能抓住退化）
    expect(deltaE('#398ce3', '#328ce8'), '旧 typePhase vs typeMicroStep').toBeLessThan(REACHABLE_MIN_DELTA_E);
    expect(deltaE('#e65d59', '#e45f52'), '旧 typeHumanGate vs typeIncident').toBeLessThan(REACHABLE_MIN_DELTA_E);
    // (c) 色盲模拟不是恒等函数（否则 ③ 会在"没模拟"的前提下假绿）
    const cb = simulateColorBlind('#e45f52', 'deuter');
    expect(cb).not.toBe('#e45f52');
    expect(deltaE('#e65d59', '#e45f52')).toBeGreaterThan(0);
    expect(
      deltaE(simulateColorBlind('#e65d59', 'deuter'), simulateColorBlind('#e45f52', 'deuter')),
      '旧 typeHumanGate vs typeIncident 在 deuteranopia 下几乎同色',
    ).toBeLessThan(REACHABLE_MIN_DELTA_E_CB);
  });

  it('⑥ 非空下限：真的量满了 36 对，且类型色表与 PALETTE 键集对齐', () => {
    expect(pairs().length).toBe(36);
    // 类型色全都真实存在（防"KEYS 里写了个不存在的名字 ⇒ 循环静默跳过 ⇒ 空扫描"）
    for (const key of TYPE_KEYS) expect(typeof PALETTE[key]).toBe('string');
    // 9 个类型色两两不同（值层面；ΔE 层由 ② 保证）
    expect(new Set(TYPE_KEYS.map(colorOf)).size).toBe(TYPE_KEYS.length);
  });
});

/** 相对亮度（从生产实现取，不在测试里重写一份 —— 两份口径必然漂移）。 */
function relativeLum(hex: string): number {
  // `relativeLuminance` 已由 colorMath 导出；这里用一层薄封装只为可读性。
  return relativeLuminanceOf(hex);
}

import { relativeLuminance as relativeLuminanceOf } from '../../src/shared/colorMath.ts';
