/**
 * 路径选择模式的 **hook 外壳**（cycle-95 · WS-C）——状态 + 三个动作，逻辑全在纯函数里。
 *
 * ## 为什么状态在这里而不是 `GraphInteractive`
 *
 * `GraphInteractive.ts` 已 248 行（250 是机械硬限）。路径模式的三个 useState /
 * useCallback 若内联进去，必须删注释才能容纳 —— 而"删注释腾行数"正是本仓
 * `objectiveConformanceContract ⑪` 想拦住的那种退化（注释是判据的载体）。
 * 拆出来的界线仍是**职责**：本文件回答「谁来选端点、端点怎么转移」，
 * 组件回答「这些状态喂给谁」。
 *
 * ## 为什么端点转移全部走 `graphPathMode` 的纯函数
 *
 * 键盘（Enter/Space）与鼠标（click）**必须**走同一个转移函数。各写一份的话，
 * 键盘用户会得到一套不一样的行为（"鼠标点两下能换终点，键盘不能"），
 * 而这类差异任何截图验收都看不出 —— 这正是本仓反复记的 a11y 教训。
 * 纯函数的另一层收益是：转移可被穷举断言，不必真挂组件模拟两次点击。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供七个 API（无 `useMemo` /
 * `useReducer`）。本文件只用 `useState / useCallback`。
 */
import { useCallback, useState } from 'react';
import type { TraceAdjacency } from './graphTrace.ts';
import {
  PATH_IDLE, pathExitOf, pathModelOf, pathPickOf, togglePathOf,
  type PathModel, type PathSelection,
} from './graphPathMode.ts';

/** 入参：正/反邻接表（由组件按 edges 引用缓存后传入，不在此再建一份）。 */
export interface GraphPathModeInput {
  adjacency: TraceAdjacency;
}

/** 路径模式的对外形状（组件只做装配）。 */
export interface GraphPathMode {
  selection: PathSelection;
  model: PathModel;
  /** 进入/退出模式（工具栏按钮走这条）。 */
  toggle: () => void;
  /** 在节点上选端点（点击与 Enter/Space **同一个**入口）。 */
  pick: (id: string) => void;
  /** 退出模式（Escape / 状态条退出按钮）。 */
  exit: () => void;
}

/**
 * 路径选择模式的 hook。
 *
 * 模式未开启时 `model` 是空模型（`active: false`），渲染层据此不渲染状态条 ——
 * **零占位**，与追溯状态条同一纪律（未启用时整条不出现，不改变既有布局）。
 */
export function useGraphPathMode(input: GraphPathModeInput): GraphPathMode {
  const [selection, setSelection] = useState<PathSelection>(PATH_IDLE);

  const toggle = useCallback((): void => {
    setSelection((cur) => togglePathOf(cur));
  }, []);

  const pick = useCallback((id: string): void => {
    // 函数式更新：两次快速点击（连点两个节点）之间不会有陈旧状态。
    setSelection((cur) => pathPickOf(cur, id));
  }, []);

  const exit = useCallback((): void => {
    setSelection((cur) => pathExitOf(cur));
  }, []);

  return { selection, model: pathModelOf(selection, input.adjacency), toggle, pick, exit };
}
