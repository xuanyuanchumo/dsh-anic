/**
 * 容器尺寸跟踪测试（cycle-104）。
 *
 * 防的缺陷（实测，见 `.cycles/cycle-104-evidence/baseline-findings.md` §5）：
 * 改造前全仓零 resize/ResizeObserver 观测点，图在容器尺寸变化后不重新适配。
 *
 * 这里钉死三件事，都是容易在后续重构中被悄悄破坏的：
 *   ① `sizeChanged` 的容差语义（1px 内不算变化——否则滚动/动画会疯狂重适配）；
 *   ② 环境无 ResizeObserver 时**降级不抛**（jsdom/stub/SSR 是常态环境）；
 *   ③ `resolveResizeObserver` 只认函数形态（脏全局不能让它崩）。
 */
import { describe, expect, it } from 'vitest';
import { resolveResizeObserver, sizeChanged } from '../../src/client/features/graph/useContainerSize.ts';

describe('sizeChanged — 容差语义', () => {
  it('首次测量：正尺寸才算变化，0 尺寸不算（未挂载 ≠ 尺寸变了）', () => {
    expect(sizeChanged(null, { width: 640, height: 420 })).toBe(true);
    expect(sizeChanged(null, { width: 0, height: 0 })).toBe(false);
    expect(sizeChanged(null, { width: 0, height: 420 })).toBe(false);
  });

  it('1px 内的抖动不算变化（防滚动/动画高频触发）', () => {
    const prev = { width: 640, height: 420 };
    expect(sizeChanged(prev, { width: 640, height: 420 })).toBe(false);
    expect(sizeChanged(prev, { width: 640.5, height: 420.5 })).toBe(false);
    expect(sizeChanged(prev, { width: 641, height: 421 })).toBe(false); // 恰好 1px 仍在容差内
  });

  it('实质变化必须被发现（这是本功能存在的理由）', () => {
    const prev = { width: 640, height: 420 };
    expect(sizeChanged(prev, { width: 1464, height: 420 })).toBe(true); // 面板展开
    expect(sizeChanged(prev, { width: 640, height: 900 })).toBe(true);  // 全屏
    expect(sizeChanged(prev, { width: 320, height: 210 })).toBe(true);  // 窄栏
  });

  it('容差可覆盖（默认 1px，显式传 0 = 严格）', () => {
    const prev = { width: 640, height: 420 };
    expect(sizeChanged(prev, { width: 641, height: 420 }, 0)).toBe(true);
  });
});

describe('resolveResizeObserver — 环境探测', () => {
  it('无 ResizeObserver 时返回 null 而不抛（jsdom/stub/SSR 常态）', () => {
    const saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      expect(resolveResizeObserver()).toBeNull();
    } finally {
      if (saved !== undefined) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved;
    }
  });

  it('脏全局（非函数值）也返回 null，不误判为可用', () => {
    const saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = { notAConstructor: true };
      expect(resolveResizeObserver()).toBeNull();
    } finally {
      if (saved !== undefined) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved;
    }
  });

  it('函数形态被正确取回', () => {
    const saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      const fake = function FakeRO() {} as unknown;
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = fake;
      expect(resolveResizeObserver()).toBe(fake);
    } finally {
      if (saved !== undefined) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved;
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});
