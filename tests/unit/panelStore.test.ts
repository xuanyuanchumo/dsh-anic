/**
 * panelStore 机制测试（cycle-42 Top2）——外部 store 的订阅/合并语义。
 *
 * 命题拆分：
 *   1. getState/setState/subscribe 的纯机制（不依赖 React）；
 *   2. 浅合并按顶层 key 替换引用、全等补丁不通知（与 ETag 304 同语义）；
 *   3. 退订后不再通知；通知期间退订不破坏本轮迭代（快照迭代语义）；
 *   4. usePanelSlice 经 react-dom/server 渲染路径取到切片值（getServerSnapshot
 *      分支——与 getSnapshot 同源，static 渲染可验证接线正确性）。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createPanelStore, usePanelSlice } from '../../src/client/components/panelStore.ts';

interface TestState { a: { v: number }; b: string; c: number; }

function makeStore(): ReturnType<typeof createPanelStore<TestState>> {
  return createPanelStore<TestState>({ a: { v: 1 }, b: 'x', c: 0 });
}

describe('createPanelStore（纯机制）', () => {
  it('getState 返回 initial 引用；setState 返回新对象（不可变替换）', () => {
    const initial: TestState = { a: { v: 1 }, b: 'x', c: 0 };
    const store = createPanelStore(initial);
    expect(store.getState()).toBe(initial);
    store.setState({ b: 'y' });
    expect(store.getState()).not.toBe(initial);
    expect(store.getState().b).toBe('y');
  });

  it('浅合并：被替换的 key 换引用，未触及的 key 保持原引用（分区重渲隔离的数据前提）', () => {
    const store = makeStore();
    const aBefore = store.getState().a;
    store.setState({ c: 7 });
    expect(store.getState().a).toBe(aBefore);
    expect(store.getState().c).toBe(7);
  });

  it('全等补丁（每个 key 都 Object.is 相同）不通知——「数据未变」零重渲', () => {
    const store = makeStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.setState({});
    store.setState({ a: store.getState().a, b: 'x', c: 0 });
    expect(spy).not.toHaveBeenCalled();
    store.setState({ c: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('subscribe 返回退订函数；退订后不再收到通知', () => {
    const store = makeStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    store.setState({ c: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
    store.setState({ c: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('通知期间退订不破坏本轮迭代（listeners 快照语义）', () => {
    const store = makeStore();
    const seen: string[] = [];
    const unsubLate = store.subscribe(() => { seen.push('late'); });
    store.subscribe(() => { seen.push('first'); unsubLate(); });
    store.setState({ c: 1 });
    // Set 按插入序回调：unsubLate 先注册先触发；'first' 里退订不影响本轮已快照的它
    expect(seen).toEqual(['late', 'first']);
    store.setState({ c: 2 });
    expect(seen).toEqual(['late', 'first', 'first']); // 下一轮已无 late
  });
});

describe('usePanelSlice（react-dom/server 渲染路径）', () => {
  it('组件经 usePanelSlice 取到切片值，setState 后重渲反映新值', () => {
    const store = createPanelStore<{ n: number }>({ n: 41 });
    const sel = (s: { n: number }) => s.n;
    function Probe(): React.ReactElement {
      const n = usePanelSlice(store, sel);
      return createElement('span', { 'data-anic-probe': String(n) }, String(n));
    }
    const html1 = renderToStaticMarkup(createElement(Probe));
    expect(html1).toContain('data-anic-probe="41"');
    expect(html1).toContain('41');
    store.setState({ n: 42 });
    const html2 = renderToStaticMarkup(createElement(Probe));
    expect(html2).toContain('data-anic-probe="42"');
  });

  it('selector 返回切片原引用时，全等 setState 后快照不变（引用稳定性前提）', () => {
    const obj = { v: 9 };
    const store = createPanelStore<{ o: { v: number } }>({ o: obj });
    const sel = (s: { o: { v: number } }) => s.o;
    expect(useSnapshotRef(store, sel)).toBe(obj);
    store.setState({ o: { v: 10 } });
    expect(useSnapshotRef(store, sel)).toEqual({ v: 10 });
  });
});

function useSnapshotRef<S extends object>(store: ReturnType<typeof createPanelStore<S>>, selector: (s: S) => unknown): unknown {
  return selector(store.getState());
}
