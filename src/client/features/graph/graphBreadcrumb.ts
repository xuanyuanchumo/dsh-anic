/**
 * 面包屑（cycle-83 · V 战线）——「我在哪」的定位感，纯函数产出文本 + 纯展示渲染。
 *
 * ## 为什么需要它（不是装饰）
 *
 * 图区展示的是 188 个节点 / 43 轮历史。改造前**没有任何**"当前是哪一轮、哪个阶段、
 * 正在看多大窗口"的提示：用户看到的是一片卡片，只能靠记忆判断自己滚到了三周前。
 * 小地图回答"在整张图的哪一块"，面包屑回答"在项目生命周期的哪一段"——两者叠起来
 * 才是完整的定位感。
 *
 * ## 为什么文本构造是纯函数
 *
 * 面包屑的每一段都来自数据（当前轮 / 当前阶段 / 窗口大小），而这些数据在快照里
 * 有多种形态：`cycle` lane 可能为空、`phase` 节点可能没有、窗口可能等于总数。
 * 这些边界若写在渲染里，就只能靠"挂载一个空图看看"来验证。纯函数让四种边界
 * 都能单测，且渲染层退化为一句 map。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { gt } from './graphText.ts';
import type { WorkflowNode } from '../../workflowGraphData.ts';

/** 面包屑的一段：`kind` 进 DOM 供断言，`text` 是可见文案。 */
export interface Crumb { kind: 'root' | 'cycle' | 'phase' | 'window'; text: string }

export interface CrumbInput {
  nodes: readonly WorkflowNode[];
  /** 窗口之外的节点数（`snapshotProjection` 折叠掉的量；0 = 全量在图上）。 */
  windowedOut?: number;
}

/** 从 cycle 类型的节点里取序号最大的那一轮（id 形如 `cycle:cycle-83`）。 */
export function currentCycleOf(nodes: readonly WorkflowNode[]): string | null {
  let best: string | null = null;
  let bestNo = -1;
  for (const n of nodes) {
    if (n.type !== 'cycle') continue;
    const m = /(\d+)\s*$/.exec(n.id) ?? /(\d+)\s*$/.exec(n.label);
    const no = m === null ? -1 : Number(m[1]);
    if (no > bestNo) { bestNo = no; best = n.label; }
  }
  return best;
}

/**
 * 当前阶段：取 phase lane 中**最后一个**节点。
 *
 * 为什么不是"第一个"：`snapshotCore` 按 macro phase 的推进顺序生成 phase 节点
 * （plan → design → … → maintain），读图时"当前阶段"就是走到的那一个。按输入
 * 顺序取最后一个，与 `workflow-state.json` 的 `currentPhase` 语义一致；这里不
 * 额外读状态文件，是为了让面包屑只依赖**已传入的图数据**（组件不新增数据腿）。
 */
export function currentPhaseOf(nodes: readonly WorkflowNode[]): string | null {
  let last: string | null = null;
  for (const n of nodes) if (n.type === 'phase') last = n.label;
  return last;
}

/**
 * 构造面包屑（纯函数，四种边界都有定义）：
 * ① 无 cycle 节点 → 该段省略（不显示 "cycle-null"）；
 * ② 无 phase 节点 → 该段省略；
 * ③ `windowedOut == 0` → 窗口段说"全量"而不是"窗口 188/188"；
 * ④ 窗口段始终在场（它是"为什么只看到这些"的唯一解释）。
 */
export function crumbsOf(input: CrumbInput): Crumb[] {
  const out: Crumb[] = [{ kind: 'root', text: gt('crumbRoot') }];
  const cycle = currentCycleOf(input.nodes);
  if (cycle !== null) out.push({ kind: 'cycle', text: gt('crumbCycle', { cycle }) });
  const phase = currentPhaseOf(input.nodes);
  if (phase !== null) out.push({ kind: 'phase', text: gt('crumbPhase', { phase }) });
  const hidden = input.windowedOut ?? 0;
  out.push({
    kind: 'window',
    text: hidden > 0
      ? gt('crumbWindow', { total: input.nodes.length, hidden })
      : gt('crumbAll', { total: input.nodes.length }),
  });
  return out;
}

/**
 * 渲染面包屑。
 *
 * `aria-label` 给整条面包屑一个可访问名（否则 AT 会把 `›` 分隔符念成"大于号"，
 * 用户听到一串碎片）。每一段本身不进 Tab 序列：它是说明，不是导航控件。
 */
export function renderBreadcrumb(input: CrumbInput): ReactElement {
  const crumbs = crumbsOf(input);
  return createElement(
    'nav',
    {
      'data-anic-graph-crumbs': 'true',
      role: 'navigation',
      'aria-label': gt('crumbLabel'),
      style: {
        display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
        fontSize: 10, padding: '0 8px 4px', color: token('anic-text-dim'),
      },
    },
    ...crumbs.map((c, i) => createElement(
      'span',
      {
        key: `crumb-${c.kind}`,
        'data-anic-graph-crumb': c.kind,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: c.kind === 'root' ? token('anic-text-faint') : token('anic-text-dim'),
          fontWeight: c.kind === 'cycle' ? 600 : 400,
        },
      },
      // 分隔符挂在**段内**而不是独立的 span：AT 读到的是一段一段的短语，
      // 不会因为多一个纯符号节点而在句读处停顿两次。
      i === 0 ? null : createElement('span', { key: 'sep', 'aria-hidden': 'true' }, '›'),
      c.text,
    )),
  );
}
