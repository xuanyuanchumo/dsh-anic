/**
 * usePolledSection —— 分区数据轮询 hook（P2 修复，真机 cycle-11 发现）。
 *
 * org / flows 两个分区此前只在面板挂载 / 手动刷新时拉一次（fetchLive 一次性
 * Promise.all）——流程状态机是「正在发生的转移」，静态渲染违背动态白盒主叙事
 * （POST 后面板 6s 仍显示旧态，真机复现）。
 *
 * 语义：mount / reloadKey 变化 → 立即首拍（覆盖挂载与手动刷新）；
 * intervalMs > 0 → setInterval 轮询（autoRefresh 关闭时传 0，退化为仅首拍）。
 * fetchJsonGuarded：非 2xx / 网络失败 / 形状不符 → null（分区不渲染，不伪造）。
 */
import { useEffect, useRef } from 'react';
import { fetchJsonGuarded } from './fetchJson.ts';

export interface PolledTarget {
  url: string;
  guard: (v: unknown) => boolean;
  apply: (v: unknown) => void;
}

export function usePolledSection(targets: PolledTarget[], intervalMs: number, reloadKey: number, getHeaders: () => Record<string, string>): void {
  // targets 每次渲染都是新数组（含内联 apply 闭包）——ref 持最新引用，
  // effect 依赖保持 [intervalMs, reloadKey]（setState 函数引用稳定，闭包安全）
  const ref = useRef(targets);
  ref.current = targets;
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      for (const t of ref.current) {
        fetchJsonGuarded(t.url, (v): v is unknown => t.guard(v), getHeaders()).then((v) => { if (!cancelled && v !== null) t.apply(v); });
      }
    };
    tick();
    if (intervalMs <= 0) return () => { cancelled = true; };
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, reloadKey]);
}
