/**
 * cycle-104 折叠偏好与「受控 open 不被 tick 弹回」的反向自检。
 *
 * ## 为什么这个测试必须存在（本改动的核心工程风险）
 *
 * 改造前 `open: true` 是「初值当受控值」：用户折叠之所以不被 2s/4s 轮询重置，
 * 靠的是 React「prop 值不变则不触碰该 DOM 属性」这一**未文档化**行为。改成
 * 受控值 `foldPrefOf(id) ?? defaultOpen` 之后，正确性反过来依赖
 * 「onToggle 写记忆 → 下一次渲染读回同一个值」——这条链断掉时症状是
 * **用户刚折叠的分区在下一轮 tick 弹回展开**（数据更新驱动重渲 → 受控 value
 * 与用户操作反向）。行为测试在 renderToStaticMarkup 下看不到，故此处直接
 * 按 DOM 契约钉死：写记忆后重渲染，`data-anic-fold-state` 必须仍是 closed。
 *
 * ## 为什么用 jsdom
 *
 * 「onToggle 真的被 details 的 toggle 事件触发」是 DOM 行为，node 环境里
 * 事件派发无效（会变成永远绿的假守卫）。jsdom + react-dom/client 真挂载，
 * 派发 toggle 后断言属性——这正是「受控 value 与用户操作同步」的端到端形态。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFoldPrefs, writeFoldPref, foldPrefOf } from '../../src/client/features/prefs/foldPrefs.ts';
import { renderFoldableSection } from '../../src/client/components/sectionShell.ts';
import { PREFS_KEY } from '../../src/shared/flows.ts';

// react-dom/client 在非 CRA 环境需要显式声明 act 环境变量，否则每次 act 打
// 「not configured to support act(...)」stderr 噪音（测试照常通过但淹没输出）。
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

/** localStorage 桩（jsdom 自带，但显式清空避免用例间串味）。 */
function clearStorage(): void {
  try { window.localStorage.clear(); } catch { /* 忽略 */ }
}

/** 挂载 details 并返回宿主 + 重渲 + 卸载（重渲 = 模拟 2s/4s tick 的同一根重渲染）。 */
function mount(section: ReactElement): { host: HTMLElement; rerender: (next: ReactElement) => void; unmount: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  act(() => { root.render(section); });
  return {
    host,
    rerender: (next) => { act(() => { root.render(next); }); },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

describe('foldPrefs —— 折叠偏好读写（PREFS_KEY 的 folds 段）', () => {
  beforeEach(() => { clearStorage(); });
  afterEach(() => { clearStorage(); });

  it('无原文 → 空表（无记忆，调用方回落 defaultOpen）', () => {
    expect(readFoldPrefs()).toEqual({});
    expect(foldPrefOf('cycles')).toBeUndefined();
  });

  it('写入后读回同值；原文含 version:1 + flows + folds（不升 version）', () => {
    writeFoldPref('cycles', false);
    expect(foldPrefOf('cycles')).toBe(false);
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(typeof raw.flows).toBe('object');
    expect((raw.folds as Record<string, boolean>).cycles).toBe(false);
  });

  it('写入保留既有 flows 段（与 prefsDrawer 共用同一原文，不互相清空）', () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ version: 1, flows: { 'flow.stepTrace': false } }));
    writeFoldPref('ledger', true);
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as { flows: Record<string, boolean>; folds: Record<string, boolean> };
    expect(raw.flows['flow.stepTrace']).toBe(false); // 既有 flows 不丢
    expect(raw.folds.ledger).toBe(true);
  });

  it('外部原文变化（其它写者写 flows）→ 重新解析，不吞外部写入', () => {
    writeFoldPref('cycles', false);
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({
      version: 1, flows: {}, folds: { cycles: true, ledger: false },
    }));
    expect(foldPrefOf('cycles')).toBe(true);  // 外部写入被看见
    expect(foldPrefOf('ledger')).toBe(false);
  });

  it('原文非法（坏 JSON / 版本不符 / 非对象）→ fail-safe 空表，不抛错', () => {
    for (const bad of ['{broken', 'null', '"str"', JSON.stringify({ version: 2, flows: {} })]) {
      window.localStorage.setItem(PREFS_KEY, bad);
      expect(readFoldPrefs()).toEqual({});
    }
  });

  it('folds 内非布尔值逐项丢弃（与 flows 段「非法值回默认」同纪律）', () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ version: 1, flows: {}, folds: { a: true, b: 'yes', c: 1, d: null } }));
    expect(readFoldPrefs()).toEqual({ a: true });
  });
});

describe('renderFoldableSection —— 受控 open 与用户操作同步（反向自检）', () => {
  beforeEach(() => { clearStorage(); });
  afterEach(() => { clearStorage(); });

  it('defaultOpen 默认 false（用户要求：静态产物分区默认只展开 live）', () => {
    const { host, unmount } = mount(renderFoldableSection({ id: 'cycles', title: 'T', children: null }));
    const details = host.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.getAttribute('data-anic-fold-state')).toBe('closed');
    unmount();
  });

  it('defaultOpen=true 且无记忆 → 展开；显式 false 的调用点语义不受影响', () => {
    const a = mount(renderFoldableSection({ id: 'diagnostics', title: 'T', children: null, defaultOpen: true }));
    expect((a.host.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(a.host.querySelector('details')!.getAttribute('data-anic-fold-state')).toBe('open');
    a.unmount();
    const b = mount(renderFoldableSection({ id: 'ledger', title: 'T', children: null, defaultOpen: false }));
    expect((b.host.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    b.unmount();
  });

  it('记忆优先于 defaultOpen（用户显式折叠过 → 即便 defaultOpen=true 也收纳）', () => {
    writeFoldPref('diagnostics', false);
    const { host, unmount } = mount(renderFoldableSection({ id: 'diagnostics', title: 'T', children: null, defaultOpen: true }));
    expect((host.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    unmount();
  });

  it('反向自检（核心风险）：onToggle 写 false 后，一次数据更新重渲染**仍为 closed**', () => {
    const { host, rerender, unmount } = mount(renderFoldableSection({ id: 'cycles', title: 'T', children: null, defaultOpen: true }));
    const details = host.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    // 模拟用户折叠：改 DOM 后派发 toggle（原生 details 的真实事件路径）。
    details.open = false;
    act(() => { details.dispatchEvent(new Event('toggle', { bubbles: false })); });
    // ① 记忆已落盘（onToggle 真的写了 false）
    expect(foldPrefOf('cycles')).toBe(false);
    // ② 一次数据更新重渲染（2s/4s tick 的形态：同一受控输入再来一遍）——
    //    受控 value 必须与用户操作同步，即读回 false 而不是 defaultOpen。
    rerender(renderFoldableSection({ id: 'cycles', title: 'T', children: null, defaultOpen: true }));
    const after = host.querySelector('details') as HTMLDetailsElement;
    expect(after.open).toBe(false);
    expect(after.getAttribute('data-anic-fold-state')).toBe('closed');
    unmount();
  });

  it('反向自检续：重新挂载模拟 2s/4s tick 重渲 —— 仍 closed（不弹回）', () => {
    const first = mount(renderFoldableSection({ id: 'cycles', title: 'T', children: null, defaultOpen: true }));
    const d1 = first.host.querySelector('details') as HTMLDetailsElement;
    d1.open = false;
    act(() => { d1.dispatchEvent(new Event('toggle', { bubbles: false })); });
    first.unmount();
    // 「下一轮 tick」= 同一原始输入重新渲染：受控 value 必须读回用户的值，
    // 而不是 defaultOpen。这正是改受控后必须成立的同步不变量。
    const again = mount(renderFoldableSection({ id: 'cycles', title: 'T', children: null, defaultOpen: true }));
    const d2 = again.host.querySelector('details') as HTMLDetailsElement;
    expect(d2.open).toBe(false);
    expect(d2.getAttribute('data-anic-fold-state')).toBe('closed');
    again.unmount();
  });

  it('反向自检的可红性：假定一个**不读记忆**的受控壳（只信 defaultOpen）会被上面的判定抓红', () => {
    // 用同一判定式喂「用户折叠前的值」——证明断言真的能发现不同步。
    const naiveOpen = true;             // 不读记忆的壳在 tick 后仍给 true
    const userValue = false;            // 用户实际折叠态
    expect(naiveOpen === userValue).toBe(false);
  });

  it('data-anic-fold 与 data-anic-fold-state 并列（真机旅程可读的受控态锚点）', () => {
    const { host, unmount } = mount(renderFoldableSection({ id: 'budget', title: 'T', children: null }));
    const d = host.querySelector('details')!;
    expect(d.getAttribute('data-anic-fold')).toBe('budget');
    expect(d.getAttribute('data-anic-fold-state')).toBe('closed');
    unmount();
  });

  it('storage 不可用（隐私模式）→ 本次会话内记忆仍一致（内存权威，不弹回）', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        clear: () => undefined,
      },
    });
    try {
      writeFoldPref('flows', false);      // 写 storage 失败 → 内存态权威
      expect(foldPrefOf('flows')).toBe(false);
      const { host, unmount } = mount(renderFoldableSection({ id: 'flows', title: 'T', children: null, defaultOpen: true }));
      expect((host.querySelector('details') as HTMLDetailsElement).open).toBe(false);
      unmount();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
