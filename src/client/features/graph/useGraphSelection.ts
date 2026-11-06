/**
 * 选区状态壳（cycle-109 · U1 + U3）——**本文件回答**："钉住谁、多选了谁、一次点击该发什么动作"。
 *
 * ## 为什么 pin 与 selectedIds 是**一个** hook（J 方案合并实施）
 *
 * J §3 U1 原计划单独一个 `useGraphPin`，U3 再加 `useState<string[]>`。两者一起
 * 落地时 `GraphInteractive` 会 +14 行，而它当时已 236 行（T3 硬限 250，且
 * `truthAuditChecks` 用 `split('\n').length` 计数，尾部换行也算一行）。合并后
 * 组件只多一行 `const selection = useGraphSelection();`。
 *
 * 语义上这也**确实**是一件事：钉住 = 选中集的最后一项（`pinnedIdOf`）。分开存会出现
 * 两个真相——单选替换后 `pinnedId` 还指着旧节点，于是卡片强调 A 而选中集只有 B。
 *
 * ## 动作边界
 *
 * 本 hook 只回答"集合怎么变"，不回答"点击还会顺便干什么"：
 * 打开详情抽屉（面板回调）与路径模式下改写点击语义（`useGraphInteraction`）
 * 都在装配层，因为那是**交互裁决**，不是状态转移。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `useState` / `useCallback`——`scripts/offline-smoke.mjs` 的 React 桩只提供七个 API
 * （`graphInteractiveContract` ⑦ 在源码层钉死这条）。本文件的两个导出函数
 * 都只落到这两个 API 上。
 */
import { useCallback, useState } from 'react';
import {
  EMPTY_SELECTION, isSelectedOf, isMultiSelectOf, pinnedIdOf, selectionReducerOf,
  type ModKeyState, type SelectionAction, type SelectionState,
} from './graphSelection.ts';

/** 组件拿到的选区面（状态读 + 两个动作）。 */
export interface GraphSelection {
  /** 选中集（顺序 = 点选顺序）。 */
  ids: readonly string[];
  /** 钉住节点 = 选中集最后一项（null = 未钉住）。 */
  pinnedId: string | null;
  /** 上一次切换是否因上限被拒（读数条据此说明原因）。 */
  limitHit: boolean;
  /** 节点点击（`mods` 含 Ctrl/Cmd ⇒ 切换；否则单选替换）。 */
  onNodeSelect: (id: string, mods?: ModKeyState) => void;
  /** 清空选中集（Escape / 清空筛选走这条）。 */
  clear: () => void;
  /** 某项是否在选中集里（渲染层与断言共用同一判据）。 */
  isSelected: (id: string) => boolean;
}

/** 选区状态与动作（`useState` 初值为空集：首屏可渲染，不需要外部注入）。 */
export function useGraphSelection(): GraphSelection {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  /**
   * 点击入口（鼠标与键盘共用）。
   *
   * 为什么 `setState` 走函数式：数据 2s 一轮询会重渲，闭包里捕获的 `state`
   * 可能已经过两次点击——用旧快照算下一状态会静默丢一次选中。
   */
  const onNodeSelect = useCallback((id: string, mods?: ModKeyState): void => {
    const action: SelectionAction = isMultiSelectOf(mods)
      ? { kind: 'toggle', id }
      : { kind: 'only', id };
    setState((cur) => selectionReducerOf(cur, action));
  }, []);

  const clear = useCallback((): void => { setState(EMPTY_SELECTION); }, []);
  const isSelected = useCallback((id: string): boolean => isSelectedOf(state, id), [state]);

  return {
    ids: state.ids,
    pinnedId: pinnedIdOf(state),
    limitHit: state.limitHit,
    onNodeSelect,
    clear,
    isSelected,
  };
}