/**
 * 图谱搜索与跳转（cycle-85 从 GraphInteractive 抽出）——命中、游标、居中。
 *
 * ## 为什么"跳转"必须用布局坐标
 *
 * 布局会把节点重新排布（变尺寸卡片 + 分列），而 `nodes` 里的 `x/y` 是**快照坐标**。
 * 拿快照坐标跳转 = 跳到一片空白——cycle-82 初版踩过这个坑（见 graphLayout 头注）。
 * 所以本 hook 收 `layoutNodes` 而不是 `nodes` 来找目标位置。
 *
 * ## 为什么游标要取模循环
 *
 * 169 节点里搜 "gate" 命中上百条：`↑` 到顶后如果不动，用户会以为"没有更多"。
 * 取模让首尾相接，长列表里少一次"我再按几下试试"的困惑。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `useState` + `useCallback` 两个，smoke 桩全支持（见 GraphInteractive 文件头）。
 * 抽成 hook 的前提与 `useGraphTooltip` 相同：cycle-84 起图区扫描域是**递归全目录**，
 * 新文件的 hook 定义自动进 `LOCAL_HOOKS` 白名单。
 */
import { useCallback, useState } from 'react';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { PositionedNode } from './graphLayout.ts';
import { matchNodes } from './graphTrace.ts';
import { centerOnWorld, type Viewport } from './graphViewport.ts';

/** 命中列表上限（有界：上百条全列出来是噪声）。 */
export const SEARCH_MATCH_LIMIT = 6;

export interface GraphSearchInput {
  nodes: readonly WorkflowNode[];
  /** 布局后的节点（跳转要用布局坐标，见文件头）。 */
  layoutNodes: readonly PositionedNode[];
  /** 当前查询串（受控）。 */
  query: string;
  sizeOf: () => { width: number; height: number };
  viewport: Viewport;
  setViewport: (next: Viewport) => void;
  setFocusId: (id: string | null) => void;
}

export interface GraphSearchState {
  matches: WorkflowNode[];
  total: number;
  /** 当前游标（无命中时恒 0）。 */
  activeMatch: number;
  /** ↑/↓ 移动游标（+1/-1，取模循环）。 */
  moveMatch: (delta: number) => void;
  /** 跳到某 id（居中并置焦点）。 */
  jumpTo: (id: string) => void;
  /** Enter：跳到游标所指命中。 */
  jumpActive: () => void;
}

export function useGraphSearch(input: GraphSearchInput): GraphSearchState {
  const { nodes, layoutNodes, query, sizeOf, viewport, setViewport, setFocusId } = input;
  const [cursor, setCursor] = useState(0);
  const { matches, total } = matchNodes(nodes, query, SEARCH_MATCH_LIMIT);
  const activeMatch = matches.length === 0 ? 0 : Math.min(cursor, matches.length - 1);

  const moveMatch = useCallback((delta: number): void => {
    setCursor((cur) => {
      const len = matches.length;
      if (len === 0) return 0;
      return (Math.min(cur, len - 1) + delta + len) % len;
    });
  }, [matches.length]);

  const jumpTo = useCallback((id: string): void => {
    const target = layoutNodes.find((n) => n.id === id);
    if (target === undefined) return;
    // 卡片原点是左缘 + 垂直中心（见 graphNodeCard 的 coordinate 约定）。
    const vp = centerOnWorld({ x: target.x + target.w / 2, y: target.y }, sizeOf(), viewport);
    setViewport(vp);
    setFocusId(id);
  }, [layoutNodes, sizeOf, viewport, setViewport, setFocusId]);

  const jumpActive = useCallback((): void => {
    const target = matches[activeMatch] ?? matches[0];
    if (target !== undefined) jumpTo(target.id);
  }, [matches, activeMatch, jumpTo]);

  return { matches, total, activeMatch, moveMatch, jumpTo, jumpActive };
}
