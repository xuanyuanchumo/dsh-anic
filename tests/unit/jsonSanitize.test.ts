/**
 * `jsonSanitize` 单测（cycle-82 可观测性收口）。
 *
 * 守卫纪律（本仓通用）：
 *   ① **反向自检**：每条语义都要有「不修会怎样」的对照断言，不写恒真装饰；
 *   ② 快路径必须被证明：合法值走 `sanitizeForWire` 后**同一引用**返回（零成本）；
 *   ③ 上限是**断言**不是截断：超深/超大必须 throw（静默截断 = 无声数据丢失）。
 *
 * 缺陷史（真机实测）：`anic_status` 因 `ScriptHealth.recentSuccessRate` 为 undefined
 * 被判 `value is not lossless JSON`。本文件第 1 组断言就是这个形状。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SANITIZE_LIMITS,
  isLosslessJson,
  sanitizeForWire,
} from '../../src/host/runtime/jsonSanitize.ts';

/** 「往返无损」判据：值 → 文本 → 值，与自身深等（消费方真正能观察到的语义）。 */
function roundtrips(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value)) as unknown) === JSON.stringify(value);
}

describe('isLosslessJson：判定与 JSON.stringify 的静默行为**刻意**分叉', () => {
  it('undefined 属性值 ⇒ 非法（真机事故形态；stringify 会静默吞掉）', () => {
    const v = { script: 'eval-runner', recentSuccessRate: undefined };
    expect(isLosslessJson(v)).toBe(false);
    // 反向自检：证明本判定不是"逢对象即假"
    expect(isLosslessJson({ script: 'eval-runner', recentSuccessRate: 0.5 })).toBe(true);
    // stringify 静默丢键 —— 这正是"静态全绿、运行时全灭"的成因
    expect(JSON.parse(JSON.stringify(v))).toEqual({ script: 'eval-runner' });
  });

  it('数组里的 undefined / NaN / ±Infinity ⇒ 非法（JSON 无这些字面量）', () => {
    expect(isLosslessJson([1, undefined])).toBe(false);
    expect(isLosslessJson([1, Number.NaN])).toBe(false);
    expect(isLosslessJson([1, Number.POSITIVE_INFINITY])).toBe(false);
    expect(isLosslessJson([1, 2])).toBe(true);
    // -0 视为无损：`-0 === 0`，消费方观察不到差异
    expect(isLosslessJson([-0])).toBe(true);
  });

  it('Date / BigInt / Map / Set / 类实例 ⇒ 非法（不是 JSON 值，需显式裁决）', () => {
    class Box { constructor(readonly v = 1) {} }
    for (const bad of [new Date(), 1n, new Map(), new Set(), new Box()]) {
      expect(isLosslessJson(bad), typeof bad + ' 不该判为无损').toBe(false);
    }
  });

  it('稀疏数组（空洞）⇒ 非法（stringify 会把空洞写成 null，下标语义被改写）', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(isLosslessJson([1, , 3])).toBe(false);
  });

  it('循环引用 ⇒ 非法（不能靠 stringify 抛错来发现）', () => {
    const a: Record<string, unknown> = { id: 'x' };
    a.self = a;
    expect(isLosslessJson(a)).toBe(false);
  });

  it('深度/节点数超限 ⇒ 非法（上限是硬断言，防宿主校验栈打爆）', () => {
    const deep = (n: number): unknown => {
      let cur: unknown = 1;
      for (let i = 0; i < n; i += 1) cur = { next: cur };
      return cur;
    };
    expect(isLosslessJson(deep(3))).toBe(true);
    expect(isLosslessJson(deep(DEFAULT_SANITIZE_LIMITS.maxDepth + 2))).toBe(false);
    expect(isLosslessJson([1, 2, 3], { maxDepth: 8, maxNodes: 2 })).toBe(false);
  });

  it('null 与标量正常', () => {
    expect(isLosslessJson(null)).toBe(true);
    expect(isLosslessJson('s')).toBe(true);
    expect(isLosslessJson(0)).toBe(true);
    expect(isLosslessJson(false)).toBe(true);
  });
});

describe('sanitizeForWire：语义裁决逐条钉死', () => {
  it('对象里 undefined 值的键被**删除**（不是变 null——语义是"没有这个字段"）', () => {
    const out = sanitizeForWire({ a: 1, b: undefined, c: null }) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, c: null });
    // 关键裁决的证伪面：变 null 会让消费方把"不可判定"读成"值为空/为 0"
    expect(Object.hasOwn(out, 'b')).toBe(false);
    expect(Object.hasOwn(out, 'c')).toBe(true);
  });

  it('数组里的 undefined → null（数组不许塌缩，否则下标对齐全错）', () => {
    const out = sanitizeForWire([1, undefined, 3]) as unknown[];
    expect(out).toEqual([1, null, 3]);
    expect(out).toHaveLength(3);
  });

  it('NaN / ±Infinity → null；普通数字原样', () => {
    expect(sanitizeForWire({ a: Number.NaN, b: Infinity, c: -Infinity, d: 1.5 }))
      .toEqual({ a: null, b: null, c: null, d: 1.5 });
  });

  it('Date → ISO 字符串；非法 Date → null（toISOString 会抛 RangeError，此处显式裁决）', () => {
    const iso = '2026-10-27T03:00:00.000Z';
    expect(sanitizeForWire({ at: new Date(iso) })).toEqual({ at: iso });
    expect(sanitizeForWire({ at: new Date(Number.NaN) })).toEqual({ at: null });
  });

  it('BigInt → 十进制字符串（stringify 对 BigInt 直接抛 TypeError，比丢值更糟）', () => {
    expect(sanitizeForWire({ n: 123456789012345678901234567890n }))
      .toEqual({ n: '123456789012345678901234567890' });
    expect(() => JSON.stringify({ n: 1n })).toThrow(TypeError);
  });

  it('函数 / Symbol 值被丢弃（与 stringify 一致，但是**确定**的形状）', () => {
    const out = sanitizeForWire({ f: () => 1, s: Symbol('x'), keep: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ keep: 1 });
  });

  it('循环引用 ⇒ **抛错**（工具出口的编程错误必须响亮，静默剪枝会给出假完整值）', () => {
    const a: Record<string, unknown> = { id: 'x' };
    a.self = a;
    expect(() => sanitizeForWire(a)).toThrow(/circular/i);
  });

  it('深度 / 节点数超限 ⇒ 抛错（不静默截断）', () => {
    const deep = (n: number): unknown => {
      let cur: unknown = 1;
      for (let i = 0; i < n; i += 1) cur = { next: cur };
      return cur;
    };
    expect(() => sanitizeForWire(deep(DEFAULT_SANITIZE_LIMITS.maxDepth + 2))).toThrow(/depth/i);
    expect(() => sanitizeForWire([1, 2, 3], { maxDepth: 8, maxNodes: 2 })).toThrow(/node/i);
  });

  it('根值 undefined → null（工具契约要求 object-rooted，undefined 连字符串都拿不到）', () => {
    expect(sanitizeForWire(undefined)).toBeNull();
    expect(JSON.stringify(undefined)).toBeUndefined();
  });

  it('嵌套组合：一次收敛到底（对象删键 + 数组补 null + Date/BigInt 转换）', () => {
    const out = sanitizeForWire({
      scripts: [{ script: 'a', recentSuccessRate: undefined, avg: 1.2, at: new Date('2026-01-01T00:00:00.000Z') }],
      flows: [undefined, { exitCode: undefined, id: 'f1' }],
      big: 10n,
    });
    expect(out).toEqual({
      scripts: [{ script: 'a', avg: 1.2, at: '2026-01-01T00:00:00.000Z' }],
      flows: [null, { id: 'f1' }],
      big: '10',
    });
    expect(roundtrips(out)).toBe(true);
  });
});

describe('快路径：合法值零成本（同一引用，不重建）', () => {
  it('合法值原样返回（引用相等 —— 出口防线不得深拷贝健康路径）', () => {
    const value = { ok: true, list: [1, 2, { k: null }], s: 'x' };
    const out = sanitizeForWire(value);
    expect(out).toBe(value);
    expect(sanitizeForWire('scalar')).toBe('scalar');
    expect(sanitizeForWire(null)).toBeNull();
  });

  it('非法值返回新对象（不与输入共享引用——否则下次调用仍是不合法形状）', () => {
    const value = { a: undefined, b: 1 };
    const out = sanitizeForWire(value);
    expect(out).not.toBe(value);
    expect(isLosslessJson(out)).toBe(true);
  });

  it('**幂等**：sanitize 两次与一次同形（防线可被重复经过而不漂移）', () => {
    const dirty = { a: undefined, b: [Number.NaN, undefined], c: new Date('2026-05-05T00:00:00.000Z') };
    const once = sanitizeForWire(dirty);
    const twice = sanitizeForWire(once);
    expect(twice).toEqual(once);
    // 且第二次必然走快路径（引用不变）
    expect(twice).toBe(once);
  });

  it('输出恒为无损 JSON（对随机脏样本做往返闭合）', () => {
    const samples: unknown[] = [
      { u: undefined }, [undefined], NaN, 3n, new Date(), { d: [{ e: undefined }] },
      { f: () => 1 }, 'x', 0, false, null,
    ];
    for (const s of samples) {
      const out = sanitizeForWire(s);
      expect(isLosslessJson(out), JSON.stringify(out) + ' 不合法').toBe(true);
      expect(roundtrips(out)).toBe(true);
    }
  });
});
