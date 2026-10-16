/**
 * 图区键盘导航（APG roving tabindex，P1-2）。
 *
 * ## 为什么不能给每个节点 tabIndex=0
 *
 * 169 个节点 × tabIndex=0 = 169 个 Tab 停靠点：键盘用户要按 169 次 Tab 才能
 * 穿过图区（APG grid/listbox 模式明确反对）。roving tabindex 的正确形态：
 * **容器**持有唯一 tabIndex=0，节点全部 -1，方向键/Home/End 经 focus() 移动。
 * Tab 语义 = 进出整组（一次进入、一次离开），组内移动交给方向键。
 *
 * ## 实现约束：无状态纯函数
 *
 * renderGraph 是纯渲染（React 元素树，smoke 直接断言），不能持有"当前焦点节点"
 * 状态。好在焦点本身就是 DOM 的运行时状态：从 ev.currentTarget（svg）查询
 * 节点集合、用 ev.target 定位当前焦点，即可无状态完成导航。
 */
export interface GraphKeyboardEvent {
  key: string;
  preventDefault: () => void;
  /** svg 容器（事件挂载点）——从中查询节点集合。 */
  currentTarget: { querySelectorAll(sel: string): ArrayLike<GraphFocusable> };
  /** 当前焦点元素（某个节点 g，或 svg 自身）。 */
  target: unknown;
}

export interface GraphFocusable {
  focus(): void;
}

/** 方向键导航：ArrowRight/Down → 下一节点；ArrowLeft/Up → 上一；Home/End → 首尾。 */
export function graphKeyDown(ev: GraphKeyboardEvent): void {
  const navKeys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
  if (!navKeys.includes(ev.key)) return;
  const nodes = Array.from(ev.currentTarget.querySelectorAll('[data-anic-node]'));
  if (nodes.length === 0) return;
  // 吃掉默认行为（方向键在本该滚动页面的语境里会滚动）；Tab 不在此列——
  // 键盘用户必须能离开图区（graphA11y 契约：Tab/箭头不得被节点级处理器吃掉）。
  ev.preventDefault();
  const idx = nodes.indexOf(ev.target as GraphFocusable);
  let next = 0;
  if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = nodes.length - 1;
  else if (idx < 0) next = 0; // 焦点在 svg 自身（刚 Tab 进来）→ 从第一个节点开始
  else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % nodes.length;
  else next = (idx - 1 + nodes.length) % nodes.length; // 环绕：第一个的 Left → 最后一个
  nodes[next]?.focus();
}
