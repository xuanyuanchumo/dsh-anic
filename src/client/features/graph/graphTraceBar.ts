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
import { blastRadiusStats, type TraceResult } from './graphTrace.ts';
import { t } from '../../i18n.ts';
import { gt } from './graphText.ts';

export interface TraceBarInput {
  trace: TraceResult;
  /** 退出追溯（回到普通视图）。 */
  onExit: () => void;
}

export function renderTraceBar(input: TraceBarInput): ReactElement {
  const { trace, onExit } = input;
  const root = trace.root ?? '';
  /**
   * 影响半径分档（cycle-95）：1/2/3 跳各多少。
   *
   * 为什么状态条要显示它：`traceUp/traceDown` 只给总数（"上游 5"），用户接着
   * 要问"这 5 个是直接原因还是三步之外的波及"——这正是 blast radius 的意义。
   * 三档全 0 时**不显示**（还没追到东西），比显示三个 0 诚实。
   */
  const blast = blastRadiusStats(trace);
  const upFilled = blast.up.total > 0;
  const downFilled = blast.down.total > 0;
  return createElement(
    'div',
    {
      'data-anic-graph-trace-bar': 'true',
      'data-anic-graph-trace-root': root,
      'data-anic-graph-trace-up': String(trace.up.size),
      'data-anic-graph-trace-down': String(trace.down.size),
      'data-anic-graph-trace-truncated': trace.truncated ? 'true' : 'false',
      // 分档读数进 DOM：三个数字是"影响多远"的唯一定量证据，视觉挤在一行里
      // 读不准，必须能被断言（同 data-anic-trace 纪律）。
      'data-anic-graph-trace-up-d1': String(blast.up.d1),
      'data-anic-graph-trace-up-d2': String(blast.up.d2),
      'data-anic-graph-trace-up-d3': String(blast.up.d3),
      'data-anic-graph-trace-down-d1': String(blast.down.d1),
      'data-anic-graph-trace-down-d2': String(blast.down.d2),
      'data-anic-graph-trace-down-d3': String(blast.down.d3),
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
    // 影响半径读数（cycle-95）：每侧一行，形如「1 跳 2 · 2 跳 1 · 3 跳 0」。
    // 文案走 graph.traceDepth（"{depth} 跳"），与深度分档共用同一个词表键。
    upFilled
      ? createElement('span', { key: 'up-blast', 'data-anic-graph-trace-up-blast': 'true' },
          [1, 2, 3]
            .map((d) => `${gt('traceDepth', { depth: String(d) })} ${String(d === 1 ? blast.up.d1 : d === 2 ? blast.up.d2 : blast.up.d3)}`)
            .join(' · '))
      : null,
    downFilled
      ? createElement('span', { key: 'down-blast', 'data-anic-graph-trace-down-blast': 'true' },
          [1, 2, 3]
            .map((d) => `${gt('traceDepth', { depth: String(d) })} ${String(d === 1 ? blast.down.d1 : d === 2 ? blast.down.d2 : blast.down.d3)}`)
            .join(' · '))
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
