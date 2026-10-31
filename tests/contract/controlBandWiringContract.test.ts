/**
 * 控制带链路契约（cycle-96）—— 守卫「生产 ↔ 消费」之间的接线，而不只是两侧存在。
 *
 * ## 被守卫的缺陷（本轮实测）
 *
 * 这条链路上三个环节**各自完备、中间断开**：
 *   - 生产者：`band-detector.mjs` 算得出 Mean / StdDev / 1σ..3σ（技能侧）；
 *   - 算法域：`bandDetector.bandStats` 算得出均值与标准差；
 *   - 消费者：客户端 `gateColors.renderControlBand` 吃 `ControlBand`（mean/σ2/σ3/value/label）。
 *
 * 但 `BandResult` **从来没把统计量暴露出来** ⇒ 渲染器在等数据、数据在等出口。
 *
 * 本仓闭环体检的「注册↔生产↔消费」三态矩阵**抓不到这个形态**：它是资产级检查
 * （某工具/路由/词表键有没有人读），而这里两侧都"有人"，断的是**两者之间**那一跳。
 *
 * ## 判据为什么是「形状对齐」而不是「字段存在」
 *
 * 弱判据：`result.controlBand !== undefined` ⇒ 恒真（塞个空对象就过）。
 * 强判据：**生产者的输出形状与消费者要求的输入形状逐字段对得上**，且数值关系自洽
 * （σ2 = μ+2σ、σ3 = μ+3σ）。字段名对不上（例如生产者叫 `sigmaTwo`）在运行期
 * 不报错、只是渲染出 `NaN` —— 那是最难发现的一种坏。
 *
 * ## 判定必须与客户端同式（这是最易分叉的一处）
 *
 * 客户端 `bandStatus`：`|value − mean| > nσ` ⇒ **对称**。
 * 若宿主侧写成单向上界（`value > mean + nσ`），负向偏离就永远不会报警 ——
 * 而"分数突然变低"恰恰是最该报警的方向。所以本契约**同时**断言正负两侧。
 */
import { describe, it, expect } from 'vitest';
import { controlBandOf } from '../../src/host/evolution/controlBand.ts';
import { bandStats } from '../../src/host/evolution/bandStats.ts';

/** 消费者（客户端 `ControlBand`）要求的最小字段集（逐字取自 gateColors.ts）。 */
const CONSUMER_FIELDS = ['mean', 'sigma2', 'sigma3', 'value', 'label'] as const;

describe('cycle-96 控制带链路契约', () => {
  it('① 生产者输出含消费者要求的**全部**字段（形状对齐，而非"存在"）', () => {
    const band = controlBandOf([1, 1, 1, 1], 1);
    for (const f of CONSUMER_FIELDS) {
      expect(band, `生产者缺字段 ${f} ⇒ 客户端 renderControlBand 会渲染出 NaN/空白`)
        .toHaveProperty(f);
    }
    // 类型级：数值字段必须是 number（不是字符串化的数字）。
    expect(typeof band.mean).toBe('number');
    expect(typeof band.sigma2).toBe('number');
    expect(typeof band.sigma3).toBe('number');
    expect(typeof band.value).toBe('number');
    expect(typeof band.label).toBe('string');
  });

  it('② 数值关系自洽：σ2 = μ+2σ、σ3 = μ+3σ（边界是绝对值，不是 σ 本身）', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9]; // 教科书样本：μ=5, σ=2
    const s = bandStats(values);
    expect(s.mean).toBeCloseTo(5, 6);
    expect(s.stdDev).toBeCloseTo(2, 6);
    const band = controlBandOf(values, 5);
    expect(band.sigma2, 'σ2 必须是 μ+2σ 的绝对边界').toBeCloseTo(s.mean + 2 * s.stdDev, 6);
    expect(band.sigma3, 'σ3 必须是 μ+3σ 的绝对边界').toBeCloseTo(s.mean + 3 * s.stdDev, 6);
  });

  it('③ 判定与客户端同式：**正负两向**都按 |value−μ| 判，不得只判上界', () => {
    // 稳定过程：μ=10, σ≈1.414（[8,12] 两点）。
    const base = [8, 12];
    const s = bandStats(base);

    // 正向 2.5σ ⇒ warn（既未超 3σ，也超了 2σ）。
    const up = controlBandOf(base, s.mean + 2.5 * s.stdDev);
    expect(up.status, '正向 2.5σ 应判 warn').toBe('warn');

    // **负向** 2.5σ ⇒ 同样必须 warn。只写上界的实现会在这里判成 normal。
    const down = controlBandOf(base, s.mean - 2.5 * s.stdDev);
    expect(down.status, '负向 2.5σ 被判成 normal ⇒ 判定只写了上界，最大的风险方向静默了').toBe('warn');

    // 超 3σ 任一侧 ⇒ alarm。
    expect(controlBandOf(base, s.mean + 3.2 * s.stdDev).status).toBe('alarm');
    expect(controlBandOf(base, s.mean - 3.2 * s.stdDev).status).toBe('alarm');

    // 带内 ⇒ normal。
    expect(controlBandOf(base, s.mean).status).toBe('normal');
  });

  it('④ 样本不足必须如实上报（1 个点 σ=0 ⇒ 永远 normal，那是假绿）', () => {
    const one = controlBandOf([42], 42);
    // 判定确实是 normal（数学上没错：没有偏离），但 sampleSize 必须暴露"只有 1 点"。
    expect(one.status).toBe('normal');
    expect(one.sampleSize, 'sampleSize 未上报 ⇒ 调用方无法区分"很稳定"与"还没历史"').toBe(1);
    expect(one.stdDev).toBe(0);
  });

  it('⑤ 反向自检：把判定改成"只看上界"，③ 的负向断言必须能抓到', () => {
    const base = [8, 12];
    const s = bandStats(base);
    // 模拟错误实现：只有上界。
    const wrong = (value: number): string => {
      const dev = value - s.mean; // ← 少了 Math.abs
      return dev > 3 * s.stdDev ? 'alarm' : dev > 2 * s.stdDev ? 'warn' : 'normal';
    };
    expect(wrong(s.mean - 2.5 * s.stdDev), '错误实现（只判上界）会把负向偏离读成 normal').toBe('normal');
    expect(controlBandOf(base, s.mean - 2.5 * s.stdDev).status, '正确实现必须与错误实现结论不同')
      .toBe('warn');
  });
});
