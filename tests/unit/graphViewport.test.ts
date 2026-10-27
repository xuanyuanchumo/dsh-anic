/**
 * 视口原语单测（cycle-82 · G 战线）——缩放锚点 / 边界钳制 / 适配视图。
 *
 * ## 为什么这些数字必须被断言，而不能"看起来对"
 *
 * 视口是**手感**的来源，而手感缺陷没有任何可见症状：组件照常渲染、`scale` 照常变大、
 * 拖拽照常触发。三种真实缺陷都只在"用起来不对"里体现：
 *
 * 1. **锚点漂移**：滚轮缩放若按中心或按 `t` 不变算，用户盯着的那一点会跑出屏幕。
 *    这里用「缩放前后 anchor 处世界坐标不变」这一条**可算的等式**钉死它。
 * 2. **缩放无界**：能滚到 0.0001 倍，整图塌成一个点，"放大"按钮自己也点不中。
 * 3. **平移死锁**：图被拖出视口后**没有任何手势能拖回来**——这是地图类控件最常见的
 *    事故形态，且用户已经不知道该往哪拖。`clampPan` 的「至少留 margin 像素可见」正是为此。
 *
 * 每条断言都配一个反向自检：篡改副本（错误的公式）必须被判红，
 * 否则"公式写错了守卫仍绿"就是永久假绿。
 */
import { describe, it, expect } from 'vitest';
import {
  IDENTITY,
  SCALE_MAX,
  SCALE_MIN,
  ZOOM_STEP,
  centerOf,
  clampPan,
  clampScale,
  fitToView,
  panBy,
  scalePercent,
  toScreen,
  toWorld,
  transformOf,
  zoomAt,
  zoomBy,
  type Rect,
  type Size,
  type Viewport,
} from '../../src/client/features/graph/graphViewport.ts';
import { layoutGraph, type GraphBounds } from '../../src/client/features/graph/graphLayout.ts';
import { WORKFLOW_SNAPSHOT } from '../../src/client/workflowGraphData.ts';

const SIZE: Size = { width: 900, height: 560 };
/** 真实布局的包围盒（不是手编的数字：适配视图要对着真实规模断言）。 */
const BOUNDS: GraphBounds = layoutGraph(WORKFLOW_SNAPSHOT.nodes, WORKFLOW_SNAPSHOT.edges).bounds;

/** 世界点经视口往返（缩放 + 平移再反解）必须回到原处。 */
const roundTrip = (v: Viewport, p: { x: number; y: number }) => toWorld(v, toScreen(v, p));

describe('clampScale：上下限', () => {
  it('区间内原样返回', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(SCALE_MIN)).toBe(SCALE_MIN);
    expect(clampScale(SCALE_MAX)).toBe(SCALE_MAX);
  });

  it('越界夹到边界（挡"缩到 0.0001 倍、整图塌成一点"）', () => {
    expect(clampScale(0)).toBe(SCALE_MIN);
    expect(clampScale(0.0001)).toBe(SCALE_MIN);
    expect(clampScale(99)).toBe(SCALE_MAX);
    expect(clampScale(-3)).toBe(SCALE_MIN);
  });

  it('非有限值回落到 1（NaN scale 会让整张 SVG 消失，而不是报错）', () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampScale(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('反向自检：若钳制被去掉，越界值必须能穿过去', () => {
    const unclamped = (v: number): number => v; // 篡改副本
    expect(unclamped(99)).toBe(99);
    expect(clampScale(99)).not.toBe(unclamped(99));
  });
});

describe('zoomAt：以指针为锚点', () => {
  const base: Viewport = { scale: 1, tx: 40, ty: -20 };
  const anchor = { x: 300, y: 200 };

  it('缩放前后 anchor 处的世界坐标不变（这就是"指针下的点不动"）', () => {
    for (const next of [0.5, 1.3, 2, SCALE_MIN, SCALE_MAX]) {
      const after = zoomAt(base, anchor, next);
      const w0 = toWorld(base, anchor);
      const w1 = toWorld(after, anchor);
      // 浮点误差容忍 1e-9 相对量级；超过就是公式错了，不是精度问题。
      expect(Math.abs(w1.x - w0.x)).toBeLessThan(1e-9);
      expect(Math.abs(w1.y - w0.y)).toBeLessThan(1e-9);
    }
  });

  it('目标比例被钳制后锚点仍不动（钳制与锚点是两件事，不能互相破坏）', () => {
    const after = zoomAt(base, anchor, 99);
    expect(after.scale).toBe(SCALE_MAX);
    const w0 = toWorld(base, anchor);
    const w1 = toWorld(after, anchor);
    expect(Math.abs(w1.x - w0.x)).toBeLessThan(1e-9);
    expect(Math.abs(w1.y - w0.y)).toBeLessThan(1e-9);
  });

  it('非有限锚点不产生 NaN 视口（拖拽事件缺字段时不能毒化整张图）', () => {
    const after = zoomAt(base, { x: Number.NaN, y: 0 }, 2);
    expect(Number.isFinite(after.tx)).toBe(true);
    expect(Number.isFinite(after.ty)).toBe(true);
    expect(Number.isFinite(after.scale)).toBe(true);
  });

  it('反向自检：按"只改 scale、不动平移"的错公式算，锚点必然漂移', () => {
    const naive = (v: Viewport, s: number): Viewport => ({ ...v, scale: s });
    const w0 = toWorld(base, anchor);
    const w1 = toWorld(naive(base, 2), anchor);
    expect(Math.abs(w1.x - w0.x)).toBeGreaterThan(1);
  });

  it('zoomBy 与 zoomAt(scale * factor) 等价，且上下界处幂等', () => {
    const byFactor = zoomBy(base, anchor, ZOOM_STEP);
    const byScale = zoomAt(base, anchor, base.scale * ZOOM_STEP);
    expect(byFactor.scale).toBeCloseTo(byScale.scale, 12);
    expect(byFactor.tx).toBeCloseTo(byScale.tx, 12);
    // 已在上界时再放大 → scale 不动（但锚点仍守恒，见上一条）
    const atMax: Viewport = { scale: SCALE_MAX, tx: 0, ty: 0 };
    expect(zoomBy(atMax, anchor, ZOOM_STEP).scale).toBe(SCALE_MAX);
  });
});

describe('panBy / toScreen / toWorld', () => {
  it('平移只改偏移，不改比例', () => {
    const after = panBy(IDENTITY, 30, -12);
    expect(after).toEqual({ scale: 1, tx: 30, ty: -12 });
  });

  it('屏幕 ↔ 世界往返一致（0.25 ~ 4 每档都测）', () => {
    for (const scale of [SCALE_MIN, 0.5, 1, 2.5, SCALE_MAX]) {
      const v: Viewport = { scale, tx: 17, ty: -33 };
      const p = { x: 123.5, y: 456.25 };
      const back = roundTrip(v, p);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('非有限增量不污染视口', () => {
    const after = panBy(IDENTITY, Number.NaN, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(after.tx)).toBe(true);
    expect(Number.isFinite(after.ty)).toBe(true);
  });
});

describe('clampPan：平移边界（挡"拖出屏幕再也拖不回来"的死锁）', () => {
  const size: Size = { width: 900, height: 560 };
  const small: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 };
  const big: Rect = { minX: 0, minY: 0, maxX: 4000, maxY: 3000, width: 4000, height: 3000 };

  it('内容比视口小 → 居中（拖出空白没有意义，另一侧的空白也拖不回来）', () => {
    const out = clampPan({ scale: 1, tx: 9999, ty: -9999 }, size, small);
    // 居中：tx = (900-100)/2 = 400；ty = (560-100)/2 = 230
    expect(out.tx).toBeCloseTo(400, 9);
    expect(out.ty).toBeCloseTo(230, 9);
  });

  it('内容比视口大 → 拖再远也至少留 margin 像素可见', () => {
    const margin = 48;
    for (const [tx, ty] of [[-1e6, 0], [1e6, 0], [0, -1e6], [0, 1e6]]) {
      const out = clampPan({ scale: 1, tx, ty }, size, big, margin);
      // 内容左缘 = minX*scale + tx；内容右缘 = 左缘 + width*scale
      const left = big.minX * out.scale + out.tx;
      const right = left + big.width * out.scale;
      const top = big.minY * out.scale + out.ty;
      const bottom = top + big.height * out.scale;
      expect(left, '整图被拖到视口右侧之外').toBeLessThanOrEqual(size.width - margin + 1e-9);
      expect(right, '整图被拖到视口左侧之外').toBeGreaterThanOrEqual(margin - 1e-9);
      expect(top, '整图被拖到视口下方之外').toBeLessThanOrEqual(size.height - margin + 1e-9);
      expect(bottom, '整图被拖到视口上方之外').toBeGreaterThanOrEqual(margin - 1e-9);
    }
  });

  it('范围内的偏移原样保留（钳制不能把正常拖拽也吃掉）', () => {
    const v: Viewport = { scale: 0.5, tx: -400, ty: -300 };
    const out = clampPan(v, size, big);
    expect(out.tx).toBeCloseTo(v.tx, 9);
    expect(out.ty).toBeCloseTo(v.ty, 9);
  });

  it('幂等：钳制两次与一次结果相同（否则拖拽会持续漂移）', () => {
    const once = clampPan({ scale: 1, tx: -99999, ty: -99999 }, size, big);
    const twice = clampPan(once, size, big);
    expect(twice.tx).toBeCloseTo(once.tx, 12);
    expect(twice.ty).toBeCloseTo(once.ty, 12);
  });

  it('零尺寸视口不产生 NaN', () => {
    const out = clampPan({ scale: 1, tx: 0, ty: 0 }, { width: 0, height: 0 }, big);
    expect(Number.isFinite(out.tx)).toBe(true);
    expect(Number.isFinite(out.ty)).toBe(true);
  });

  it('反向自检：去掉钳制（直接透传）就会突破 margin 约束', () => {
    const naive = (v: Viewport): Viewport => v;
    const out = naive({ scale: 1, tx: -1e6, ty: 0 });
    const right = big.minX * out.scale + out.tx + big.width * out.scale;
    expect(right).toBeLessThan(0); // 整图早已被拖到左边外 → 死锁
  });
});

describe('fitToView：适配视图', () => {
  it('真实布局适配后完整落在视口内（留 padding）', () => {
    const v = fitToView(BOUNDS, SIZE, 16);
    const tl = toScreen(v, { x: BOUNDS.minX, y: BOUNDS.minY });
    const br = toScreen(v, { x: BOUNDS.maxX, y: BOUNDS.maxY });
    expect(tl.x).toBeGreaterThanOrEqual(16 - 1e-6);
    expect(tl.y).toBeGreaterThanOrEqual(16 - 1e-6);
    expect(br.x).toBeLessThanOrEqual(SIZE.width - 16 + 1e-6);
    expect(br.y).toBeLessThanOrEqual(SIZE.height - 16 + 1e-6);
  });

  it('适配结果居中（左右留白差 ≤ 1px，上下同）', () => {
    const v = fitToView(BOUNDS, SIZE, 16);
    const tl = toScreen(v, { x: BOUNDS.minX, y: BOUNDS.minY });
    const br = toScreen(v, { x: BOUNDS.maxX, y: BOUNDS.maxY });
    expect(Math.abs(tl.x - (SIZE.width - br.x))).toBeLessThan(1);
    expect(Math.abs(tl.y - (SIZE.height - br.y))).toBeLessThan(1);
  });

  it('比例被钳制在 [0.25, 4]（3 个节点时不许放大到糊）', () => {
    const tiny: Rect = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 };
    const v = fitToView(tiny, SIZE);
    expect(v.scale).toBeLessThanOrEqual(SCALE_MAX);
    expect(v.scale).toBeGreaterThanOrEqual(SCALE_MIN);
    const huge: Rect = { minX: 0, minY: 0, maxX: 1e7, maxY: 1e7, width: 1e7, height: 1e7 };
    expect(fitToView(huge, SIZE).scale).toBe(SCALE_MIN);
  });

  it('零尺寸包围盒不产生 NaN / Infinity', () => {
    const zero: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    const v = fitToView(zero, SIZE);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(Number.isFinite(v.tx)).toBe(true);
    expect(Number.isFinite(v.ty)).toBe(true);
  });

  it('适配后即可完整阅读（这条是用户目的：任何时刻都能一键回到"看得全"）', () => {
    // 从任意"迷失态"出发，适配一次就回到全图可见 —— 挡的是"缩到 0.25 后
    // 用户再也找不到图"这类死锁。
    const lost: Viewport = { scale: 4, tx: -99999, ty: -99999 };
    const recovered = fitToView(BOUNDS, SIZE, 16);
    expect(recovered.scale).not.toBe(lost.scale);
    const br = toScreen(recovered, { x: BOUNDS.maxX, y: BOUNDS.maxY });
    expect(br.x).toBeLessThanOrEqual(SIZE.width);
    expect(br.y).toBeLessThanOrEqual(SIZE.height);
  });
});

describe('transformOf / scalePercent / centerOf', () => {
  it('变换串顺序是 translate 再 scale（反了会让拖拽速度随缩放变化）', () => {
    expect(transformOf({ scale: 2, tx: 10, ty: 20 })).toBe('translate(10,20) scale(2)');
  });

  it('数值保留 4 位小数（17 位浮点会让每次重渲的 attribute 都不同，diff 永不命中）', () => {
    const s = transformOf({ scale: 1 / 3, tx: 1 / 7, ty: 2 / 3 });
    expect(s).toBe('translate(0.1429,0.6667) scale(0.3333)');
    expect(s.length).toBeLessThan(60);
  });

  it('非有限值被规范化（不出 NaN 字面量）', () => {
    expect(transformOf({ scale: Number.NaN, tx: Number.NaN, ty: 0 })).toBe('translate(0,0) scale(1)');
  });

  it('比例读数是整数百分比（99.9999% 是噪声）', () => {
    expect(scalePercent({ scale: 1, tx: 0, ty: 0 })).toBe(100);
    expect(scalePercent({ scale: SCALE_MIN, tx: 0, ty: 0 })).toBe(25);
    expect(scalePercent({ scale: 1 / 3, tx: 0, ty: 0 })).toBe(33);
  });

  it('centerOf 取视口中心（按钮缩放以此为锚 —— 注意力在画面中央）', () => {
    expect(centerOf({ width: 900, height: 560 })).toEqual({ x: 450, y: 280 });
    expect(centerOf({ width: Number.NaN, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});
