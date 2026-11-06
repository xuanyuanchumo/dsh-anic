/**
 * 多选集合的状态机（cycle-109 · U3）——**本文件回答**："Ctrl/Cmd+点击之后，选中集怎么变"。
 *
 * ## 为什么是 reducer 而不是三处内联三元
 *
 * "点一下替换 / 按住修饰键切换"这条语义同时出现在三处消费面：节点点击、
 * 对比面板的列顺序、钉住态（= 选中集最后一项）。各写一份内联实现时，改一处
 * 忘了另一处就会出现"chip 能取消、节点不能取消"这种只有用户点得出来的差异。
 * 收进一个纯函数后，"第 9 次点击该发生什么"能在 node 环境逐档断言，不必真挂组件。
 *
 * ## 为什么上限是 8（产品裁决，不是实现细节）
 *
 * 对比面板是一张矩阵（列 = 节点、行 = 5 条属性）。列数超过 8 后窄面板里每列只剩
 * 几个像素——那是"看起来支持多选、实际读不出任何东西"。上限决定第 9 次点击的
 * 形态，所以它必须写在**状态机**里，而不是在渲染层截断（截断会让选中集与
 * 面板列数出现两个真相）。
 *
 * ## 第 9 次点击必须是"拒绝 + 说明"，不是"静默替换"
 *
 * 两种常见实现都错：静默忽略（点了没反应 = 键位坏掉的观感）、挤掉最早的
 * （用户不知道自己丢了哪个）。所以 `limitHit` 进状态，让读数条能说明原因——
 * 与 `graphToolbarTail`「折叠数必显示」同一条纪律：降级要如实。
 */

/** 选中集上限（见文件头「为什么上限是 8」）。 */
export const MAX_SELECTION = 8;

/** 点击时实际读到的修饰键（只取多选需要的两个；React 合成事件结构兼容）。 */
export interface ModKeyState {
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * 是否按住多选修饰键（Ctrl / Cmd）。
 *
 * 为什么 Cmd 与 Ctrl 都认：macOS 的约定是 Cmd，Windows/Linux 是 Ctrl。只认一个
 * 会让一半用户"按了没反应"，而这不是权限或平台差异，是同一语义的两种键位。
 */
export function isMultiSelectOf(mods: ModKeyState | undefined): boolean {
  return mods?.metaKey === true || mods?.ctrlKey === true;
}

/** 选中集动作（三种，语义见 `selectionReducerOf`）。 */
export type SelectionAction =
  | { kind: 'toggle'; id: string }
  | { kind: 'only'; id: string }
  | { kind: 'clear' };

/** 选中集状态（`ids` 顺序 = 点选顺序，最后一项是"最近关注"）。 */
export interface SelectionState {
  ids: readonly string[];
  /** 上一次切换因上限被拒（供读数条说明"为什么点到第 9 个没加进来"）。 */
  limitHit: boolean;
}

/** 空选中集（`useState` 初值必须自足可渲染）。 */
export const EMPTY_SELECTION: SelectionState = { ids: [], limitHit: false };

/**
 * 状态转移（纯函数：不读 clock / 不读 DOM / 不改入参）。
 *
 * - `only`：不按修饰键的点击 = **单选替换**（选中集重置为这一项）；
 * - `toggle`：按住 Ctrl/Cmd = 切换该项（已在则移除，否则追加到末尾）；
 * - `clear`：Escape / 清空筛选时归零。
 *
 * `only` 对"已经单独选中同一项"是**幂等**的（返回同一引用）：数据 2s 轮询会
 * 反复触发重渲染，每次点击都造新数组会让下游缓存判据全部失效。
 */
export function selectionReducerOf(state: SelectionState, action: SelectionAction): SelectionState {
  if (action.kind === 'clear') return EMPTY_SELECTION;
  if (action.kind === 'only') {
    if (state.ids.length === 1 && state.ids[0] === action.id) return state;
    return { ids: [action.id], limitHit: false };
  }
  const at = state.ids.indexOf(action.id);
  if (at >= 0) return { ids: state.ids.filter((x) => x !== action.id), limitHit: false };
  if (state.ids.length >= MAX_SELECTION) return { ids: state.ids, limitHit: true };
  return { ids: [...state.ids, action.id], limitHit: false };
}

/**
 * 钉住节点 = 选中集的**最后一项**（null = 未钉住）。
 *
 * 为什么不单独存一个 `pinnedId`：单选替换后若 pinned 还指着旧节点，屏幕上会
 * 同时出现"卡片强调的是 A"与"选中集里只有 B"——两个真相。顺序即真相。
 */
export function pinnedIdOf(state: SelectionState): string | null {
  return state.ids.length === 0 ? null : state.ids[state.ids.length - 1] ?? null;
}

/** 某项是否在选中集里（渲染层与断言共用同一判据）。 */
export function isSelectedOf(state: SelectionState, id: string): boolean {
  return state.ids.includes(id);
}