/**
 * 单节点 / 单边的 SVG 元素构造（cycle-82 · 从 renderGraph.ts 拆出以满足 250 行模块纪律）。
 *
 * ## 为什么单独成文件
 *
 * 拆分的界线是**职责**而不是行数：`renderGraph.ts` 负责「数据 → 图的整体装配」
 * （布局、包围盒、svg 容器、a11y 骨架、等价数据表），本文件负责「一个节点画成什么」。
 * 界线若能一句话说清，拆开就不会造成"为凑行数而割裂"。改造前这两件事同在 249 行的
 * 一个函数里，加任何一点东西都得先删注释。
 *
 * ## 裁决的第二通道（P2-A11Y-COLOR）在这里落地
 *
 * 改造前裁决只靠 `fill` 一个通道表达（PASS 绿 / FAIL 红 / doubt 黄）——对红绿色盲
 * 用户（约 8% 男性）PASS 与 FAIL 完全不可区分，而**任何 DOM 断言都看不出来**：
 * 圆点照常存在、点击照常工作、颜色照常"正确"。颜色永远不能是唯一通道（WCAG 1.4.1）。
 * 这里给每个裁决配一个线型 + 一个字形：
 *   PASS 实线·✓ / FAIL 虚线·✕ / doubt 点线·? / pending 细虚线· / skip 短划·–
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { PositionedNode } from './graphLayout.ts';
import { token } from '../../../shared/tokens.ts';
import { canonicalVerdict, gateFillOf } from './gateColors.ts';
import { OPACITY, type NodeVisibility } from './graphFilter.ts';
import { t } from '../../i18n.ts';

/**
 * 节点类型色改为令牌引用（P1-TOKENS）：同一张表曾是本文件私有十六进制，
 * 与 gateColors / renderStepTrace 各自重复一份，"改一处亮一处"且暗色主题只能
 * 覆盖到被 var() 引用的那一份。
 */
const TYPE_COLORS: Record<string, string> = {
  phase: token('anic-type-phase'),
  'micro-step': token('anic-type-micro-step'),
  gate: token('anic-type-gate'),
  'human-gate': token('anic-type-human-gate'),
  cycle: token('anic-type-cycle'),
  'gate-event': token('anic-type-gate-event'),
  incident: token('anic-type-incident'),
  autonomy: token('anic-type-autonomy'),
};

function colorOf(type: string): string {
  return TYPE_COLORS[type] ?? token('anic-type-unknown');
}

/**
 * 类型色对外查询（图例色点用）。
 *
 * 图例必须是**真色点**而不是文字标签：用户看图例是为了把颜色映射回类型，
 * 只写类型名的图例等于没写。这里转出同一个 `colorOf`，保证图例与图上圆点
 * 永远同源（各自维护一张表必然漂移，图例就成了骗人的东西）。
 */
export function typeColorOf(type: string): string {
  return colorOf(type);
}

/** 标签截断。26px 行距下超过 18 字会横向撞到下一列，故截到 17 + 省略号。 */
function shortLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

/**
 * 圆点半径。cycle-82 从 7/5 压到 6/4：行距压到 26px 后，7px 半径 + 2px 描边会让
 * 相邻两点的圆几乎相切（14+2 直径 vs 26 行距），标签也会压到下一行。
 * 6/4 在 26px 行距下留出 12px 以上净空，且 0.25 倍缩放时直径仍有 3px 可见。
 */
function nodeRadius(type: string): number {
  return type === 'phase' || type === 'gate' || type === 'human-gate' ? 6 : 4;
}

/** 裁决 → 线型 + 字形（与颜色正交的第二通道）。 */
const VERDICT_SHAPE: Record<string, { dash: string | undefined; glyph: string }> = {
  pass: { dash: undefined, glyph: '✓' },
  fail: { dash: '2 1.4', glyph: '✕' },
  doubt: { dash: '0.6 1.6', glyph: '?' },
  pending: { dash: '3 2', glyph: '·' },
  skip: { dash: '1 2', glyph: '–' },
};

/** 单节点渲染入参（集中成对象，避免 7 个位置参数排错顺序）。 */
export interface NodeRenderInput {
  /** 布局后的节点：带 `lane`/`column`/`row`（原始 WorkflowNode 没有这些字段）。 */
  node: WorkflowNode & Pick<PositionedNode, 'lane'>;
  verdict: string | undefined;
  visibility: NodeVisibility;
  focusId: string | null;
  interactive: boolean;
  onNodeClick: ((node: WorkflowNode) => void) | undefined;
}

export function renderNode(input: NodeRenderInput): ReactElement {
  const { node: n, verdict, visibility, focusId, interactive, onNodeClick } = input;
  const failed = n.result === 'FAIL';
  const key = canonicalVerdict(verdict);
  const fill = gateFillOf(verdict) ?? colorOf(n.type);
  const shape = key === null ? undefined : VERDICT_SHAPE[key];
  const label = `${n.label} [${n.type}]${verdict ? ` · ${verdict}` : ''}`;

  return createElement(
    'g',
    {
      // cycle-40（UI 研究 Top3）：稳定 key = 节点 id（节点已带 data-anic-node，
      // id 即唯一身份）——数组序号 key 在插入/删除时错位 patch。
      key: `node-${n.id}`,
      transform: `translate(${String(n.x)},${String(n.y)})`,
      // 键盘可达性（P2-A11Y-KEY→P1-2 roving tabindex）：改造前每个节点
      // tabIndex=0——169 个停靠点，键盘用户要按 169 次 Tab 才能穿过图区。
      // 现在唯一停靠点在 svg 容器（role=group + tabIndex=0），节点 -1、
      // 由方向键经 graphKeyDown 聚焦（APG roving tabindex）。role/label
      // 保留在节点上：AT 焦点到达时仍播报节点身份。
      role: interactive ? 'button' : undefined,
      tabIndex: interactive ? -1 : undefined,
      // aria-label 覆盖 <title> 的命名计算，所以它必须**自带全部**信息：
      // 带上 id 是因为 label 不唯一（同名阶段节点存在），只播报 label 时
      // 屏幕阅读器用户无法区分两个同名节点。
      'aria-label': interactive ? t('panel.nodeAriaLabel', { label, id: n.id }) : undefined,
      'data-anic-node': n.id,
      'data-anic-verdict': key ?? 'none',
      // 三档视觉状态进 DOM：opacity 是**视觉**通道，AT 看不见；
      // 把状态同时写成 data-* 才能被断言（也让"筛选是否生效"可机器验证）。
      'data-anic-visibility': visibility,
      'data-anic-lane': n.lane,
      onClick: onNodeClick ? () => { onNodeClick(n); } : undefined,
      onKeyDown: onNodeClick
        ? (ev: { key: string; preventDefault: () => void }) => {
            // 只认 Enter 与 Space。两个键都 preventDefault：
            // Space 是**必需**的（否则页面跟着滚动，用户"按了按钮"同时
            // "页面跳走了"）；Enter 上没有默认行为，统一处理是为了让
            // Space 那条不会被后续重构当成冗余顺手删掉。
            if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
              ev.preventDefault();
              onNodeClick(n);
            }
          }
        : undefined,
      // 被筛掉的节点不可点：它已不在当前语义子集里，点击会打开一个用户刚说
      // "不关心"的节点。但节点**仍在 DOM 里**（不删节点纪律，见 graphFilter 头注）。
      // 走 style 而非 SVG 属性：`pointer-events` 作为元素属性在 React/SVG 组合下
      // 实测不落到 DOM（断言读回空串），style 是确定生效的通道。
      style: {
        cursor: onNodeClick ? 'pointer' : undefined,
        opacity: OPACITY[visibility],
        pointerEvents: visibility === 'filtered' ? 'none' : undefined,
      },
    },
    createElement('title', null, label),
    createElement('circle', {
      r: nodeRadius(n.type),
      fill,
      stroke: failed ? token('anic-bad-text') : token('anic-text'),
      strokeWidth: failed ? 2 : 0.6,
      strokeDasharray: shape?.dash,
      className: failed ? 'anic-fail-node' : undefined,
    }),
    // 字形是与颜色**正交**的第二个通道：灰度打印、色盲、强制高对比模式下
    // 仍然可读。没有裁决时不画字形（画一个"无"字反而是噪声）。
    shape === undefined
      ? null
      : createElement('text', {
          x: 0, y: 2.4, fontSize: 5.4, textAnchor: 'middle',
          fill: token('anic-on-accent'), 'data-anic-verdict-glyph': shape.glyph,
        }, shape.glyph),
    createElement('text', {
      x: 8, y: 2.8, fontSize: 6.4, fill: token('anic-text'),
      // 焦点节点加粗：悬停/键盘聚焦时"我在看哪个"必须一眼可见，
      // 光靠邻居变亮在密集区不够（182 个点里找不到中心）。
      fontWeight: focusId === n.id ? 'bold' : undefined,
    }, shortLabel(n.label)),
  );
}

/** 单边渲染入参。 */
export interface EdgeRenderInput {
  from: string;
  to: string;
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
  /** 两端中**较亮**的透明度（一端可见就该看得见这条边，见下方调用点注释）。 */
  opacity: number | undefined;
}

export function renderEdge(input: EdgeRenderInput): ReactElement {
  const { from, to, fromPos, toPos, opacity } = input;
  return createElement('line', {
    // cycle-40（UI 研究 Top3）：数据派生稳定 key（from→to）——数组序号 key
    // 在节点集插入/删除时全图错位 patch；数据派生 key 让 diff 精确命中。
    key: `edge-${from}-${to}`,
    x1: fromPos.x, y1: fromPos.y, x2: toPos.x, y2: toPos.y,
    stroke: token('anic-border-strong'), strokeWidth: 0.7, markerEnd: 'url(#anic-spike-arrow)',
    opacity,
  });
}

/** 箭头 marker（`<defs>` 内容；id 被 renderEdge 的 markerEnd 引用）。 */
export function renderArrowMarker(): ReactElement {
  return createElement(
    'marker',
    { key: 'arrow', id: 'anic-spike-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' },
    createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: token('anic-text-faint') }),
  );
}
