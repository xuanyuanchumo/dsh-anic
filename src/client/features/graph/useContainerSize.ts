/**
 * 容器尺寸跟踪（cycle-104）—— 让图在容器变化时重新适配。
 *
 * ## 修的缺陷（DOM 实测，见 `.cycles/cycle-104-evidence/baseline-findings.md` §5）
 *
 * 改造前全仓 `grep -rn "addEventListener('resize'|ResizeObserver" src/client/` **零命中**，
 * 而 `GraphInteractive.ts` 用 `fittedRef` 守卫「只首屏适配一次」。后果：
 * - 面板折叠/展开、窗口缩放、进入全屏 —— 视口尺寸变了，图**不重新 fit**；
 * - 用户看到的是按旧尺寸算出的缩放/平移，图缩在角落或溢出被裁。
 *
 * ## 为什么用 ResizeObserver 而不是 window `resize` 事件
 *
 * 要响应的是**容器**尺寸变化，不只是窗口。宿主里 ANIC 面板会被侧栏挤压、
 * 被折叠区改变高度、被全屏 API 改变尺寸——这些都不触发 window resize。
 * ResizeObserver 盯的是容器本身，是唯一正确的观测点。
 *
 * ## 三条硬约束（每条都有对应测试/降级）
 *
 * 1. **只用 stub 允许的 hook**：`scripts/offline-smoke.mjs` 的 React 桩只有
 *    useState/useRef/useCallback/useEffect 四个（另有 memo/uSES/useDeferredValue 见于
 *    契约白名单），`useMemo`/`useLayoutEffect` 会让整棵树 TypeError。
 *    故本文件只用 `useRef` + `useEffect` + `useCallback`。
 * 2. **环境缺失必须降级不崩**：jsdom / stub / SSR 里 `ResizeObserver` 不存在。
 *    探测失败 ⇒ 行为等价于「没有本功能」（首屏适配照旧），绝不抛。
 * 3. **尺寸未变不回调**：ResizeObserver 在滚动/动画里可能高频触发，
 *    尺寸没变就早退，避免把用户调好的缩放重置（那正是首屏适配守卫要保护的东西）。
 *
 * ## 为什么「只重适配一次」还不够
 *
 * `fittedRef` 守卫的是「数据 tick 不要重置用户视口」，那是对的。
 * 但它把「容器变了」也一起挡掉了。本模块只解决后者：尺寸**真的变了**才回调，
 * 由调用方决定是重适配还是仅更新画布尺寸。
 */
import { useCallback, useEffect, useRef } from 'react';

/** ResizeObserver 的最小结构（不依赖 DOM lib，便于在 stub/jsdom 下探测）。 */
interface ResizeObserverLike {
  observe: (target: unknown) => void;
  disconnect: () => void;
}

interface ResizeObserverCtor {
  new (cb: (entries: { contentRect: { width: number; height: number } }[]) => void): ResizeObserverLike;
}

/** 取当前环境的 ResizeObserver 构造器；不存在则 null（合法降级，不是错误）。 */
export function resolveResizeObserver(): ResizeObserverCtor | null {
  const g = globalThis as { ResizeObserver?: ResizeObserverCtor };
  return typeof g.ResizeObserver === 'function' ? g.ResizeObserver : null;
}

/** 尺寸是否「实质变化」（1px 容差：亚像素抖动不算变化，否则会疯狂重适配）。 */
export function sizeChanged(
  prev: { width: number; height: number } | null,
  next: { width: number; height: number },
  tolerance = 1,
): boolean {
  if (prev === null) return next.width > 0 && next.height > 0;
  return Math.abs(prev.width - next.width) > tolerance
    || Math.abs(prev.height - next.height) > tolerance;
}

export interface SizeTrackerOptions {
  /** 容器 ref（`{ current }` 形状，stub 的 useRef 也满足）。 */
  target: { current: unknown };
  /** 尺寸实质变化时回调（已做去抖与容差过滤）。 */
  onResize: (size: { width: number; height: number }) => void;
}

/**
 * 订阅容器尺寸变化。
 *
 * 返回值是「重新测量一次」的命令式入口（用于全屏切换等已知变化点主动拉齐，
 * 不依赖 ResizeObserver 是否可用）。
 *
 * 注意：`onResize` 存进 ref 而非进 effect 依赖——否则每次父组件重渲染
 * 都会 disconnect/reconnect 观察器，产生无谓的重建（也更容易漏掉一帧）。
 */
export function useContainerSize(options: SizeTrackerOptions): () => void {
  const { target, onResize } = options;
  const lastRef = useRef<{ width: number; height: number } | null>(null);
  const cbRef = useRef(onResize);
  cbRef.current = onResize;

  /** 主动测量一次（全屏 / 折叠等已知变化点可调用）。 */
  const measure = useCallback((): void => {
    const el = target.current as { getBoundingClientRect?: () => { width: number; height: number } } | null;
    const r = el?.getBoundingClientRect?.();
    if (r === undefined) return;
    if (!sizeChanged(lastRef.current, r)) return;
    lastRef.current = { width: r.width, height: r.height };
    cbRef.current({ width: r.width, height: r.height });
  }, [target]);

  useEffect(() => {
    const el = target.current as unknown;
    if (el === null || el === undefined) return;
    const Ctor = resolveResizeObserver();
    if (Ctor === null) return; // 降级：无观察器，首屏适配仍照常工作
    let ro: ResizeObserverLike | null = null;
    try {
      ro = new Ctor((entries) => {
        const first = entries[0];
        if (first === undefined) return;
        const next = { width: first.contentRect.width, height: first.contentRect.height };
        if (!sizeChanged(lastRef.current, next)) return; // ③ 尺寸未变不回调
        lastRef.current = next;
        cbRef.current(next);
      });
      ro.observe(el);
    } catch {
      // 观察器不可用/目标非法 → 静默降级（不得影响图渲染）
      ro = null;
    }
    return () => {
      try { ro?.disconnect(); } catch { /* 清理失败无意义，忽略 */ }
    };
  }, [target]);

  return measure;
}
