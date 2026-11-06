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
import { traceDepthStyleOf } from './graphTraceDepth.ts';
import type { NodeRole } from './graphNodeRole.ts';
import { renderCardBody } from './graphNodeCardBody.ts';
import { renderHealthBar } from './graphHealthBar.ts';
import {
  LABEL_DY, LABEL_FILL, LABEL_PX, LABEL_X, META_DY, META_FILL, META_PX, VERDICT_SHAPE, colorOf, fitLabel,
} from './graphNodeStyle.ts';
import { t } from '../../i18n.ts';
import { healthOf, healthSegments, healthSummaryText } from './graphHealth.ts';
import type { ModKeyState } from './graphSelection.ts';

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
  /**
   * 点击回调。`mods` = 点击时按住的修饰键（cycle-109：Ctrl/Cmd 决定多选切换）。
   *
   * 为什么把事件对象传出去而不是在卡片里读 `metaKey`：卡片是**渲染层**，
   * "点击会发生什么"（单选替换 / 多选切换 / 路径模式设端点）是交互裁决，
   * 归装配层与 `useGraphInteraction`。渲染层只负责把按键状态如实上报。
   */
  onNodeClick: ((node: WorkflowNode, mods?: ModKeyState) => void) | undefined;
  /**
   * 路径追溯角色（cycle-84）：root / up（上游）/ down（下游）/ both / null。
   * null = 未启用追溯，渲染与改造前**逐字节等价**（零参调用仍可用）。
   */
  trace?: TraceRole;
  /** 双击进入追溯（cycle-84）；缺省不挂处理器。 */
  onNodeTrace?: ((node: WorkflowNode) => void) | undefined;
  /**
   * 节点角色（cycle-95）：hub / entry / leaf / orphan / null。
   * null = 未判定（中间节点）⇒ 不画角色标记，渲染与 cycle-94 逐字节等价。
   */
  role?: NodeRole;
  /**
   * 追溯跳数（cycle-95）：1 / 2 / 3，0 = root 或圈外。
   *
   * 为什么要把 depth 单独传而不是让卡片自己从 trace 里查：renderGraph 已经在
   * 循环里握着 trace，再让每个节点各查一次等于 O(N) 重复查表；更关键的是
   * 单测（graphA11y）可以直接传 depth 断言三档渲染，不必构造完整 trace。
   */
  traceDepth?: number;
}

export function renderNode(input: NodeRenderInput): ReactElement {
  const { node: n, verdict, visibility, focusId, interactive, onNodeClick, onNodeTrace } = input;
  const trace = input.trace ?? null;
  const role = input.role ?? null;
  const traceDepth = input.traceDepth ?? 0;
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
  /**
   * 追溯距离分档（cycle-95）：样式表在 `graphTraceDepth.ts`（跨元素的单一事实源）。
   * 三档同时改 line型与透明度，并写 `data-anic-trace-depth` 进 DOM ——
   * 视觉与断言两条腿都要有（详见该文件头注）。
   */
  const depthStyle = traceDepthStyleOf(traceStroke !== null, traceDepth);
  /**
   * 角色的可访问名（cycle-95）：走既有 `graph.nodeRole.<role>` 动态键族
   * （闭包扫描器认得这种拼接前缀）。null = 中间节点 ⇒ 不播报（"普通"不是信息）。
   */
  const roleText = role === null ? null : t('graph.nodeRole.' + role);
  const traceDash = depthStyle?.dash;
  const traceFade = depthStyle?.fade ?? 1;

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
      // cycle-95：角色也进可访问名 —— 形状标记是 AT 完全读不到的第二通道，
      // 若只画形状不播报，"这是个枢纽"对屏幕阅读器用户等于不存在（WCAG 1.3.1）。
      'aria-label': interactive ? [t('panel.nodeAriaLabel', { label, id: n.id }), roleText === null ? null : roleText].filter(Boolean).join(' · ') : undefined,
      'data-anic-node': n.id,
      'data-anic-verdict': key ?? 'none',
      // 三档视觉状态进 DOM：opacity 是**视觉**通道，AT 看不见；
      // 把状态同时写成 data-* 才能被断言（也让"筛选是否生效"可机器验证）。
      'data-anic-visibility': visibility,
      'data-anic-lane': n.lane,
      // 节点角色进 DOM（cycle-95）：角色视觉是**形状/线型**通道（AT 读不到），
      // 且它同时出现在节点 `<g>` 与圆点两处——`<g>` 是**节点粒度**的断言入口
      //（"这个节点是什么角色"），圆点那处是**元素粒度**（渲染层确实用了它）。
      // 两处同值不是冗余：只用圆点断言时，测试必须写 `circle[data-anic-...]`，
      // 而既有的节点级契约全部基于 `[data-anic-node]`（会看不到这条通道）。
      'data-anic-node-role': role ?? 'none',
      // 追溯角色进 DOM（cycle-84）：视觉是描边色，那是 AT 读不到的通道；
      // 同时写 data-* 才能被契约测试断言（与 data-anic-visibility 同纪律）。
      'data-anic-trace': trace ?? 'none',
      // 追溯跳数进 DOM（cycle-95）：1/2/3 三档的视觉差（实色/半透明/虚线）是
      // AT 读不到的通道；写成 data-* 才能被契约逐档断言（同 data-anic-trace 纪律）。
      'data-anic-trace-depth': String(traceDepth),
      // 卡片尺寸进 DOM：布局压缩率与重叠检查都能据此断言，不必自己重算布局。
      'data-anic-node-box': `${String(n.w)} ${String(n.h)}`,
      onClick: onNodeClick ? (ev: ModKeyState) => { onNodeClick(n, ev); } : undefined,
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

    // 卡片体 / 色条 / 圆点 / 字形 / 角色标记（cycle-95 下移到 graphNodeCardBody.ts，
    // 守 T3 ≤250 行；三条计数不变量与通道分工见该文件头注）。
    ...renderCardBody({
      w: n.w, h: n.h, type: n.type, fill, dotFill: fill, failed,
      verdictDash: shape?.dash, verdictGlyph: shape?.glyph,
      traceStroke, depthStyle, focused, role,
    }),

    // 健康度分段条（cycle-91；cycle-95 下移到 graphHealthBar.ts 守 T3 行数）。
    // 仍用 <rect> 分段而非「比例环」：环需要第二个 <circle>，而
    // 「每节点恰好一个 circle」是 smoke 钉死的不变量。
    ...renderHealthBar(healthSegs, n.w, n.h),
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
