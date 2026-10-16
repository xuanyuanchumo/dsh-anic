/**
 * roving tabindex 键盘导航单测（P1-2）。
 *
 * graphKeyDown 是无 DOM 依赖的纯事件处理器：它对 currentTarget 做
 * querySelectorAll('[data-anic-node]') 无状态查询。测试用最小 stub 元素
 * （有 focus() 与 dataset）验证导航语义：
 *   - 四方向（Right/Down 前进，Left/Up 后退）+ 环绕
 *   - Home/End 跳首尾
 *   - 非导航键（Tab/Enter/Space/普通字符）必须放行（不 preventDefault）
 */
import { describe, it, expect, vi } from 'vitest';
import { graphKeyDown } from '../../src/client/features/graph/graphKeyboard.ts';

interface StubEl {
  dataset: Record<string, string>;
  focus: ReturnType<typeof vi.fn>;
}

/** 造 N 个可聚焦 stub；返回容器（currentTarget）与元素数组。 */
function makeContainer(n: number): { container: StubEl & { querySelectorAll: (sel: string) => StubEl[] }; els: StubEl[] } {
  const els: StubEl[] = Array.from({ length: n }, () => ({ dataset: {}, focus: vi.fn() }));
  const container = {
    dataset: {},
    focus: vi.fn(),
    querySelectorAll: (sel: string) => (sel === '[data-anic-node]' ? els : []),
  };
  return { container, els };
}

const fire = (container: unknown, el: StubEl | null, key: string) => {
  const preventDefault = vi.fn();
  graphKeyDown({ key, preventDefault, currentTarget: container, target: el } as unknown as Parameters<typeof graphKeyDown>[0]);
  return preventDefault;
};

describe('graphKeyDown roving 导航（P1-2）', () => {
  it('ArrowRight/Down 前进（含环绕）且 preventDefault', () => {
    const { container, els } = makeContainer(3);
    expect(fire(container, els[0] ?? null, 'ArrowRight')).toHaveBeenCalledTimes(1);
    expect(els[1]?.focus).toHaveBeenCalledTimes(1);
    expect(fire(container, els[1] ?? null, 'ArrowDown')).toHaveBeenCalledTimes(1);
    expect(els[2]?.focus).toHaveBeenCalledTimes(1);
    // 环绕：末尾 → 首个（169 节点的图，环绕比"卡死在末尾"更可用）
    expect(fire(container, els[2] ?? null, 'ArrowRight')).toHaveBeenCalledTimes(1);
    expect(els[0]?.focus).toHaveBeenCalledTimes(1);
  });

  it('ArrowLeft/Up 后退（含环绕）', () => {
    const { container, els } = makeContainer(3);
    fire(container, els[2] ?? null, 'ArrowLeft');
    expect(els[1]?.focus).toHaveBeenCalledTimes(1);
    // 首个 → 末尾（反向环绕）
    fire(container, els[0] ?? null, 'ArrowUp');
    expect(els[2]?.focus).toHaveBeenCalledTimes(1);
  });

  it('Home/End 跳首尾', () => {
    const { container, els } = makeContainer(4);
    fire(container, els[2] ?? null, 'Home');
    expect(els[0]?.focus).toHaveBeenCalledTimes(1);
    fire(container, els[1] ?? null, 'End');
    expect(els[3]?.focus).toHaveBeenCalledTimes(1);
  });

  it('焦点在容器本身（target 不在节点集）时从第一个节点开始', () => {
    const { container, els } = makeContainer(3);
    fire(container, container, 'ArrowRight');
    expect(els[0]?.focus).toHaveBeenCalledTimes(1);
  });

  it('非导航键必须放行（Tab 能离开图区、Enter/Space 归激活语义）', () => {
    const { container, els } = makeContainer(3);
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'Shift']) {
      expect(fire(container, els[0] ?? null, key)).not.toHaveBeenCalled();
    }
    for (const el of els) expect(el.focus).not.toHaveBeenCalled();
  });

  it('空图（无节点）不抛不拦截', () => {
    const { container } = makeContainer(0);
    expect(() => fire(container, null, 'ArrowRight')).not.toThrow();
  });
});
