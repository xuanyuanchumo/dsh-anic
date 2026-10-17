/**
 * 面板实例唯一 id 生成（B4 组件整合，B5.1 的机制化封装）。
 *
 * 为什么存在：同一页面可挂多个 ANIC 面板实例（多会话宿主），任何写进 DOM 的
 * id（抽屉容器、aria-controls 指向、节点详情 region）都必须实例唯一，否则
 * aria-controls 静默错位——没有任何报错，AT 读出的关联是错的。
 *
 * 为什么不用 React useId()：offline-smoke.mjs 的 stub React 只提供
 * useState/useRef/useCallback/useEffect 四个 hooks（scripts 层的宿主契约，
 * 不可改），useId 会让 smoke 的函数组件展开 TypeError。模块级计数 +
 * 首渲染同步求值，语义等价（实例唯一、稳定、可预测）。
 *
 * 用法（组件体内，首渲染求值一次）：
 *   const seq = usePanelInstanceSeq();      // useRef 惰性初始化
 *   const prefsId = prefsPanelIdOf(seq);
 */
import { useRef } from 'react';

let panelInstanceSeq = 0;

/** 面板实例序号（1 起，模块级递增；组件每挂载一个实例 +1）。 */
export function usePanelInstanceSeq(): number {
  const ref = useRef<number | null>(null);
  if (ref.current === null) {
    panelInstanceSeq += 1;
    ref.current = panelInstanceSeq;
  }
  return ref.current;
}

/** 基础名 + 实例序号 → DOM 安全 id。 */
export function idOf(base: string, seq: number): string {
  return `${base}-${String(seq)}`;
}
