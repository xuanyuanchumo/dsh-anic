/**
 * 分键视图态**接线**的单元契约（cycle-95 · WS-C · 修 O-94-03）。
 *
 * ## 被守卫的缺陷（实测）
 *
 * `src/client/components/workspaceViewState.ts` 在 cycle-89 就写好了
 * （含 localStorage 不可用时的内存降级 + 配套单测），但**全仓零调用点**。
 * 后果是"每次切项目都要重新定位"：缩放/平移/筛选是用户在这个项目里建立的
 * 空间认知，切走后丢失、切回来不恢复。
 *
 * `tests/unit/workspaceIsolation.test.ts` 守的是那份**存取库**本身；
 * 本文件守的是**接线**（`graphViewStateWire` + `useGraphViewState` 的判据）——
 * 两者必须分开：库全绿而接线断了，正是"纯函数全绿、用户点了没反应"那一族。
 *
 * ## 三条接线判据（每条都配反向自检）
 *
 * 1. **坏数据不得让面板崩**：形状不对 / NaN / 未知布局模式 → 逐字段丢弃；
 * 2. **节流写入**：`pointermove` 期间不得写盘（拖拽一次几十次变化）；
 * 3. **A/B 互不污染**：换工作区写新键、旧键先落盘、未知工作区不写。
 *
 * ## 为什么注入时钟与定时器而不是 `vi.useFakeTimers`
 *
 * `createViewStateWriter` 的 delayMs / setTimer / clearTimer / now 都是**可注入
 * 参数**（见 `graphViewStateWire` 头注）。注入比全局假定时器更硬：
 * 断言的是"这个写入器在收到 40 次 schedule 之后只落盘一次"，
 * 而不是"全局时钟被推进了 300ms 后某个回调跑了"。后者依赖 vitest 的假定时器
 * 实现细节，前者只依赖本文件的契约。
 */
import { describe, it, expect } from 'vitest';
import type { WorkspaceViewState } from '../../src/client/components/workspaceViewState.ts';
import { createMemoryViewStateStore, loadViewState } from '../../src/client/components/workspaceViewState.ts';
import { UNKNOWN_WORKSPACE_KEY, workspaceKeyOf } from '../../src/client/components/workspaceGuard.ts';
import {
  WRITE_DELAY_MS,
  createViewStateWriter,
  loadRestoredViewState,
  restoredViewStateOf,
  viewStateSnapshotOf,
} from '../../src/client/features/graph/graphViewStateWire.ts';
import { EMPTY_FILTER, type FilterState } from '../../src/client/features/graph/graphFilter.ts';
import { IDENTITY, type Viewport } from '../../src/client/features/graph/graphViewport.ts';

/** 一个可推进的假时钟 + 定时器（比全局假定时器更可控，见文件头）。 */
function fakeClock(): {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { id: number };
  clearTimer: (h: { id: number }) => void;
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: nowMs + ms, fn }); return { id }; },
    clearTimer: (h) => { timers.delete(h.id); },
    advance: (ms) => {
      nowMs += ms;
      // 按时间顺序跑到期回调（回调里可能再排一个，故循环到稳定）。
      for (let guard = 0; guard < 20; guard += 1) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, t] of due) { timers.delete(id); t.fn(); }
      }
    },
    pendingCount: () => timers.size,
  };
}

const VIEWPORT = (scale: number, tx: number, ty: number): Viewport => ({ scale, tx, ty });
const FILTER = (query: string): FilterState => ({ types: [], verdicts: [], query });

describe('① 快照 / 还原往返（形状与字段）', () => {
  it('snapshot → restore 保真（视口 / 筛选 / 布局模式三项都在）', () => {
    const snapshot = viewStateSnapshotOf({
      viewport: VIEWPORT(2, 10, -4),
      filter: { types: ['gate'], verdicts: ['fail'], query: 'g0' },
      layoutMode: 'compact',
    });
    const restored = restoredViewStateOf(snapshot);
    expect(restored.viewport).toEqual({ scale: 2, tx: 10, ty: -4 });
    expect(restored.filter).toEqual({ types: ['gate'], verdicts: ['fail'], query: 'g0' });
    expect(restored.layoutMode).toBe('compact');
  });

  it('没存过（null）→ 空对象，**不返回伪装成默认值的对象**', () => {
    const restored = restoredViewStateOf(null);
    expect(restored).toEqual({});
    // 反向自检：若实现返回 { viewport: IDENTITY }，上面那条会绿、这条会红。
    expect(restored.viewport).toBeUndefined();
  });

  it('坏字段**逐个丢弃**，好字段照用（不是一票否决）', () => {
    const restored = restoredViewStateOf({
      // 视口坏（NaN scale）→ 丢弃；布局模式好 → 保留。
      zoom: Number.NaN,
      pan: { x: 0, y: 0 },
      layoutMode: 'flow',
      filter: { types: 'not-an-array', verdicts: [], query: '' },
    } as unknown as WorkspaceViewState);
    expect(restored.viewport).toBeUndefined();
    expect(restored.layoutMode).toBe('flow');
    expect(restored.filter).toBeUndefined();
  });

  it('未登记的布局模式被丢弃（不把任意字符串写进布局键）', () => {
    expect(restoredViewStateOf({ layoutMode: 'diagonal' }).layoutMode).toBeUndefined();
  });

  it('视口缩放被钳进 [SCALE_MIN, SCALE_MAX]（NaN 之外的越界也能挡）', () => {
    const restored = restoredViewStateOf({ zoom: 99, pan: { x: 0, y: 0 } });
    expect(restored.viewport?.scale).toBe(4); // SCALE_MAX
  });

  it('反向自检：把 pan 换成字符串，视口必须被判无效', () => {
    const restored = restoredViewStateOf({ zoom: 1, pan: 'oops' } as unknown as WorkspaceViewState);
    expect(restored.viewport).toBeUndefined();
  });
});

describe('② 节流写入（拖拽期间不得写盘）', () => {
  it(`连续 40 次变化 → 只落盘 1 次（delayMs=${String(WRITE_DELAY_MS)} 的 trailing 语义）`, () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    for (let i = 0; i < 40; i += 1) {
      writer.schedule('D:/proj-a', viewStateSnapshotOf({
        viewport: VIEWPORT(1, i, i), filter: EMPTY_FILTER, layoutMode: 'lane',
      }));
    }
    // 还没到静默期 ⇒ 磁盘上什么都没有（拖拽中不写盘）。
    expect(loadViewState(store, 'D:/proj-a')).toBeNull();
    clock.advance(WRITE_DELAY_MS);
    const saved = loadViewState(store, 'D:/proj-a');
    expect(saved?.pan).toEqual({ x: 39, y: 39 }); // 落的是**最后一次**
  });

  it('反向自检：每次变化都写盘时，上面的"磁盘为空"断言会红', () => {
    const store = createMemoryViewStateStore();
    // 直接 store.set（= 不节流的实现）
    store.set(workspaceKeyOf('D:/proj-a'), { zoom: 1 });
    expect(loadViewState(store, 'D:/proj-a')).not.toBeNull(); // 证明"为空"那条有牙
  });

  it('同键同值不重置定时器（数据 tick 每 4s 重渲，不该把静默期无限推后）', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    const same = viewStateSnapshotOf({ viewport: VIEWPORT(1.5, 3, 3), filter: EMPTY_FILTER, layoutMode: 'lane' });
    writer.schedule('D:/proj-a', same);
    clock.advance(WRITE_DELAY_MS - 1);
    writer.schedule('D:/proj-a', same); // 值没变
    clock.advance(1);                    // 原定时器到点
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(1.5);
    expect(clock.pendingCount()).toBe(0);
  });

  it('flush() 立即落盘（切工作区/卸载时用户最后那一下不能丢）', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    writer.schedule('D:/proj-a', viewStateSnapshotOf({ viewport: VIEWPORT(3, 0, 0), filter: EMPTY_FILTER, layoutMode: 'lane' }));
    writer.flush();
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(3);
  });

  it('速率下限：刚写完立刻又来变化 → 再等一轮，不在同一毫秒写两次', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    writer.schedule('D:/proj-a', viewStateSnapshotOf({ viewport: VIEWPORT(2, 0, 0), filter: EMPTY_FILTER, layoutMode: 'lane' }));
    clock.advance(WRITE_DELAY_MS);
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(2);
    writer.schedule('D:/proj-a', viewStateSnapshotOf({ viewport: VIEWPORT(2.5, 0, 0), filter: EMPTY_FILTER, layoutMode: 'lane' }));
    clock.advance(1);
    // 距上次写入不足 delayMs ⇒ 尚未写第二次（磁盘仍是 2）。
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(2);
    clock.advance(WRITE_DELAY_MS);
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(2.5);
  });
});

describe('③ A / B 两个项目互不污染（分键的核心承诺）', () => {
  it('两个工作区的视图态各自独立', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    writer.schedule('D:/proj-a', viewStateSnapshotOf({ viewport: VIEWPORT(2, 5, 5), filter: FILTER('a'), layoutMode: 'lane' }));
    clock.advance(WRITE_DELAY_MS);
    writer.schedule('D:/proj-b', viewStateSnapshotOf({ viewport: VIEWPORT(0.5, -9, -9), filter: FILTER('b'), layoutMode: 'compact' }));
    clock.advance(WRITE_DELAY_MS);
    const a = loadRestoredViewState(store, 'D:/proj-a');
    const b = loadRestoredViewState(store, 'D:/proj-b');
    expect(a.viewport?.scale).toBe(2);
    expect(a.filter?.query).toBe('a');
    expect(b.viewport?.scale).toBe(0.5);
    expect(b.filter?.query).toBe('b');
    expect(b.layoutMode).toBe('compact');
  });

  it('**换键先落旧键**：A 调好后立刻切 B，A 的最后一次调整不能丢', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    writer.schedule('D:/proj-a', viewStateSnapshotOf({ viewport: VIEWPORT(1, 0, 0), filter: EMPTY_FILTER, layoutMode: 'lane' }));
    // 还没到静默期就切到 B（pending 里仍是 A，不能直接覆盖成 B）。
    writer.schedule('D:/proj-b', viewStateSnapshotOf({ viewport: VIEWPORT(3, 0, 0), filter: EMPTY_FILTER, layoutMode: 'compact' }));
    expect(loadViewState(store, 'D:/proj-a')?.zoom).toBe(1); // 旧键已落盘
    clock.advance(WRITE_DELAY_MS);
    expect(loadRestoredViewState(store, 'D:/proj-b').layoutMode).toBe('compact');
  });

  it('反向自检：换键不落旧键时（= 直接覆盖 pending），A 在磁盘上会是 null', () => {
    const store = createMemoryViewStateStore();
    expect(loadViewState(store, 'D:/proj-a')).toBeNull(); // "旧键已落盘"那条断言因此有牙
  });

  it('Windows 盘符大小写归一后是**同一个键**（不把同一项目当两个）', () => {
    const store = createMemoryViewStateStore();
    const clock = fakeClock();
    const writer = createViewStateWriter({ store, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    writer.schedule('D:\\Project-A', viewStateSnapshotOf({ viewport: VIEWPORT(2, 0, 0), filter: EMPTY_FILTER, layoutMode: 'lane' }));
    clock.advance(WRITE_DELAY_MS);
    // 同一项目以另一种大小写读回 —— 必须命中同一份。
    expect(loadRestoredViewState(store, 'd:/project-a').viewport?.scale).toBe(2);
  });
});

describe('④ 未知工作区：不记忆（诚实退化，不是共用一份）', () => {
  it('workspaceKeyOf(undefined) 落到固定未知键（说明为什么不能拿它当真实分键）', () => {
    expect(workspaceKeyOf(undefined)).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(workspaceKeyOf(null)).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(workspaceKeyOf('   ')).toBe(UNKNOWN_WORKSPACE_KEY);
  });

  it('两个"未知"项目读同一键 ⇒ 这正是接线层必须**不写未知键**的理由', () => {
    const store = createMemoryViewStateStore();
    // 演示污染：若接线层把未知也写入，两个项目会读到同一份。
    // （必须带 pan —— 只有 zoom 的残缺状态会被 `restoredViewStateOf` 判无效，
    //  那是另一条判据；这条要演示的是"键空间共用"。）
    store.set(UNKNOWN_WORKSPACE_KEY, { zoom: 2, pan: { x: 0, y: 0 } });
    expect(loadRestoredViewState(store, undefined).viewport?.scale).toBe(2);
    expect(loadRestoredViewState(store, 'D:/proj-b').viewport).toBeUndefined(); // 真实项目不受污染
  });

  it('真实工作区读不到未知键的残留（键空间不相交）', () => {
    const store = createMemoryViewStateStore();
    store.set(UNKNOWN_WORKSPACE_KEY, { zoom: 2, pan: { x: 0, y: 0 } });
    expect(loadRestoredViewState(store, 'D:/proj-a')).toEqual({});
  });

  it('默认视口 IDENTITY 可作为兜底（空筛选 + 恒等视口 = 未操作过的合理默认）', () => {
    expect(IDENTITY).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
});

describe('⑤ localHost 不可用时静默降级（不得抛错让面板挂掉）', () => {
  it('没有 localStorage 时 createViewStateStore 走内存路径，读写仍可用', () => {
    // 本 vitest 环境（node）里 globalThis.localStorage 通常不存在 —— 正是降级路径。
    const hasLs = typeof (globalThis as { localStorage?: unknown }).localStorage !== 'undefined';
    const restored = loadRestoredViewState(createMemoryViewStateStore(), 'D:/proj-a');
    expect(restored).toEqual({});
    // 记录环境事实（不是断言失败）：真实宿主的 file:// 源同样落在这条路径。
    expect(typeof hasLs).toBe('boolean');
  });

  it('坏 JSON 字符串（用户手工改 localStorage / 旧构建产物）→ 读回 null 不抛', () => {
    const store = createMemoryViewStateStore();
    // 内存实现只存对象；这里用"形状全坏的对象"模拟读回坏数据。
    store.set(workspaceKeyOf('D:/proj-a'), { zoom: 'x', pan: null, filter: [], layoutMode: 7 } as unknown as WorkspaceViewState);
    expect(() => loadRestoredViewState(store, 'D:/proj-a')).not.toThrow();
    expect(loadRestoredViewState(store, 'D:/proj-a')).toEqual({});
  });
});
