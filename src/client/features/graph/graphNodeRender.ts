/**
 * 节点/边的视觉渲染门面（cycle-82 建立 · cycle-83 拆成三个域文件）。
 *
 * ## 为什么本文件只剩转出口
 *
 * cycle-82 把"一个节点画成什么"与"一条边画成什么"放在同一个 202 行文件里。
 * cycle-83 要给节点加卡片 + 两行标签，给边加六种线型 + 贝塞尔，两件事各自都会
 * 触到 250 行纪律（`truthAuditChecks` 的机械扫描项）。拆分的界线依然是**职责**：
 *   - `graphNodeStyle.ts`：视觉语言（颜色 / 线型 / 卡片几何 / 截断）—— "什么样子"；
 *   - `graphNodeCard.ts`：一个节点的元素构成 —— "哪几个元素"；
 *   - `graphEdgeRender.ts`：一条边的元素构成 + 线型表 + 路径几何。
 *
 * 本文件保留全部既有导出名（`renderNode` / `renderEdge` / `renderArrowMarker` /
 * `typeColorOf` / 两个入参接口），因此 `renderGraph.ts`、`graphToolbar.ts` 与所有
 * 契约测试的 import 面**零变更**——转出口是最小扰动的做法（本仓 `runtime/hotReload.ts`
 * 与 `tokens.ts` 转出 `shellTheme` 用的是同一形状）。
 *
 * ## 注意：新文件必须进 `graphInteractiveContract` ⑦ 的扫描集
 *
 * 那条 stub-hooks 源码守卫按**固定文件名清单**扫描。新文件若不在清单里，等于给它们
 * 开了后门（守卫永远绿）。清单由 Lead 维护，本文件拆出时已同步告知。
 */
export {
  renderEdge,
  edgeStyleOf,
  edgePath,
  renderArrowMarker,
  EDGE_STYLES,
  DEFAULT_EDGE,
  type EdgeStyle,
  type EdgeRenderInput,
} from './graphEdgeRender.ts';

export { renderNode, metaLabelOf, type NodeRenderInput } from './graphNodeCard.ts';

export {
  colorOf,
  typeColorOf,
  VERDICT_SHAPE,
  fitLabel,
  displayWidth,
  CARD_RADIUS,
  BAR_W,
  LABEL_MAX,
} from './graphNodeStyle.ts';
