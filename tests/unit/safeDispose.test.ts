/**
 * 拆卸隔离契约（cycle-89 T-12）—— **一个 disposer 抛错不得阻断其余**。
 *
 * ## 被守卫的缺陷（实测）
 *
 * `src/host/routes/index.ts` 与 `src/host/tools.ts` 此前都是：
 * `return () => { for (const d of cleanups) d(); };`
 *
 * `for` 循环里任一 `d()` 抛错，后续 disposer 一个都不执行。插件热重载场景下
 * 后果是致命的：上一轮注册的路由/工具**留在宿主里没注销**，新一轮又注册一份
 * → 同路径双注册、旧工具仍可被调用。
 *
 * 更隐蔽的次生伤害：disposer 里包着 `ctx.effect(() => () => service.dispose())`
 * 形态的**能力撤销**。一次抛错 = 该撤销的权限没撤销 = 能力守卫半途卡死。
 */
import { describe, expect, it, vi } from 'vitest';
import { safeDisposeAll, disposeErrorSink } from '../../src/host/runtime/safeDispose.ts';

describe('safeDisposeAll：失败隔离', () => {
  it('**抛错的 disposer 不阻断其余**（核心守卫）', () => {
    const order: string[] = [];
    const cleanups = [
      (): void => { order.push('a'); },
      (): void => { throw new Error('boom-2'); },
      (): void => { order.push('c'); },
      (): void => { throw new Error('boom-4'); },
      (): void => { order.push('e'); },
    ];
    const failures: string[] = [];
    const report = safeDisposeAll(cleanups, (f) => { failures.push(`#${String(f.index)}:${f.message}`); }, 'test');

    // 三个成功的 disposer **全部执行了** —— 第二个抛错没有截断后面的。
    expect(order).toEqual(['a', 'c', 'e']);
    expect(report.total).toBe(5);
    expect(report.ok).toBe(3);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]?.index).toBe(1);
    expect(report.failures[0]?.message).toBe('boom-2');
    expect(report.failures[1]?.index).toBe(3);
    expect(failures).toHaveLength(2);
  });

  it('null/undefined disposer 被跳过且不计入 total', () => {
    const report = safeDisposeAll([null, undefined, (): void => {}], () => {}, 'test');
    expect(report.total).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.failures).toHaveLength(0);
  });

  it('**错误 sink 自身抛错也不影响后续 disposer**', () => {
    const order: string[] = [];
    const cleanups = [
      (): void => { throw new Error('x'); },
      (): void => { order.push('after'); },
    ];
    const report = safeDisposeAll(cleanups, () => { throw new Error('sink-failed'); }, 'test');
    expect(order).toEqual(['after']);
    expect(report.failures).toHaveLength(1);
  });

  it('空集合返回零报告（不抛错）', () => {
    const report = safeDisposeAll([], () => {}, 'test');
    expect(report).toEqual({ total: 0, ok: 0, failures: [] });
  });

  it('disposer 返回 promise 时不视为失败（同步语义，promise 拒绝由调用方自理）', () => {
    // 用一个**永不拒绝**的 promise：这条断言只关心"返回 promise 不算失败"，
    // 不引入未处理的 rejection 噪音（那会让 vitest 报 unhandled error）。
    const report = safeDisposeAll([(): void => { void Promise.resolve(1); }], () => {}, 'test');
    expect(report.ok).toBe(1);
    expect(report.failures).toHaveLength(0);
  });
});

describe('disposeErrorSink：默认错误回调', () => {
  it('不抛错（错误 sink 自身失败被吞）', () => {
    expect(() => { disposeErrorSink('anic routes')({ index: 0, message: 'x' }); }).not.toThrow();
  });

  it('产出的是可调用函数', () => {
    expect(typeof disposeErrorSink('anic tools')).toBe('function');
  });
});

describe('聚合器接线（routes/index.ts 与 tools.ts）', () => {
  it('两处聚合器都不再用裸 for 循环拆卸', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(process.cwd());
    for (const rel of ['src/host/routes/index.ts', 'src/host/tools.ts']) {
      const text = readFileSync(join(root, rel), 'utf8');
      expect(text, `${rel} 仍用裸 for 拆卸`).not.toMatch(/for \(const d of cleanups\) d\(\);/);
      expect(text, `${rel} 未接入 safeDisposeAll`).toContain('safeDisposeAll');
    }
  });

  it('safeDisposeAll 在 logger 未就绪时也不抛错（宿主启动早期）', () => {
    const spy = vi.fn();
    // 故意用会抛错的 sink，验证整段不炸。
    const report = safeDisposeAll([(): void => { throw new Error('e'); }], spy, 'x');
    expect(report.failures).toHaveLength(1);
  });
});
