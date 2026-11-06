/**
 * 选区解析（cycle-109 · U1）——**本文件回答**：鼠标移开之后，"正在看谁"由谁决定。
 *
 * ## 为什么优先级必须收进一个纯函数
 *
 * 改造前全图只有一条选区通道 `focusId`，而它被**悬停**独占：`graphStage` 的悬停
 * 代理在 `pointerout` 时无条件清空。于是"点一下把它钉住，再去点工具栏"在物理上
 * 做不到——鼠标一移开，影响半径读数与"缩放到选中"的可用性一起消失（鼠标只有
 * 一根指针）。
 *
 * U1 把一条通道拆成两条之后，优先级的**唯一**决定点必须是可单测的纯函数：
 * 分散在组件 / 舞台 / 画布三处各写一次 `pinned ?? hover`，迟早就有一处写成
 * `hover ?? pinned`，而那种错误在任何 DOM 断言里都表现为"看起来正常"。
 *
 * ## 两条通道不是同一件事（这就是它值得一个文件的原因）
 *
 * - `highlightFocusId` = **钉住优先**：回答"用户选定了谁"。邻域高亮、影响半径
 *   读数、缩放到选中、卡片强调描边都以它为准。钉住是**显式动作**（点击），
 *   悬停只是"临时看一眼"，所以悬停不许盖掉钉住。
 * - `tooltipFocusId` = **只看悬停**：预览卡回答"指针此刻压在谁上面"。刻意
 *   **不并**钉住：若预览也跟着钉住存活，`pointerout` 之后卡片会永久停在屏幕上
 *   （`graphVisualUpgradeContract` ③「pointerleave 后预览消失」会红），而那条
 *   契约保护的是真实体验——一张永久悬浮的预览盖住它下面的图。
 *
 * ## 反例（本文件的反向自检对象）
 *
 * 写成 `hoverId ?? pinnedId` 时，`{pinned:'a', hover:'b'}` 把高亮判给 b：
 * 用户在 a 上点了钉住，鼠标扫过 b 的瞬间读数跳成 b 的——钉住等于没发生。
 */

/** 两条选区的输入（组件持有两个状态，本函数只做解析）。 */
export interface SelectionFocusInput {
  /** 钉住节点（显式点击；null = 未钉住）。 */
  pinnedId: string | null;
  /** 悬停 / 键盘聚焦节点（临时；null = 指针不在节点上）。 */
  hoverId: string | null;
}

/** 解析结果（两条通道各自一个值，消费方不得互相顶替）。 */
export interface SelectionFocus {
  /** 邻域高亮 / 影响半径 / 缩放到选中 用的焦点（钉住优先）。 */
  highlightFocusId: string | null;
  /** 预览卡用的焦点（**只**看悬停，不并钉住）。 */
  tooltipFocusId: string | null;
}

/**
 * 解析两条选区（纯函数：同一输入两次调用深相等）。
 *
 * @param input 钉住与悬停状态
 */
export function resolveSelectionOf(input: SelectionFocusInput): SelectionFocus {
  return {
    highlightFocusId: input.pinnedId ?? input.hoverId,
    tooltipFocusId: input.hoverId,
  };
}