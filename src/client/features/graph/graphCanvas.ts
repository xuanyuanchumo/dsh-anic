/**
 * svg 画布装配（cycle-83 · V 战线，从 renderGraph.ts 拆出以满足 250 行纪律）。
 *
 * 拆分的界线是职责：`renderGraph.ts` 负责「数据 → 布局 → 元素集合」，
 * 本文件负责「这些元素怎么装进一张 svg」（画布尺寸 / viewBox / role / 键盘 /
 * 小地图挂载点）。这条界线一句话能说清，拆开就不会造成"为凑行数而割裂"。
 *
 * ## 两种画布形态，几何上都**无畸变**（viewBox 与画布像素 1:1），只是原点不同
 *
 * - 静态态（未传 size，smoke / 纯渲染测试走这条）：画布 = 世界包围盒，viewBox
 *   带包围盒原点（minX 为负，含 padding），与 cycle-82 的几何逐像素一致；
 * - 交互态（传了 size）：画布 = 可视区，viewBox = `0 0 W H`，世界 → 屏幕**全部**
 *   由 `<g transform>` 表达。这样放大后超出视口的部分被 CSS `overflow:hidden`
 *   裁掉是**正确行为**（视口的定义就是"能看到的那一块"），而不是被 svg 自身的
 *   宽高意外裁掉 —— 后者会让"放大"看起来像"只能看到中间一块"。
 *
 * ## 小地图只挂在交互态
 *
 * 小地图需要 `size`（屏幕坐标）才有意义：静态态的画布本身就是整张图，
 * 画一个"整张图的小地图"是纯噪声。所以它随 `opts.size` 一起出现。
 */
import { createElement, type ReactElement } from 'react';
import type { GraphBounds, GraphLayout } from './graphLayout.ts';
import type { Viewport } from './graphViewport.ts';
import { clampScale, transformOf } from './graphViewport.ts';
import { renderMiniMap } from './graphMiniMap.ts';
import { graphKeyDown } from './graphKeyboard.ts';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

export interface CanvasInput {
  world: ReactElement;
  children: ReactElement[];
  bounds: GraphBounds;
  layout: GraphLayout;
  viewport: Viewport;
  size: { width: number; height: number } | undefined;
  containerInteractive: boolean;
  describedBy: string | undefined;
  keyHandler: ((ev: { key: string; preventDefault: () => void }) => void) | undefined;
  nodeCount: number;
  edgeCount: number;
  focusId: string | null;
}

export function renderCanvas(input: CanvasInput): ReactElement {
  const {
    world, children, bounds, layout, viewport, size,
    containerInteractive, describedBy, keyHandler, nodeCount, edgeCount, focusId,
  } = input;

  const canvas = size === undefined
    ? { width: bounds.width, height: bounds.height, viewBox: [bounds.minX, bounds.minY, bounds.width, bounds.height].join(' ') }
    : { width: size.width, height: size.height, viewBox: `0 0 ${String(size.width)} ${String(size.height)}` };

  // 小地图只在交互态出现（见文件头）。它是 world 的**兄弟**：固定屏幕右下角，
  // 不随缩放平移移动 —— 那正是地图控件的定义。
  const overlay = size === undefined
    ? null
    : renderMiniMap({ nodes: layout.nodes, bounds, viewport, size, focusId });

  return createElement('svg', {
    width: canvas.width,
    height: canvas.height,
    viewBox: canvas.viewBox,
    // P1-2/P1-3：容器是唯一 Tab 停靠点；role=group（可交互组）/ img（纯图）；
    // aria-label 携带规模信息（节点/边数），键盘操作说明在 <desc>。
    'data-anic-graph': 'true',
    // 当前比例进 DOM：比例读数是异步交互的结果，没有可断言的状态就只能靠肉眼。
    'data-anic-graph-scale': String(clampScale(viewport.scale)),
    // 包围盒进 DOM：布局压缩率是本轮验收线，测试直接读它，不必自己重算布局。
    'data-anic-graph-bounds': `${String(bounds.minX)} ${String(bounds.minY)} ${String(bounds.width)} ${String(bounds.height)}`,
    role: containerInteractive ? 'group' : 'img',
    tabIndex: containerInteractive ? 0 : undefined,
    'aria-label': t('panel.graphLabel', { nodes: nodeCount, edges: edgeCount }),
    // 交互态才有关联的说明元素（静态态下没有那个 <p>，挂上去就是悬空引用）。
    'aria-describedby': describedBy,
    // 键盘：方向键 roving（graphKeyDown，既有契约）与交互态的 +/−/0/Escape
    // **合并到同一个 svg 处理器**。两个处理器作用键集不重叠（方向键 vs 缩放键），
    // 顺序上先跑 roving 再跑缩放——roving 对非方向键直接 return，不会误吞。
    onKeyDown: containerInteractive
      ? (ev: Parameters<typeof graphKeyDown>[0]) => {
          graphKeyDown(ev);
          keyHandler?.(ev);
        }
      : undefined,
    style: { background: token('anic-surface'), fontFamily: 'monospace', display: 'block' },
  }, overlay === null ? children.concat([world]) : children.concat([world, overlay]));
}

/** world `<g>` 的 transform 表达式（转出，供渲染与断言复用同一形态）。 */
export { transformOf };
