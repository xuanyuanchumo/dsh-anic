/**
 * 悬浮预览的状态与延迟揭示（cycle-84 从 GraphInteractive 抽出）。
 *
 * ## 为什么现在可以抽（cycle-83 的注释说"不抽"，这里改了主意，理由如下）
 *
 * cycle-83 拒绝抽 hook 的理由是「`graphInteractiveContract ⑦` 的 stub-hooks 守卫
 * 按固定文件名清单扫，新文件里的 `useXxx` 会被判成未列入允许集」。cycle-84 已把
 * 扫描域改成**递归全目录**（`GRAPH_FILES` 由 readdir 遍历 `features/graph/` 生成），
 * 新文件的 hook 定义会进 `LOCAL_HOOKS` 白名单；而本文件的实现体只用到
 * `useState / useRef / useCallback / useEffect` —— smoke 桩全部支持。
 * 结论：抽出来的前提已经成立，而 `GraphInteractive` 已到 338 行（250 行纪律红线），
 * 不抽就要靠删注释凑数，那是把纪律变成装饰。
 *
 * ## 延迟揭示的三个必做动作
 *
 * ① 换焦点先取消上一个计时器（否则快速划过时上一个节点会在 120ms 后弹出，盖住
 *    刚停下的那个）；② 立刻收起当前预览（视觉上跟手）；③ 焦点非空才计时
 *    （`tooltipDelay` 在 reduced-motion 下返回 0 ⇒ 同步揭示）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import { canonicalVerdict } from './gateColors.ts';
import { scheduleReveal, tooltipDelay, tooltipModelOf, type TooltipModel } from './graphTooltip.ts';
import { prefersReducedMotion } from './graphInteractiveParts.ts';

export interface GraphTooltipInput {
  nodes: readonly WorkflowNode[];
  verdicts: Map<string, string> | undefined;
  /** 邻居数表（预览要显示"几条关系"）。 */
  adjacency: Map<string, Set<string>>;
  /** 当前焦点节点 id（null = 无）。 */
  focusId: string | null;
}

export interface GraphTooltipState {
  tooltip: TooltipModel | null;
  /** 取消挂起的揭示计时器（组件卸载/退出模式时调用）。 */
  cancelPending: () => void;
}

export function useGraphTooltip(input: GraphTooltipInput): GraphTooltipState {
  const { nodes, verdicts, adjacency, focusId } = input;
  /** 预览卡模型（null = 不显示）。 */
  const [tooltip, setTooltip] = useState<TooltipModel | null>(null);
  /** 延迟计时器（快速移动与 unmount 时都要能取消 —— 否则会留下一发"幽灵预览"）。
   *  存的是 `scheduleReveal` 返回的**取消函数**（`() => void`），不是计时器句柄。 */
  const timerRef = useRef<(() => void) | null>(null);

  const cancelPending = useCallback((): void => {
    timerRef.current?.();
    timerRef.current = null;
  }, []);

  const reveal = useCallback((id: string): void => {
    const node = nodes.find((n) => n.id === id);
    if (node === undefined) return;
    setTooltip(tooltipModelOf(
      node,
      canonicalVerdict(verdicts?.get(node.id) ?? node.result),
      adjacency.get(node.id)?.size ?? 0,
    ));
  }, [nodes, verdicts, adjacency]);

  useEffect(() => {
    cancelPending();
    setTooltip(null);
    if (focusId === null) return;
    const delay = tooltipDelay(prefersReducedMotion());
    if (delay <= 0) {
      reveal(focusId);
      return;
    }
    timerRef.current = scheduleReveal(() => { reveal(focusId); }, delay);
    return () => { timerRef.current?.(); timerRef.current = null; };
  }, [focusId, cancelPending, reveal]);

  return { tooltip, cancelPending };
}
