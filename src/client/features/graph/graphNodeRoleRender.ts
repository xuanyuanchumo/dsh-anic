/**
 * 节点**角色**的形状/线型渲染（cycle-95 · WS-B）—— WCAG 1.4.1 的第三通道落地。
 *
 * ## 为什么角色不能只靠颜色（与 graphTypeShape 同一条纪律）
 *
 * `palette.ts` 已证明：9 个类型色在色域上就不可能都分开（正常 ΔE 6.92）。
 * 角色是**第四个**要编码在同一个 7px 圆点上的维度，靠颜色绝无可能——
 * 色觉障碍、灰度打印、强制高对比模式下全部坍缩成"一个点"。
 * 所以角色必须走**形状 + 线型**通道（本仓已有 `graphTypeShape` 的范式）。
 *
 * ## 两个硬不变量（本文件存在的最大理由）
 *
 * `scripts/offline-smoke.mjs` 与 `graphVisualUpgradeContract` 钉死
 * 「SVG `<circle>` 数 == 节点数」；`graphModernization.test` 钉死
 * 「每节点 2 个 rect（卡片 + 色条）+1 背景」。⇒ 角色渲染**只能**用：
 *   - 对现有元素**改属性**（圆点的 strokeWidth / strokeDasharray）；
 *   - 或用 `<path>`（无任何计数断言约束它）。
 *
 * 本文件选择**改既有圆点的属性 + 一个 `<path>` 标记**：
 *   - 改属性不新增元素 ⇒ 两个计数不变量都不动；
 *   - `<path>` 让"角色确实画出来了"有独立锚点（`data-anic-node-role-mark`）。
 *
 * ## 角色形状必须与**裁决形状**在特征上不撞车
 *
 * 同一个圆点上可能同时有裁决字形（VERDICT_SHAPE 的 dash + glyph）与角色形状。
 * 若两者都占 `strokeDasharray`，角色会把裁决的线型**吃掉**（用户再也分不出
 * PASS/FAIL）——这正是 `chevron`/`cross` 塌缩过的那一族缺陷。
 *
 * 所以分通道：
 *   - 裁决 → `strokeDasharray`（既有语义，不许抢）；
 *   - 角色 → `strokeWidth` 档位（实心/加粗/细线）+ `<path>` 形状标记。
 * 契约会断言这两个元组**不相交**（见 graphNodeRoleContract ⑤）。
 *
 * ## 纯函数（零 DOM / 零 hook）
 *
 * 只返回属性对象 / 元素树，不持有状态。`graphInteractiveContract` ⑦ 的
 * stub-hooks 扫描域包含本文件，零 hook 调用是刻意的。
 */
import { createElement, type ReactElement } from 'react';
import type { NodeRole } from './graphNodeRole.ts';

/** 角色 → 圆点描边宽度档（**唯一**被角色占用的既有属性通道）。 */
export const ROLE_STROKE_WIDTH: Readonly<Record<'entry' | 'orphan' | 'leaf' | 'hub', number>> = {
  entry: 1.9,   // 最粗：起点是阅读的入口
  hub: 1.4,     // 次粗：汇聚点
  leaf: 1.0,    // 细：终点
  orphan: 0.7,  // 最细：不参与因果链
};

/**
 * 角色视觉特征元组（契约断言"与裁决特征不相交"的依据）。
 *
 * 四轴：`mark`（形状标记种类）/ `stroke`（描边档名）/ `outline`（是否只描边）/
 * `size`（标记相对尺寸）。**不做大小的"差不多"判断**——档位必须离散可数，
 * 否则"看起来不一样"会在 7px 尺度上骗人（这正是 graphTypeShape 契约的教训）。
 */
export interface RoleTraits {
  mark: 'arrow' | 'ring' | 'dot' | 'star';
  stroke: 'bold' | 'medium' | 'thin' | 'hairline';
  outline: boolean;
  size: 'full' | 'small';
}

export const ROLE_TRAITS: Readonly<Record<'entry' | 'orphan' | 'leaf' | 'hub', RoleTraits>> = {
  entry: { mark: 'arrow', stroke: 'bold', outline: true, size: 'full' },
  hub: { mark: 'star', stroke: 'medium', outline: true, size: 'full' },
  leaf: { mark: 'dot', stroke: 'thin', outline: false, size: 'small' },
  orphan: { mark: 'ring', stroke: 'hairline', outline: true, size: 'small' },
};

/** 角色 → 特征元组字符串（契约比较用；null/未判定 → `'none'`）。 */
export function roleTraitsOf(role: NodeRole): string {
  if (role === null) return 'none';
  const t = ROLE_TRAITS[role];
  return `${t.mark}|${t.stroke}|${t.outline ? 'outline' : 'solid'}|${t.size}`;
}

/** 角色 → 圆点描边宽度（null → 调用方传的兜底值，本函数不做判断）。 */
export function roleStrokeWidthOf(role: NodeRole): number | null {
  return role === null ? null : ROLE_STROKE_WIDTH[role];
}

/**
 * 角色标记 `<path>` 的 d（相对圆点中心的局部坐标，尺寸按 `r` 缩放）。
 *
 * 为什么返回局部坐标而不是绝对坐标：调用方把 `<path>` 放在节点 `<g>` 里
 * （原点 = 卡片垂直中心），用 translate 定位比在 d 里算绝对坐标更抗布局变动。
 */
export function roleMarkPath(role: NodeRole, cx: number, cy: number, r: number): string | null {
  if (role === null) return null;
  const s = role === 'leaf' || role === 'orphan' ? r * 1.6 : r * 2.6;
  const m = s / 2;
  switch (role) {
    // 入口：朝上的箭头（与"因果从这里出发"的朝向一致）。
    case 'entry': return `M ${String(cx)} ${String(cy - m)} L ${String(cx + m)} ${String(cy + m)} L ${String(cx - m)} ${String(cy + m)} Z`;
    // 枢纽：四角星（与类型形状的 star 同一几何族，但在圆点上方独立绘制）。
    case 'hub': {
      const q = s / 4;
      return `M ${String(cx)} ${String(cy - m)} L ${String(cx + q)} ${String(cy - q)} L ${String(cx + m)} ${String(cy)} L ${String(cx + q)} ${String(cy + q)} L ${String(cx)} ${String(cy + m)} L ${String(cx - q)} ${String(cy + q)} L ${String(cx - m)} ${String(cy)} L ${String(cx - q)} ${String(cy - q)} Z`;
    }
    // 末端：小实心方（尺寸档 small，靠 size 与 dot 的独立性区分）。
    case 'leaf': return `M ${String(cx - m)} ${String(cy - m)} H ${String(cx + m)} V ${String(cy + m)} H ${String(cx - m)} Z`;
    // 孤立：空心环（**不用 circle**：circle 计数是不变量，用 path 画环更安全）。
    case 'orphan': {
      const o = m;
      return `M ${String(cx - o)} ${String(cy)} A ${String(o)} ${String(o)} 0 1 0 ${String(cx + o)} ${String(cy)} A ${String(o)} ${String(o)} 0 1 0 ${String(cx - o)} ${String(cy)} Z`;
    }
  }
}

/**
 * 渲染角色标记（`<path>`，带 `data-anic-node-role` 锚点）。
 *
 * 未判定（null）→ `null`（不画）：一个"无角色"的标记会给每个中间节点加一个
 * 无意义的形状，那才是视觉噪声——169 个节点里绝大多数都是中间节点。
 *
 * @param input.role 角色（null = 不画）
 * @param input.x / input.y 标记的定位（缺省相对卡片左缘 / 圆点中心，由调用方传）
 * @param input.stroke 描边色（由调用方用 token() 取，本文件不自造颜色）
 */
export function renderRoleMark(input: {
  role: NodeRole;
  x: number;
  y: number;
  r: number;
  stroke: string;
}): ReactElement | null {
  const d = roleMarkPath(input.role, 0, 0, input.r);
  if (d === null || input.role === null) return null;
  const traits = ROLE_TRAITS[input.role];
  return createElement('path', {
    key: `role-${input.role}`,
    // 角色 + 特征进 DOM：视觉的形状/粗细是 AT 读不到的通道（同 data-anic-trace 纪律）。
    'data-anic-node-role': input.role,
    'data-anic-node-role-mark': traits.mark,
    'data-anic-node-role-stroke': traits.stroke,
    d,
    transform: `translate(${String(input.x)},${String(input.y)})`,
    fill: traits.outline ? 'none' : input.stroke,
    stroke: traits.outline ? input.stroke : 'none',
    strokeWidth: 0.9,
    strokeLinejoin: 'round',
  });
}
