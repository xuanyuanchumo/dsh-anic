/**
 * 悬浮预览卡（cycle-83 · V 战线）——**纯函数定位 + 无状态渲染**。
 *
 * ## 为什么不能依赖浏览器的 `<title>`
 *
 * 改造前每个节点带 `<title>`，浏览器默认延迟约 1s 才显示，且**键盘 focus 不触发**
 * （Safari/Firefox 只在悬停时读），样式完全不可控（系统色、单行、不能换行）。
 * 对一个有 188 个节点、标签被截断到 10 字以内的图来说，"等 1 秒才看到全名"
 * 等于没有预览。
 *
 * ## 为什么定位必须是纯函数
 *
 * jsdom 没有布局引擎：`getBoundingClientRect()` 恒返回 0。任何"先测量再定位"的
 * 实现**在测试里永远是同一个 (0,0)**，于是"卡片跑到屏幕外"这类缺陷只能在真机上
 * 靠肉眼发现。改成「世界坐标 + 当前视口 → 屏幕坐标」的纯函数后，位置可以在
 * node 环境的 vitest 里逐档断言（含边界翻折），真机与测试走同一条路径。
 *
 * ## 三个翻转规则（都是"卡片跑出可视区"的真实成因）
 *
 * 1. 默认放在节点**右下方**（不遮住正在悬停的卡片本身）；
 * 2. 右侧空间不足 → 翻到左侧；下方不足 → 翻到上方；
 * 3. 最后再整体夹到视口内（带 `MARGIN`）：翻转仍可能溢出（卡片比节点大很多），
 *    夹一次是最后的兜底。三个分支都写成显式判断，不做"看起来差不多"的估算。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { gt } from './graphText.ts';
import type { Size, Viewport } from './graphViewport.ts';

/** 预览卡尺寸（屏幕像素，不随缩放变化——它读的是文字，缩小字就没意义了）。 */
export const TOOLTIP_W = 232;
export const TOOLTIP_H = 124;
/** 与节点的间距 / 与可视区的最小边距。 */
export const TOOLTIP_GAP = 12;
export const TOOLTIP_MARGIN = 6;

/** 世界坐标 → 屏幕坐标（与 `<g transform>` 的 `world * scale + t` 完全同式）。 */
export function worldToScreen(
  point: { x: number; y: number },
  viewport: Viewport,
): { x: number; y: number } {
  return { x: point.x * viewport.scale + viewport.tx, y: point.y * viewport.scale + viewport.ty };
}

/**
 * 计算预览卡的左上角屏幕坐标（纯函数，可单测）。
 *
 * @param node 节点卡片的世界坐标（左缘 x / 垂直中心 y）与宽度
 * @param viewport 当前缩放平移
 * @param size 可视区像素尺寸
 * @returns 左上角坐标（恒在可视区内，除视口比卡片还小的退化情形）
 */
export function tooltipPosition(
  node: { x: number; y: number; w: number },
  viewport: Viewport,
  size: Size,
): { x: number; y: number } {
  const anchor = worldToScreen({ x: node.x + node.w, y: node.y }, viewport);
  const vw = Number.isFinite(size.width) ? Math.max(0, size.width) : 0;
  const vh = Number.isFinite(size.height) ? Math.max(0, size.height) : 0;

  // 规则 1/2：优先右侧，放不下就翻到左侧。
  let x = anchor.x + TOOLTIP_GAP;
  if (x + TOOLTIP_W > vw - TOOLTIP_MARGIN) x = anchor.x - TOOLTIP_W - TOOLTIP_GAP;
  // 上沿对齐节点中线往上偏 1/3 卡高：让卡片与节点有视觉关联但不完全遮住它。
  let y = anchor.y - TOOLTIP_H / 3;
  if (y + TOOLTIP_H > vh - TOOLTIP_MARGIN) y = anchor.y - TOOLTIP_H - TOOLTIP_GAP;
  if (y < TOOLTIP_MARGIN) y = TOOLTIP_MARGIN;

  // 规则 3：最后夹进可视区。`Math.max` 在后，保证极小视口时左/上边界优先
  // （宁可溢出右侧，也不能让卡片左上角跑到负坐标——那里一定被裁掉）。
  x = Math.max(TOOLTIP_MARGIN, Math.min(x, vw - TOOLTIP_W - TOOLTIP_MARGIN));
  return { x, y };
}

/**
 * 预览卡揭示延迟（ms）。
 *
 * 120ms 是"鼠标扫过一排卡片不会每张都炸出预览"与"停下就能立刻看到"的交点。
 * `reducedMotion` 下取 0：减少动效的用户往往也对"延迟反馈"敏感，且延迟本身
 * 不携带信息。
 */
export const TOOLTIP_DELAY_MS = 120;

export function tooltipDelay(reducedMotion: boolean): number {
  return reducedMotion ? 0 : TOOLTIP_DELAY_MS;
}

/** 预览卡内容（数据面，与 DOM 无关）。 */
export interface TooltipModel {
  id: string;
  label: string;
  type: string;
  verdict: string | null;
  /** detail 的前 3 行（门禁事件的原证据文本可能很长）。 */
  detailLines: string[];
  /** 一跳邻居数（无向：入边 + 出边）。 */
  degree: number;
}

/**
 * 组装预览卡内容（纯函数）。
 *
 * 为什么 detail 只取前 3 行：真实账本 detail 单行就有 200+ 字符的，全量塞进 232px
 * 卡会把卡片撑成一团乱码；3 行是"看出这是什么"的最小信息量，余下细节留给点击后的
 * 详情抽屉（预览与详情分工明确，这也是 dsh-ops 的 plan/execute 两段式启蒙）。
 */
export function tooltipModelOf(
  node: { id: string; label: string; type: string; detail?: string },
  verdict: string | null,
  degree: number,
): TooltipModel {
  const raw = node.detail ?? '';
  const detailLines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 3);
  return { id: node.id, label: node.label, type: node.type, verdict, detailLines, degree };
}

/**
 * 安排一次延迟揭示，返回取消函数。
 *
 * 为什么把 setTimeout 的样板放在这里而不是组件里：组件里那段代码要用
 * `globalThis` 的可选调用做 stub 兼容，占掉十几行；抽成纯函数后组件只剩三行。
 * 这里**不是** hook（没有 `use` 前缀、不依赖 React），所以不会被 stub-hooks
 * 守卫当成未登记的自定义 hook。
 */
export function scheduleReveal(reveal: () => void, delay: number): () => void {
  if (delay <= 0) { reveal(); return () => { /* 同步揭示无计时器可取消 */ }; }
  const g = globalThis as {
    setTimeout?: (fn: () => void, ms: number) => number;
    clearTimeout?: (id: number) => void;
  };
  const handle = g.setTimeout?.(reveal, delay);
  return () => { if (handle !== undefined) g.clearTimeout?.(handle); };
}

/** 锚点是否等价（用于 effect 依赖比较，避免每次指针移动都重建 DOM）。 */
export function sameAnchor(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

/**
 * 渲染预览卡（无状态纯展示）。
 *
 * `pointer-events: none`：卡片绝不能挡住指针，否则指针移到卡片上会触发
 * `pointerleave` → 卡片消失 → 指针又落在节点上 → 卡片重新出现，形成闪烁循环。
 */
export function renderTooltip(input: {
  model: TooltipModel;
  at: { x: number; y: number };
}): ReactElement {
  const { model, at } = input;
  return createElement(
    'div',
    {
      'data-anic-graph-tooltip': model.id,
      role: 'tooltip',
      // 预览是**补充**信息而非唯一来源：aria-label 已经完整播报，这里不抢焦点。
      'aria-hidden': 'true',
      style: {
        position: 'absolute',
        left: at.x, top: at.y, width: TOOLTIP_W, minHeight: 72,
        pointerEvents: 'none',
        zIndex: 5,
        display: 'flex', flexDirection: 'column', gap: 3,
        padding: '8px 10px', borderRadius: 6,
        background: token('anic-surface'),
        border: `1px solid ${token('anic-border-strong')}`,
        // 阴影不写颜色字面量（clientRenderContract 会扫）：改用双描边模拟层次，
        // 描边色走令牌，暗色/强制高对比模式下自动跟随。
        outline: `1px solid ${token('anic-border')}`,
        outlineOffset: 1,
        fontSize: 10.5, lineHeight: '14px',
        color: token('anic-text'),
      },
    },
    createElement('div', {
      key: 'title',
      'data-anic-graph-tooltip-title': 'true',
      style: { fontWeight: 600, fontSize: 11.5, color: token('anic-text-strong') },
    }, model.label),
    createElement('div', {
      key: 'meta',
      'data-anic-graph-tooltip-meta': 'true',
      style: { color: token('anic-text-dim'), fontSize: 9.5 },
    }, `${t('graph.lane.' + model.type)}${model.verdict === null ? '' : ` · ${t('graph.verdict.' + model.verdict)}`} · ${model.id}`),
    ...model.detailLines.map((line, i) => createElement('div', {
      key: `detail-${String(i)}`,
      'data-anic-graph-tooltip-detail': 'true',
      style: { color: token('anic-text-dim'), fontSize: 9.5, whiteSpace: 'normal' },
    }, line)),
    createElement('div', {
      key: 'degree',
      'data-anic-graph-tooltip-degree': String(model.degree),
      style: { color: token('anic-text-faint'), fontSize: 9 },
    }, gt('tooltipDegree', { degree: model.degree })),
  );
}
