/**
 * 工具栏「搜索 + 命中跳转」组（cycle-84 · V 战线，从 graphToolbarRender 拆出）。
 *
 * ## 为什么搜索组需要三条通道（不是一条）
 *
 * 169 节点的图上，"找到某个节点"有三种真实意图，缺任何一种都会让人反复试错：
 *   ① **回车直达**——知道大概叫什么，想立刻到那儿（键盘路径，不必抬手点鼠标）；
 *   ② **命中胶囊**——重名/近似名时自己挑（如 "gate" 命中上百条，第一个未必是）；
 *   ③ **计数**——"搜了但一个都没有"与"还没搜"必须可区分，否则用户以为搜索坏了。
 *
 * ## 为什么命中列表有界
 *
 * 见 `graphTrace.matchNodes`：无界列表会把工具栏撑成一面墙，且每次按键都要重排
 * 上百个元素。上限 6 条 + `共 M 条` 计数，既省又诚实。
 *
 * ## 纯渲染
 *
 * 无 hook、无状态；调用方传值传回调，本函数只产元素数组。拆出的直接原因是
 * `graphToolbarRender` 到 291 行（250 行纪律）。新文件进 `GRAPH_FILES` 递归扫描域，
 * 只用 stub 支持的 API。
 */
import { createElement, type ReactElement } from 'react';
import { t } from '../../i18n.ts';

export interface SearchGroupInput {
  /** 当前查询串（受控 input 的 value）。 */
  query: string;
  /** 命中前 N 条（空查询应为空数组）。 */
  searchMatches: { id: string; label: string }[];
  /** 命中总数（可大于 searchMatches.length）。 */
  searchTotal: number;
  onQuery: (q: string) => void;
  /** 跳转并把视口居中。 */
  onJump: (id: string) => void;
  /** 当前游标（cycle-85；缺省 0）。 */
  activeIndex?: number;
  /** ↑/↓ 移动游标（缺省不响应方向键）。 */
  onMoveActive?: (delta: number) => void;
  /** Enter：跳到游标所指命中（缺省跳第一条）。 */
  onJumpActive?: () => void;
}

export function renderSearchChildren(input: SearchGroupInput): ReactElement[] {
  const { query, searchMatches, searchTotal, onQuery, onJump } = input;
  const active = Math.max(0, Math.min(input.activeIndex ?? 0, Math.max(0, searchMatches.length - 1)));
  const children: ReactElement[] = [
    createElement('input', {
      key: 'search',
      type: 'search',
      'data-anic-graph-search': 'true',
      value: query,
      placeholder: t('graph.searchPlaceholder'),
      'aria-label': t('graph.searchLabel'),
      onChange: (ev: { target: { value: string } }) => { onQuery(ev.target.value); },
      // 回车 = 跳到第一条命中。最常用的"我知道它大致叫什么"路径。
      onKeyDown: (ev: { key: string; preventDefault: () => void }) => {
        // ↑/↓ 在候选里移动（不离开输入框，保持"边打字边挑"的手感）。
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          if (searchMatches.length === 0) return;
          ev.preventDefault();
          input.onMoveActive?.(ev.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (ev.key !== 'Enter') return;
        const target = searchMatches[active] ?? searchMatches[0];
        if (target === undefined) return;
        ev.preventDefault();
        if (input.onJumpActive !== undefined) input.onJumpActive();
        else onJump(target.id);
      },
      style: { fontSize: 11, padding: '2px 6px', minWidth: 128, maxWidth: 220, borderRadius: 9 },
    }),
  ];

  // 计数：`0` 也要显示——"搜了但一个都没有"与"还没搜"必须可区分。
  if (query.trim() !== '') {
    children.push(createElement('span', {
      key: 'match-count',
      'data-anic-graph-match-count': String(searchTotal),
      style: { fontSize: 10, fontVariantNumeric: 'tabular-nums', opacity: 0.8 },
    }, searchTotal === 0 ? t('graph.noMatch') : t('graph.matchCount', { total: String(searchTotal) })));
  }

  // 命中胶囊：点一条即跳转（键盘用户可 Tab 到达，均有可访问名）。
  for (const [i, m] of searchMatches.entries()) {
    const isActive = i === active;
    children.push(createElement('button', {
      key: `jump-${m.id}`,
      type: 'button',
      'data-anic-graph-jump': m.id,
      'data-anic-graph-jump-active': isActive ? 'true' : 'false',
      // aria-current 给 AT 播报"当前候选"（游标是键盘态，颜色不够）。
      'aria-current': isActive ? 'true' : undefined,
      'aria-label': t('graph.jumpTo', { label: m.label, id: m.id }),
      title: m.id,
      onClick: () => { onJump(m.id); },
      style: {
        fontSize: 10, padding: '0 6px', borderRadius: 8, cursor: 'pointer',
        border: isActive ? '2px solid currentColor' : '1px solid currentColor',
        background: 'transparent', fontWeight: isActive ? 'bold' : undefined,
        maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
    }, m.label));
  }
  return children;
}
