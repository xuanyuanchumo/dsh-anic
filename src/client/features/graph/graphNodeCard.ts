/**
 * 单节点卡片渲染（cycle-83 · V 战线，从 graphNodeRender.ts 拆出）。
 *
 * ## 一个节点 = 1 circle + 2 rect + 2 text（数量关系是**硬约束**）
 *
 * `scripts/offline-smoke.mjs` 与 `tests/contract/graphInteractiveContract` 都钉死
 * 「`circle` 数 == 节点数」。所以升级成卡片时**不能**把 circle 换成 rect，
 * 而是在原有 circle 之上加卡片元素，且**每节点恰好 1 个 circle**：
 *   - `<circle>`：状态圆点，沿用既有 fill / strokeDasharray / FAIL `strokeWidth: 2`
 *     语义 —— smoke 的红圈计数正是靠 strokeWidth 判的，挪位置时若丢掉这个属性，
 *     红圈会变 0 而节点其实是对的（典型的"修一个缺陷造一个假缺陷"）；
 *   - `<rect>` 卡片体：表面色填充 + 描边（不用类型色大面积铺，理由见 graphNodeStyle）；
 *   - `<rect>` 3px 类型色条：语义色只出现在非文本角色上；
 *   - 两个 `<text>`：主标签（按宽度截断）+ 次标签（类型 · 裁决）。
 *
 * ## coordinate 约定：`<g>` 原点是**卡片垂直中心**
 *
 * 布局给 `x`（卡片左缘）与 `y`（卡片垂直中心）。选中心而不是左上角，是因为
 * 圆点、两行文本、裁决字形全部围绕卡片中线排布 —— 用中心做原点时它们都是
 * "± 半个偏移"，换成左上角就要每个元素各自减一次半高（错一处就整体偏一格）。
 */
import { createElement, type ReactElement } from 'react';
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { PositionedNode } from './graphLayout.ts';
import { token } from '../../../shared/tokens.ts';
import { canonicalVerdict, gateFillOf } from './gateColors.ts';
import { OPACITY, type NodeVisibility } from './graphFilter.ts';
import type { TraceRole } from './graphTrace.ts';
import {
  BAR_INSET, BAR_W, CARD_FILL, CARD_RADIUS, CARD_STROKE, DOT_DY, DOT_R, DOT_X, LABEL_DY,
  LABEL_FILL, LABEL_PX, LABEL_X, META_DY, META_FILL, META_PX, VERDICT_SHAPE, colorOf, fitLabel,
} from './graphNodeStyle.ts';
import { t } from '../../i18n.ts';
import { healthOf, healthSegments, healthSummaryText } from './graphHealth.ts';

/**
 * 次标签：类型名 + 裁决。
 *
 * 为什么要第二行：主标签只讲"它叫什么"，读者紧接着的问题是"它是什么类型 /
 * 过了没有"。挤进主标签会让它变成一行长文本（也正是改造前那个不可读的形态）。
 * 类型名与裁决都走动态键族（`graph.lane.<type>` / `graph.verdict.<key>`），
 * 闭包扫描器认得这种拼接前缀，合并 locale 前后都不会被报成幽灵/死键。
 */
export function metaLabelOf(n: WorkflowNode, verdict: string | undefined): string {
  const lane = t('graph.lane.' + n.type);
  const key = canonicalVerdict(verdict);
  if (key === null) return lane;
  return `${lane} · ${t('graph.verdict.' + key)}`;
}

/** 单节点渲染入参（集中成对象，避免 7 个位置参数排错顺序）。 */
export interface NodeRenderInput {
  /** 布局后的节点：带 `lane`/`column`/`row`/`w`/`h`（原始 WorkflowNode 没有这些）。 */
  node: PositionedNode;
  verdict: string | undefined;
  visibility: NodeVisibility;
  focusId: string | null;
  interactive: boolean;
  onNodeClick: ((node: WorkflowNode) => void) | undefined;
  /**
   * 路径追溯角色（cycle-84）：root / up（上游）/ down（下游）/ both / null。
   * null = 未启用追溯，渲染与改造前**逐字节等价**（零参调用仍可用）。
   */
  trace?: TraceRole;
  /** 双击进入追溯（cycle-84）；缺省不挂处理器。 */
  onNodeTrace?: ((node: WorkflowNode) => void) | undefined;
}

export function renderNode(input: NodeRenderInput): ReactElement {
  const { node: n, verdict, visibility, focusId, interactive, onNodeClick, onNodeTrace } = input;
  const trace = input.trace ?? null;
  const failed = n.result === 'FAIL';
  const key = canonicalVerdict(verdict);
  const fill = gateFillOf(verdict) ?? colorOf(n.type);
  const shape = key === null ? undefined : VERDICT_SHAPE[key];
  const label = `${n.label} [${n.type}]${verdict ? ` · ${verdict}` : ''}`;
  const focused = focusId === n.id;
  // cycle-91：健康度（`testReport` 进图）。无 testReport ⇒ 不画任何健康度元素
  //（'无' 与 '0 失败' 是两件事，画出来会撒谎）。
  const health = healthOf(n);
  const healthSegs = healthSegments(health);
  const healthText = healthSummaryText(health);
  // 追溯态描边：上游冷色 = "它是原因"，下游暖色 = "它是结果"（与图例同源）。
  const traceStroke = trace === 'root'
    ? token('anic-focus-ring')
    : trace === 'up' || trace === 'both'
      ? token('anic-pass')
      : trace === 'down'
        ? token('anic-warn-text')
        : null;

  return createElement(
    'g',
    {
      // 稳定 key = 节点 id（节点已带 data-anic-node，id 即唯一身份）——
      // 数组序号 key 在插入/删除时错位 patch。
      key: `node-${n.id}`,
      // 原点 = 卡片垂直中心（见文件头 coordinate 约定）。
      transform: `translate(${String(n.x)},${String(n.y)})`,
      // 键盘可达性（P2-A11Y-KEY → P1-2 roving tabindex）：唯一停靠点在 svg 容器，
      // 节点 tabIndex=-1、由方向键经 graphKeyDown 聚焦。role/label 保留在节点上：
      // AT 焦点到达时仍播报节点身份。
      role: interactive ? 'button' : undefined,
      tabIndex: interactive ? -1 : undefined,
      // aria-label 覆盖 <title> 的命名计算，所以它必须**自带全部**信息：
      // 带上 id 是因为 label 不唯一（同名阶段节点存在）。
      'aria-label': interactive ? t('panel.nodeAriaLabel', { label, id: n.id }) : undefined,
      'data-anic-node': n.id,
      'data-anic-verdict': key ?? 'none',
      // 三档视觉状态进 DOM：opacity 是**视觉**通道，AT 看不见；
      // 把状态同时写成 data-* 才能被断言（也让"筛选是否生效"可机器验证）。
      'data-anic-visibility': visibility,
      'data-anic-lane': n.lane,
      // 追溯角色进 DOM（cycle-84）：视觉是描边色，那是 AT 读不到的通道；
      // 同时写 data-* 才能被契约测试断言（与 data-anic-visibility 同纪律）。
      'data-anic-trace': trace ?? 'none',
      // 卡片尺寸进 DOM：布局压缩率与重叠检查都能据此断言，不必自己重算布局。
      'data-anic-node-box': `${String(n.w)} ${String(n.h)}`,
      onClick: onNodeClick ? () => { onNodeClick(n); } : undefined,
      // 双击 = 进入/退出该节点的上下游追溯（cycle-84）。单击仍打开详情抽屉，
      // 两者不冲突：双击会先触发两次 click，详情抽屉重复打开同一节点是幂等的。
      onDoubleClick: onNodeTrace ? () => { onNodeTrace(n); } : undefined,
      onKeyDown: onNodeClick
        ? (ev: { key: string; preventDefault: () => void }) => {
            // 只认 Enter 与 Space。两个键都 preventDefault：Space 是**必需**的
            // （否则页面跟着滚动），Enter 上没有默认行为，统一处理是为了让
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

    // 卡片体。`data-anic-node-card` 是"卡片确实渲染了"的可断言锚点。
    createElement('rect', {
      key: 'card',
      'data-anic-node-card': 'true',
      x: 0, y: -n.h / 2, width: n.w, height: n.h,
      rx: CARD_RADIUS, ry: CARD_RADIUS,
      fill: CARD_FILL,
      // 焦点卡片描边加粗：182 个节点里"我在看哪个"必须一眼可见。
      // 追溯态优先于焦点态：追溯是用户**显式进入**的模式，它的颜色编码
      // （上游/下游）比"鼠标刚好停在这"承载更多信息。
      stroke: traceStroke ?? (focused ? token('anic-focus-ring') : CARD_STROKE),
      strokeWidth: traceStroke !== null ? 1.8 : focused ? 1.6 : 0.8,
    }),

    // 左侧类型/裁决色条（非文本角色，3.3 阈值适用）。
    createElement('rect', {
      key: 'bar',
      'data-anic-node-bar': n.type,
      x: 0, y: -n.h / 2 + BAR_INSET, width: BAR_W, height: n.h - BAR_INSET * 2,
      rx: BAR_W / 2, ry: BAR_W / 2,
      fill,
    }),

    // 状态圆点：每节点**恰好一个**。FAIL 用 strokeWidth=2 的红圈（smoke 数据驱动断言）。
    createElement('circle', {
      key: 'dot',
      'data-anic-node-dot': 'true',
      cx: DOT_X, cy: DOT_DY, r: DOT_R,
      fill,
      stroke: failed ? token('anic-bad-text') : token('anic-text'),
      strokeWidth: failed ? 2 : 0.6,
      strokeDasharray: shape?.dash,
      className: failed ? 'anic-fail-node' : undefined,
    }),

    // 字形是与颜色**正交**的第二个通道：灰度打印、色盲、强制高对比模式下仍然可读。
    // 没有裁决时不画字形（画一个"无"字反而是噪声）。
    shape === undefined
      ? null
      : createElement('text', {
          key: 'glyph',
          x: DOT_X, y: DOT_DY + 2.1, fontSize: 5.4, textAnchor: 'middle',
          fill: token('anic-on-accent'), 'data-anic-verdict-glyph': shape.glyph,
        }, shape.glyph),

    // 健康度分段条（cycle-91）：贴在卡片**底缘内侧**，高 1.6px。
    //
    // 为什么用 <rect> 分段而不是「比例环」：环需要第二个 <circle>，而
    // 「每节点恰好一个 circle」是 smoke 钉死的不变量 ⇒ 环会破坏它。
    // rect 分段保留了「比例可读」且零不变量风险。
    ...(healthSegs.length > 0
      ? healthSegs.map((seg, i) => {
        const segFill = seg.kind === 'passed'
          ? token('anic-pass')
          : seg.kind === 'failures'
            ? token('anic-bad-text')
            : token('anic-warn-text');
        // 段宽按比例切分；起点按前面段累加（世界坐标，卡片左缘 = 0）。
        const segX = BAR_INSET + healthSegs.slice(0, i).reduce((a, s) => a + s.ratio * (n.w - BAR_INSET * 2), 0);
        const segW = seg.ratio * (n.w - BAR_INSET * 2);
        return createElement('rect', {
          key: `health-${String(i)}`,
          'data-anic-node-health': seg.kind,
          x: segX, y: n.h / 2 - BAR_INSET - 1.6, width: Math.max(0.5, segW), height: 1.6,
          fill: segFill,
        });
      })
      : []),
    // 主标签：按卡片宽度截断（见 graphNodeStyle 的 fitLabel）。
    createElement('text', {
      key: 'label',
      'data-anic-node-label': 'true',
      x: LABEL_X, y: LABEL_DY, fontSize: LABEL_PX, fill: LABEL_FILL,
      fontWeight: focused ? 'bold' : undefined,
    }, fitLabel(n.label, n.w)),

    // 次标签（类型 · 裁决 · 测试摘要）：贴卡片底缘，与主标签留出净空。
    //
    // cycle-91：测试摘要是**文字通道**（）—— WCAG 1.4.1 要求
    // 「颜色不能是唯一通道」：色觉障碍用户看不出红段与琥珀段的区别，
    // 数字必须以文字形式出现。
    createElement('text', {
      key: 'meta',
      'data-anic-node-meta': 'true',
      x: LABEL_X, y: META_DY, fontSize: META_PX, fill: META_FILL,
    }, fitLabel(metaLabelOf(n, verdict) + (healthText !== null ? ' · ' + healthText : ''), n.w)),
  );
}
