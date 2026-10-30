/**
 * 泳道表头渲染（cycle-90）——把布局算好的 `LaneHeaderPlacement` 画成 SVG 元素。
 *
 * ## 为什么表头是"标注"而不是"卡片"
 *
 * 表头承载的是「这一段是什么、有多少个」——它是**读者的路标**，不是图的内容。
 * 把它画成卡片（同底色、同描边、同高度）会让它与真正的节点卡片抢视觉权重：
 * 读者扫图时先看到的是表头（因为它有描边有底色），而节点退成背景。
 * 所以表头只画三样东西：**类型色点 + 名称 + 计数 + 一条分隔细线**。
 *
 * ## a11y：表头不是装饰
 *
 * `role="presentation"` 会让屏幕阅读器**跳过**它 —— 而它恰好承载"这段是什么"
 * 这一信息。正确形态是给 `<g>` 一个 `aria-label`（名称 + 计数），
 * 让 AT 在遍历到这一段时读出"门禁 4 个节点"。文字本身也用 `<text>` 画出，
 * 不是纯色块（纯色块对 AT 是空的）。
 *
 * ## 位置全部来自布局
 *
 * 本文件**不计算任何坐标** —— x/y/宽高都由 `layoutGraph` 给出
 * （见 `graphLayout.ts` 头注「泳道表头为什么由布局算位置」）。
 * 渲染层自己算 = 与布局两处各有一份真相，改折列算法时必然漂移。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import type { LaneHeaderPlacement } from './graphLayout.ts';
import { typeColorOf } from './graphNodeRender.ts';
import { gt } from './graphText.ts';
import { t } from '../../i18n.ts';

/** 表头渲染入参。 */
export interface LaneHeaderInput {
  headers: readonly LaneHeaderPlacement[];
  /** 每条 lane 的节点总数（`LaneSummary.count`）—— 表头显示"这一类一共多少个"。 */
  counts: ReadonlyMap<string, number>;
  /** 当前筛选命中的 id 集（用于把"被筛掉的那些"从计数里扣掉）。 */
  matching?: ReadonlySet<string>;
}

/**
 * lane 的可读名。
 *
 * 为什么自己拼而不是直接 `t('graph.lane.' + type)`：类型可能不在词表里
 * （未来新增类型 / 脏数据），此时 `t()` 会回退到**键名本身**（"graph.lane.foo"），
 * 那在表头上就是一行乱码。回退到原始 type 至少是可读的。
 */
export function laneNameOf(type: string): string {
  const key = `graph.lane.${type}`;
  const label = t(key);
  return label === key ? type : label;
}

/**
 * 表头计数文案。
 *
 * 筛选激活时显示「命中/总数」两段：只显示总数会让用户以为"这张图有 122 个失败
 * 事件"（实际命中 3 个），而只显示命中数又会让用户以为图被删了。
 */
function countTextOf(total: number, hit: number | null): string {
  if (hit === null || hit === total) return String(total);
  return `${String(hit)}/${String(total)}`;
}

/**
 * 渲染全部泳道表头（返回数组，直接进 world `<g>` 的 children）。
 *
 * 为什么挂在 world 里（跟着缩放平移走）而不是像小地图那样固定在屏幕角落：
 * 表头是**世界坐标**的标注，它必须与它标注的那一段卡片**一起移动**——
 * 固定在屏幕上时，图一平移，表头就指着别的列了。
 */
export function renderLaneHeaders(input: LaneHeaderInput): ReactElement[] {
  const { headers, counts, matching } = input;
  return headers.map((h) => {
    const total = counts.get(h.type) ?? h.count;
    const hit = matching === undefined ? null : countHit(h, matching);
    const name = laneNameOf(h.type);
    const text = countTextOf(total, hit);
    return createElement(
      'g',
      {
        key: `lane-header-${h.type}-${String(h.column)}`,
        // 锚点：存在性与内容都靠它断言（"表头真的画出来了"不能只靠肉眼）。
        'data-anic-graph-lane-header': 'true',
        // lane 类型：让"哪个表头对应哪类节点"可机器断言。
        'data-anic-lane': h.type,
        // 本列该段的节点数 + 该 lane 总数（两个数不同：一条 lane 可跨多列）。
        'data-anic-graph-lane-header-count': String(h.columnCount),
        'data-anic-graph-lane-header-total': String(total),
        // 承载信息 ⇒ 不能是 presentation（AT 会跳过）；给名字让 AT 读出来。
        role: 'group',
        'aria-label': gt('laneHeaderLabel', { name, count: text }),
        transform: `translate(${String(h.x)},${String(h.y)})`,
      },
      // 类型色点：与卡片左侧色条同色 ⇒ "这一段是门禁"不必读文字也知道。
      createElement('rect', {
        key: 'dot',
        'data-anic-graph-lane-header-dot': h.type,
        x: 0, y: 3, width: 3, height: 9, rx: 1.5, ry: 1.5,
        fill: typeColorOf(h.type),
      }),
      // lane 名（本地化）。
      createElement('text', {
        key: 'name',
        'data-anic-graph-lane-header-name': h.type,
        x: 8, y: 11, fontSize: 9.5, fontWeight: 'bold',
        fill: token('anic-text-strong'),
      }, name),
      // 计数（命中/总数）。数字用等宽字形（tabular-nums 是 CSS 属性，不是 SVG 属性 ——
      // 直接写在 SVG 元素上 React 会警告它不是 DOM 属性；改走 style 才是有效通道）。
      createElement('text', {
        key: 'count',
        'data-anic-graph-lane-header-count-text': h.type,
        x: 8 + nameWidth(name), y: 11, fontSize: 8.6,
        fill: token('anic-text-dim'),
        style: { fontVariantNumeric: 'tabular-nums' },
      }, text),
      // 分隔细线：表头带的下沿 = 下一段内容的上沿（视觉上"这段到此为止"）。
      createElement('line', {
        key: 'rule',
        'data-anic-graph-lane-header-rule': h.type,
        x1: 0, y1: h.h - 0.5, x2: 112, y2: h.h - 0.5,
        stroke: token('anic-border-strong'), strokeWidth: 0.6, opacity: 0.55,
      }),
    );
  });
}

/**
 * 本列该段里"命中筛选"的节点数。
 *
 * `LaneHeaderPlacement.ids` 由布局给出（布局是唯一知道段结构的地方），
 * 所以这里无需反查全图 —— 只看本段的 id 列表。
 */
function countHit(
  h: LaneHeaderPlacement,
  matching: ReadonlySet<string>,
): number | null {
  let hit = 0;
  for (const id of h.ids) if (matching.has(id)) hit += 1;
  return hit;
}

/**
 * 名称像素宽度（CJK 宽、ASCII 窄）。
 *
 * 为什么自己算：表头是 SVG `<text>`，没有 layout 引擎告诉我们文本多宽。
 * 用 `displayWidth`（`graphNodeStyle`）——那是本仓已有的 CJK 宽度表，
 * 复用它避免两套宽度算法。
 */
function nameWidth(name: string): number {
  let w = 0;
  for (const ch of name) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 9.5 : 5.4;
  return w;
}
