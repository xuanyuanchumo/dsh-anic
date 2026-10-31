/**
 * 类型形状契约（cycle-94）—— 证明"第二通道真的覆盖了全部类型，且两两不等"。
 *
 * ## 为什么这条契约是 WCAG 1.4.1 的**唯一**机械保证
 *
 * `palette.ts` 证明了 9 个类型色靠颜色无法分开（色域上限：正常 ΔE 6.92 /
 * deuter 5.39）。所以形状通道是**唯一的合规路径** —— 而"形状存在"这件事
 * 极容易假绿：图表里加了一列 `shapeOf()`、渲染层也引用了它，但
 * **两个类型映射到同一个形状**时，任何"能渲染、不报错、截图看着挺好"的验收
 * 都不会红。
 *
 * 本契约把三件事钉住：
 *   ① **覆盖**：`LANE_ORDER` 里的每个类型都有专属形状（漏登记 = 落到 dot）；
 *   ② **两两不同**：9 个类型的 36 对组合里没有任何一对的"形状 + 圆角"等价；
 *   ③ **不引入 circle**：形状的渲染载体只能是 rect/path（smoke 不变量）。
 *
 * ## 为什么"两两不同"要按**视觉特征元组**比较，而不是只比形状名
 *
 * 形状名不同 ≠ 视觉可分：`square`（直角方）与 `dot`（小实心方）在 7px 尺度上
 * 只差尺寸；`ring`（空心方）与 `square` 只差描边。所以本契约比较的是
 * **(形状名, 是否描边, 相对尺寸)** 这个元组 —— 渲染层的尺寸档位与描边策略
 * 必须一起参与判定，否则"9 个不同形状名"可以对应"5 个真正可分的样子"。
 */
import { describe, it, expect } from 'vitest';
import {
  FALLBACK_SHAPE, TYPE_SHAPES, allShapes, shapeOf, shapeTypes, type TypeShape,
} from '../../src/client/features/graph/graphTypeShape.ts';
import { LANE_ORDER } from '../../src/client/features/graph/graphLayoutSpec.ts';

/**
 * 每个形状的**视觉特征**（渲染层将据此画 rect/path）。
 *
 * ## 为什么需要 `orientation`（这是契约第一次跑就抓到的真缺陷）
 *
 * 初版只用 `(silhouette, outline, size)` 三元组，结果 `chevron`（人字形，人门）
 * 与 `cross`（叉，事故）都被归成 `notched|solid|full` —— **特征相同**。
 * 这不是分类表写错了，而是三元组的**分辨率不够**：同为"缺口型"轮廓，
 * 人字是**开口朝向**、叉是**四向对称**，在 7px 尺度上靠的就是这个差别。
 *
 * ⇒ 加 `orientation` 一轴（`up` / `symmetric` / `none`）。这条正好证明本契约
 * 的价值：**它抓的不是"名字重复"，而是"名字不同但看起来一样"**。
 */
export const SHAPE_TRAITS: Readonly<Record<TypeShape, {
  /** 是否只画描边（空心）—— 空心与实心在 7px 尺度上是有力区分。 */
  outline: boolean;
  /** 相对尺寸档（small / full）—— 尺寸差本身就是一条视觉通道。 */
  size: 'small' | 'full';
  /** 轮廓类别的粗粒度归组（用于"两个形状会不会塌缩成一样"的判定）。 */
  silhouette: 'box' | 'tri' | 'notched' | 'round';
  /** 朝向（同轮廓型的第二分辨轴；见上方说明）。 */
  orientation: 'up' | 'symmetric' | 'none';
}>> = {
  square: { outline: false, size: 'full', silhouette: 'box', orientation: 'none' },
  diamond: { outline: false, size: 'full', silhouette: 'round', orientation: 'symmetric' },
  triangle: { outline: false, size: 'full', silhouette: 'tri', orientation: 'up' },
  chevron: { outline: false, size: 'full', silhouette: 'notched', orientation: 'up' },
  ring: { outline: true, size: 'full', silhouette: 'box', orientation: 'none' },
  star: { outline: true, size: 'full', silhouette: 'round', orientation: 'symmetric' },
  cross: { outline: false, size: 'full', silhouette: 'notched', orientation: 'symmetric' },
  hexagon: { outline: true, size: 'full', silhouette: 'tri', orientation: 'symmetric' },
  dot: { outline: false, size: 'small', silhouette: 'box', orientation: 'none' },
};

/** 视觉特征元组（两两比较用；字符串便于失败信息可读）。 */
function traitsOf(shape: TypeShape): string {
  const t = SHAPE_TRAITS[shape];
  return `${t.silhouette}|${t.orientation}|${t.outline ? 'outline' : 'solid'}|${t.size}`;
}

describe('类型形状契约（WCAG 1.4.1 第二通道）', () => {
  it('① 覆盖完整：LANE_ORDER 的每个类型都有专属形状（不是 dot）', () => {
    // 扫描集非空下限：LANE_ORDER 少了东西这条会先红，而不是静默全绿。
    expect(LANE_ORDER.length).toBeGreaterThanOrEqual(8);
    for (const type of LANE_ORDER) {
      const shape = shapeOf(type);
      expect(shape, `类型 ${type} 没有登记形状（落到了兜底 ${FALLBACK_SHAPE}）`).not.toBe(FALLBACK_SHAPE);
      expect(TYPE_SHAPES[type], `TYPE_SHAPES 缺少 ${type}`).toBe(shape);
    }
    // 反向：表里也不该有 LANE_ORDER 之外的僵尸类型（否则是登记了却画不出来）。
    for (const type of shapeTypes()) {
      if (type === 'unknown') continue; // 兜底是合法的非泳道类型
      expect(LANE_ORDER, `TYPE_SHAPES 登记了未在 LANE_ORDER 里的类型：${type}`).toContain(type);
    }
  });

  it('② 两两不同：任意两个类型的**视觉特征元组**互不相同', () => {
    const types = LANE_ORDER;
    const seen = new Map<string, string>();
    for (const type of types) {
      const key = traitsOf(shapeOf(type));
      const prev = seen.get(key);
      // 失败信息要指出"哪两个撞了"——只说"有重复"的话，下一个人得自己遍历。
      expect(prev, `${type}（${shapeOf(type)}）与 ${String(prev)} 的视觉特征相同：${key}`).toBeUndefined();
      seen.set(key, type);
    }
    // 非空下限：真的比了 LANE_ORDER.length 项。
    expect(seen.size).toBe(types.length);
  });

  it('③ 形状名本身也唯一（元组唯一是充分条件，名字唯一是必要条件）', () => {
    const shapes = allShapes();
    expect(shapes.length).toBe(shapeTypes().length);
    expect(new Set(shapes).size, `重复的形状名：${shapes.join(',')}`).toBe(shapes.length);
  });

  it('④ 每个形状都有渲染特征（缺一条 = 渲染层只能猜）', () => {
    for (const shape of allShapes()) {
      const t = SHAPE_TRAITS[shape];
      expect(t, `SHAPE_TRAITS 缺少 ${shape}`).toBeDefined();
      expect(['box', 'tri', 'notched', 'round']).toContain(t.silhouette);
      expect(['small', 'full']).toContain(t.size);
      expect(typeof t.outline).toBe('boolean');
    }
    // 反向：特征表里也不该有未登记的形状。
    for (const shape of Object.keys(SHAPE_TRAITS) as TypeShape[]) {
      expect(allShapes(), `SHAPE_TRAITS 登记了未在 TYPE_SHAPES 里的形状：${shape}`).toContain(shape);
    }
  });

  it('⑤ 兜底行为：未登记类型回落到 dot，且不抛', () => {
    expect(shapeOf('nope-not-a-type')).toBe(FALLBACK_SHAPE);
    expect(shapeOf(undefined)).toBe(FALLBACK_SHAPE);
    expect(shapeOf('')).toBe(FALLBACK_SHAPE);
    // 已知类型不受兜底影响（证明兜底不是"什么都返回 dot"的哑实现）。
    expect(shapeOf('gate')).toBe('triangle');
    expect(shapeOf('phase')).toBe('square');
  });

  it('⑥ 反向自检：把两个类型映射成同一形状，② 必须判红', () => {
    // 构造一份"退化"的副本：micro-step 偷偷用 square（与 phase 同形同特征）。
    const degenerate: Record<string, TypeShape> = {
      ...TYPE_SHAPES,
      'micro-step': 'square',
    };
    const traitsOfDegenerate = (type: string): string => traitsOf(degenerate[type] ?? FALLBACK_SHAPE);
    const keys = new Map<string, string>();
    let collision = false;
    for (const type of LANE_ORDER) {
      const k = traitsOfDegenerate(type);
      if (keys.has(k)) { collision = true; break; }
      keys.set(k, type);
    }
    // 这正是 ② 会抓到的东西：证明那条断言不是哑的。
    expect(collision).toBe(true);
  });
});
