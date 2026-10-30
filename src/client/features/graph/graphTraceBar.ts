/**
 * 追溯状态条（cycle-84 · V 战线）——「你在追什么、上下游各几个、是否被截断」。
 *
 * ## 为什么必须是独立的一条、且带退出按钮
 *
 * 追溯是**模式**：进入后整张图的颜色编码变了。模式类交互的第一原则是"当前模式
 * 必须可见、必须可退"——否则用户只看到一圈变了色的描边，不知道发生了什么，
 * 更不知道按什么键能回去（Escape 不一定被想起）。所以这条同时承担三件事：
 * ① 显示 root id；② 显示上/下游计数（回答"追到了什么"）；③ 一个显式退出按钮。
 *
 * ## 为什么截断要单独说一句
 *
 * `buildTrace` 有深度上限（3 跳）。触到上限时结果**不是完整的因果链**。若不标注，
 * 用户会以为"下游只有 2 个"，而实际还有更远的影响——那是**误导**，比不显示更糟。
 *
 * ## 纯渲染（无 hook、无状态）
 *
 * 与 `renderBudget` / `renderClosure` 同纪律：调用方传状态与回调，本文件只出元素树。
 */
import { createElement, type ReactElement } from 'react';
import type { TraceResult } from './graphTrace.ts';
import { t } from '../../i18n.ts';

export interface TraceBarInput {
  trace: TraceResult;
  /** 退出追溯（回到普通视图）。 */
  onExit: () => void;
}

export function renderTraceBar(input: TraceBarInput): ReactElement {
  const { trace, onExit } = input;
  const root = trace.root ?? '';
  return createElement(
    'div',
    {
      'data-anic-graph-trace-bar': 'true',
      'data-anic-graph-trace-root': root,
      'data-anic-graph-trace-up': String(trace.up.size),
      'data-anic-graph-trace-down': String(trace.down.size),
      'data-anic-graph-trace-truncated': trace.truncated ? 'true' : 'false',
      // role=status：进入/退出追溯是异步交互结果，AT 需要听到。
      role: 'status',
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        fontSize: 10.5, padding: '2px 8px',
      },
    },
    createElement('span', { key: 'label' }, t('graph.traceRoot', { id: root })),
    createElement('span', { key: 'up', 'data-anic-graph-trace-up-label': 'true' },
      t('graph.traceUp', { count: String(trace.up.size) })),
    createElement('span', { key: 'down', 'data-anic-graph-trace-down-label': 'true' },
      t('graph.traceDown', { count: String(trace.down.size) })),
    trace.truncated
      ? createElement('span', { key: 'trunc', 'data-anic-graph-trace-trunc': 'true' }, t('graph.traceTruncated'))
      : null,
    createElement('button', {
      key: 'exit', type: 'button', 'data-anic-graph-trace-exit': 'true',
      'aria-label': t('graph.traceExit'),
      onClick: onExit,
      style: {
        fontSize: 10, padding: '0 8px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid currentColor', background: 'transparent',
      },
    }, t('graph.traceExit')),
  );
}
