/**
 * 面板数据 store —— cycle-42 Top2 主修复的机制层。
 *
 * 背景（Top2 债务）：WorkflowGraphPanel 根组件曾持有 ~15 个数据 useState，
 * useInvocations 的 2s tick setState 发生在根 → 每 tick 全树重渲（graph SVG、
 * 九个分区全部重建）。usePanelFetch 的 ETag 304 跳过 apply 已把「数据未变」
 * 的重渲消掉，但「数据变了」时仍是全树——本轮把数据面搬进外部 store。
 *
 * 机制选型（ui-research 简报主题一/二，context7 /react/react + /pmndrs/zustand）：
 *   - useSyncExternalStore（React 官方外部 store 订阅入口）：store 更新只强制
 *     **订阅组件自身**同步重渲染（SyncLane），不再波及未订阅分区；
 *   - 本文件手写 zustand v5 vanilla 的零依赖等价物（useStore 即 uSES 最小封装
 *     8 行）——不引 zustand，守住本仓「运行时依赖为零」纪律；
 *   - 防撕裂内建：并发渲染完成后 React 重调 getSnapshot 与渲染值 Object.is
 *     比较 → getSnapshot 必须便宜、纯、返回缓存引用；
 *   - **selector 返回新引用会无限重渲**（Maximum update depth exceeded，
 *     zustand v5 同款陷阱）——usePanelSlice 的调用方必须返回切片原引用
 *     （模块级 selector / 每值独立订阅，官方首推模式），本仓禁用「selector 内
 *     组装新对象」形态。
 *
 * getServerSnapshot = getSnapshot：renderToStaticMarkup（react-dom/server，
 * 本仓测试渲染路径）走 server 分支返回当前状态——SSR 渲染初始态可用。
 */
import { useCallback, useSyncExternalStore } from 'react';

/** 面板 store 实例形状（zustand vanilla 同构：getState/setState/subscribe）。 */
export interface PanelStore<T extends object> {
  /** 当前状态快照（渲染期调用必须纯且便宜）。 */
  getState(): T;
  /**
   * 按顶层 key 替换引用（浅合并）。全等补丁（每个 key 都 Object.is 相同）
   * 不通知——「数据未变」零重渲，与 usePanelFetch 的 ETag 304 跳过同一语义。
   *
   * cycle-45（T-4502a，ui-research 主题①）：补丁可以是 Partial 或
   * `(s) => Partial` 函数式形态——写侧需要「先读后写」的场合（如 announce
   * 回读、malformed 降级保 source）在 updater 内对原子快照计算，不再
   * getState/setState 两步走（形态原子，语义与原两步等价：单线程事件循环
   * 下本无竞态，函数式只是把回读语义显式化进机制层）。
   */
  setState(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  /** 订阅变更；返回退订函数（uSES 契约）。 */
  subscribe(listener: () => void): () => void;
}

/**
 * 创建面板 store。initial 引用被持有（不深拷贝——调用方传模块级常量或
 * useRef 惰性值，禁止渲染期每次新建）。
 */
export function createPanelStore<T extends object>(initial: T): PanelStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (patch) => {
      // T-4502a：函数式补丁先解引用（对当前快照求值一次，读-改-写原子化）。
      const resolved = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      const next: T = { ...state };
      for (const key of Object.keys(resolved) as Array<keyof T>) {
        if (Object.is(state[key], resolved[key])) continue;
        next[key] = resolved[key] as T[keyof T];
        changed = true;
      }
      if (!changed) return;
      state = next;
      // 拷贝 listeners 快照：通知期间退订不影响本轮（Set 迭代中删除已访问项安全，
      // 但新增项不应收到本轮通知——快照迭代即此语义）。
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * 订阅切片（zustand useStore 形态）。selector 必须引用稳定（模块级函数或
 * useCallback），且返回切片原引用——违反任一条会陷入无限重渲（见文件头）。
 *
 * cycle-45（T-4502b）：dev 双调自检——两条硬契约此前只活在注释，全部测试走
 * renderToStaticMarkup 的 getServerSnapshot 分支，结构性测不到「selector 返回
 * 新引用 → Maximum update depth exceeded」陷阱。DEV 构建下对同一快照双调
 * selector 并 Object.is 比对，不等 → 一次性 console.warn（client dev 诊断，
 * 非 host 日志域——不用 scoped logger）。生产零开销（分支不进 bundle 主路径
 * 行为）。签名不变。
 */
export function usePanelSlice<T extends object, U>(store: PanelStore<T>, selector: (state: T) => U): U {
  // useCallback 稳定 getSnapshot：subscribe 引用恒定（store 方法），selector
  // 引用由调用方保证——两者不变则 uSES 不重订阅。
  const getSnapshot = useCallback(() => {
    const s = store.getState();
    const v = selector(s);
    if (import.meta.env?.DEV) {
      const again = selector(s);
      if (!Object.is(v, again)) {
        devWarnUnstableSlice(store);
      }
    }
    return v;
  }, [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** dev 一次性告警（同 store 只 warn 一次——2s 轮询双调失败不该刷屏）。 */
const devWarnedStores = new WeakSet<object>();
function devWarnUnstableSlice(store: object): void {
  if (devWarnedStores.has(store)) return;
  devWarnedStores.add(store);
  console.warn('[anic-panel] usePanelSlice selector 返回了新引用（同一 state 快照两次调用 Object.is 不等）——这会触发 uSES 无限重渲。请返回切片原引用（每值独立订阅或 useShallow 语义），参见 panelStore.ts 文件头契约。');
}
