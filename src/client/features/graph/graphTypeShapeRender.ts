/**
 * 类型形状的 **SVG 渲染**（cycle-94）—— 把 `graphTypeShape.shapeOf` 的语义名翻译成
 * `<rect>` / `<path>`。
 *
 * ## 为什么渲染与映射表分两个文件
 *
 * `graphTypeShape.ts` 是**纯映射**（9 个类型 → 9 个语义形状名），可被契约逐条断言，
 * 且零 React 依赖。本文件才引入 `createElement` 与颜色令牌 —— 两者失效模式不同：
 * 映射错了是"两个类型同形"（契约能抓），渲染错了是"形状画不出来/画歪了"
 * （只有 DOM 断言能抓）。
 *
 * ## 硬约束：**不许 `<circle>`**
 *
 * `scripts/offline-smoke.mjs` 与 `graphVisualUpgradeContract.test.ts` 钉死
 *
 * > SVG `<circle>` 数 == 快照节点数
 *
 * 那条不变量守的是「一个节点恰好一个裁决点」。形状图标若用 `<circle>`，
 * 会让 circle 数远超节点数 ⇒ 把一条**真正的不变量**撞红。
 * ⇒ 本文件只用 `<rect>`（含 `rx` 圆角档）与 `<path>`。
 *
 * ## 尺寸档位的来源
 *
 * `SHAPE_TRAITS`（在 `tests/contract/graphTypeShapeContract.test.ts` 里）定义了每个
 * 形状的**视觉特征**（轮廓 / 朝向 / 描边 / 尺寸档）。契约拿它判"两两不同"，
 * 本文件拿它画 —— **同一张表**，所以"契约说不同、渲染画成一个样"不可能发生。
 *
 * 但 `SHAPE_TRAITS` 住在测试里，生产代码不能 import 测试（那会把测试拖进 bundle）。
 * ⇒ 生产侧在这里**重复**一份最小映射（只含渲染需要的 4 个字段），并加一条契约断言
 * 两表一致（`graphTypeShapeContract ④`）。这是"守两处会漂移"的已知代价，
 * 用一条机械断言换掉人工记忆。
 *
 * ## 边界
 *
 * 纯渲染（无状态、无 IO）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { typeColorOf } from './graphNodeRender.ts';
import { shapeOf, type TypeShape } from './graphTypeShape.ts';

/**
 * 渲染特征（生产侧的**唯一**来源；测试侧 `SHAPE_TRAITS` 必须与它逐项一致）。
 *
 * 4 个字段的语义：
 * - `outline`：空心（只描边）vs 实心 —— 7px 尺度上空心/实心是最强的一条通道；
 * - `size`：`small` 比 `full` 小一圈 —— 尺寸差本身可读；
 * - `silhouette`：轮廓族（box / tri / notched / round），决定 path 的骨架；
 * - `orientation`：同族内的第二分辨轴（up 尖朝上 / symmetric 上下对称 / none 无向）。
 */
export interface ShapeRenderTraits {
  outline: boolean;
  size: 'small' | 'full';
  silhouette: 'box' | 'tri' | 'notched' | 'round';
  orientation: 'up' | 'symmetric' | 'none';
}

/** 9 个形状的渲染特征（与 `tests/contract/graphTypeShapeContract.test.ts` 的 `SHAPE_TRAITS` 对应）。 */
export const SHAPE_RENDER_TRAITS: Readonly<Record<TypeShape, ShapeRenderTraits>> = {
  square: { outline: false, size: 'full', silhouette: 'box', orientation: 'none' },
  diamond: { outline: false, size: 'full', silhouette: 'round', orientation: 'symmetric' },
  triangle: { outline: false, size: 'full', silhouette: 'tri', orientation: 'up' },
  chevron: { outline: false, size: 'full', silhouette: 'notched', orientation: 'up' },
  ring: { outline: true, size: 'full', silhouette: 'box', orientation: 'none' },
  star: { outline: true, size: 'full', silhouette: 'round', orientation: 'symmetric' },
  cross: { outline: false, size: 'full', silhouette: 'notched', orientation: 'symmetric' },
  hexagon: { outline: true, size: 'full', silhouette: 'tri', orientation: 'symmetric' },
  dot: { outline: false, size: 'small', silhouette: 'box', orientation: 'none' },
};

/** 形状图标的外接盒（表头色点原本是 3×9 的竖条，此处改为方正的 9×9 图标）。 */
const BOX = 9;

/**
 * 形状 → `<path d>`（在 `0 0 BOX BOX` 坐标系内）。
 *
 * 每条 path 都用手写坐标而不是通用图元（`<polygon>` 也行，但 path 更省 DOM 属性，
 * 且 `cross`（叉）无法用 polygon 表达）。坐标取整到 0.5，避免亚像素抖动。
 */
function pathOf(shape: TypeShape): string | null {
  const s = BOX;
  const m = s / 2;
  switch (shape) {
    case 'diamond': return `M ${m} 0 L ${s} ${m} L ${m} ${s} L 0 ${m} Z`;
    case 'triangle': return `M ${m} 0 L ${s} ${s} L 0 ${s} Z`;
    // 人字：开口朝上的折线（不是闭合面），靠 stroke 画出来。
    case 'chevron': return `M 0 ${s} L ${m} ${s / 3} L ${s} ${s}`;
    case 'star': {
      // 四角星（旋转 45° 的方 + 内缩）—— 5 角星在 9px 尺度上会退化成圆点。
      const q = s / 4;
      return `M ${m} 0 L ${m + q} ${m - q} L ${s} ${m} L ${m + q} ${m + q} L ${m} ${s} L ${m - q} ${m + q} L 0 ${m} L ${m - q} ${m - q} Z`;
    }
    case 'cross': {
      const t = s / 3;
      return `M ${t} 0 L ${m} ${m - t} L ${s - t} 0 L ${s} ${t} L ${m + t} ${m} L ${s} ${s - t} L ${s - t} ${s} L ${m} ${m + t} L ${t} ${s} L 0 ${s - t} L ${m - t} ${m} L 0 ${t} Z`;
    }
    case 'hexagon': {
      const q = s / 4;
      return `M ${q} 0 L ${s - q} 0 L ${s} ${m} L ${s - q} ${s} L ${q} ${s} L 0 ${m} Z`;
    }
    default: return null; // 矩形族走 <rect>，不走 path
  }
}

/**
 * 渲染单个类型形状图标。
 *
 * @param input.type 节点类型（未登记 → 兜底小方点）
 * @param input.size 可选缩放（表头用缺省 9px；小地图可传更小值）
 * @param input.x / input.y 可选偏移（缺省 0,0，父级用 transform 定位）
 */
export function renderTypeShape(input: {
  type: string;
  size?: number;
  x?: number;
  y?: number;
}): ReactElement {
  const shape = shapeOf(input.type);
  const traits = SHAPE_RENDER_TRAITS[shape];
  const box = input.size ?? BOX;
  // small（dot）缩到 60%：尺寸差是第二条视觉通道（颜色之外、轮廓之内）。
  const w = traits.size === 'small' ? box * 0.6 : box;
  const x = input.x ?? 0;
  const y = input.y ?? 0;
  const color = typeColorOf(input.type);
  // 空心：不填充、只描边；实心：填充无描边。
  const fill = traits.outline ? 'none' : color;
  const stroke = traits.outline ? color : 'none';
  const strokeWidth = traits.outline ? 1.2 : 0;
  const common = {
    'data-anic-type-shape': input.type,
    'data-anic-type-shape-kind': shape,
    fill,
    stroke,
    strokeWidth,
  };
  const d = pathOf(shape);
  if (d === null) {
    // 矩形族：dy 让 small 档垂直居中（缩小后不该顶对齐）。
    const dy = (box - w) / 2;
    return createElement('rect', {
      key: `shape-${input.type}`,
      ...common,
      x, y: y + dy,
      width: w, height: w,
      // 直角 vs 圆角是 box 族内部的第三分辨轴（square 直角 / dot 小圆角）。
      rx: traits.size === 'small' ? w / 2 : 0,
      ry: traits.size === 'small' ? w / 2 : 0,
    });
  }
  // path 族：整体缩放到 box 尺寸（path 坐标写在 0..BOX 内）。
  return createElement('path', {
    key: `shape-${input.type}`,
    ...common,
    d,
    transform: `translate(${String(x)},${String(y)})`,
    // 人字是折线（非闭合）：需要 stroke 才看得见，故强制描边（即使它登记为实心）。
    ...(shape === 'chevron' ? { fill: 'none', stroke: color, strokeWidth: 1.4 } : {}),
  });
}
