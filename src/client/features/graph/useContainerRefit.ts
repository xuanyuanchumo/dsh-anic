/**
 * 图区「适配生命周期」接线（cycle-104）。
 *
 * ## 为什么单独成文件（不是为了凑行数）
 *
 * `GraphInteractive.ts` 已贴 T3 硬限（250 行，`objectiveConformanceContract ⑪` /
 * `truthAudit T3_structure` 双向钉死）。cycle-104 要加「容器变化 → 重适配」，
 * 直接把 hook 调用写进去会撑到 266 行——**守卫立刻红**（实测正是如此）。
 *
 * 面对超限有两条路：
 *   ✗ 删注释腾空间 —— 本仓明文禁止：注释承载的是判据，删掉等于扔掉知识，
 *     后来人会重新踩同一个坑（cycle-95 已就同类情况做过裁决）；
 *   ✓ 把职责整体迁出 —— 本文件承接「什么时候该适配」这一整件事。
 *
 * 拆分的界线是**职责**：本文件回答「何时 fit」，`GraphInteractive` 只回答
 * 「状态怎么装配」。而且这两件事本来就是同一个关注点——分开写反而更乱：
 * 首屏 fit 与 resize fit 必须共享同一套「别踩用户」的纪律。
 *
 * ## 两条纪律（各有明确理由）
 *
 * ### ① 首屏只适配一次：数据 tick 不得重置用户视口
 *
 * 图每 2s 轮询换 `nodes` 引用。若每次重渲染都 fit，用户刚调好的缩放/平移
 * 会被反复打回原点——图永远「自己动」，没法看。故用 ref 守卫只跑一次。
 *
 * ### ② 容器尺寸实质变化必须重新适配（cycle-104 修的缺陷）
 *
 * 改造前全仓 `grep -rn "ResizeObserver" src/client/` **零命中**，而 ① 的守卫
 * 把「容器变了」也一起挡掉了。实测后果：面板折叠、窗口缩放、进入全屏之后，
 * 图仍停在按旧尺寸算出的视口里（详见 `.cycles/cycle-104-evidence/baseline-findings.md` §5）。
 *
 * ① 与 ② 观测对象不同（**数据**引用 vs **容器**尺寸），故不冲突：
 * 数据刷新不改变容器尺寸 ⇒ 不触发 ②；容器变化 ⇒ 说明用户环境变了，该重看全图。
 *
 * ## 策略：尺寸变化为何 doFit 而不是保持缩放比例
 *
 * 两种可选语义：
 *   A. 保持用户当前缩放/平移，只改可视区大小；
 *   B. 重新 fit 到整个图。
 *
 * 选 B：容器变化的典型来源是**面板折叠/展开、全屏切换、窗口缩放**——都是
 * 「用户想重新看全图」的信号。若选 A，面板收窄后用户看到被裁掉一半的图，
 * 还得手动按「适配视图」，一步变两步；极端情况下还会留下「图完全在视口外」的空白态。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useContainerSize } from './useContainerSize.ts';

export interface FitLifecycleOptions {
  /** 视口容器 ref（`{ current }` 形状；stub 的 useRef 同样满足）。 */
  target: { current: unknown };
  /** 适配到全图（即 `gestures.doFit`）。引用变化时会重新订阅。 */
  doFit: () => void;
}

/**
 * 装配「首屏适配一次 + 容器变化重适配」。
 *
 * 兼容性：恢复分键视图态的 effect 声明在 `useGraphInteraction` 里，比这里
 * 更早注册 ⇒ 更早执行，所以有存过的项目不会被首屏适配顶掉（cycle-95 语义，原地保留）。
 *
 * 返回命令式测量入口：全屏切换等**已知**变化点可主动调用，
 * 不依赖 ResizeObserver 是否可用（宿主/测试环境可能没有）。
 */
export function useFitLifecycle(options: FitLifecycleOptions): () => void {
  const { target, doFit } = options;

  // ① 首屏只适配一次（见文件头「纪律 ①」）
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    doFit();
  }, [doFit]);

  // ② 容器尺寸变化 → 重适配（见文件头「纪律 ②」）
  const onResize = useCallback((): void => {
    doFit();
  }, [doFit]);
  return useContainerSize({ target, onResize });
}
