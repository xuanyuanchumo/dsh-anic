/**
 * 路径模式状态条（cycle-109 · U4，从 `graphExtras.ts` 搬出）——**本文件回答**：
 * "找路径这件事现在进行到哪、结果是什么、还能不能退"。
 *
 * ## 为什么必须搬出来（不是风格选择）
 *
 * `graphExtras.ts` 搬出前 249 行（`split('\n').length` 口径已是 250）——本轮要给它
 * 加"候选路径列表"与"反向可达"两件事，内联必破 T3 ≤250 的机械硬限。边界沿职责切：
 * 本文件回答"路径这一条读数条"，`graphExtras.ts` 回答"图区有哪几条读数条、什么时候
 * 整块不渲染"。`graphExtras` 保留 `renderPathBar` 的**转出**，调用面零变更。
 *
 * ## 状态条为什么必须有（模式类交互的第一原则）
 *
 * 路径模式是**模式**：进入后节点点击语义整体改写（点一下不再打开详情，而是设端点）。
 * 模式必须"可见 + 可退"，否则用户点了节点发现没弹抽屉、却不知道为什么，也找不到
 * 出口。这条同时回答三件事：现在要你干什么（选起点/选终点）、选完了吗、怎么退。
 *
 * ## 三种"没找到"为什么各自一句话
 *
 * `unreachable`（换端点）、`tooLong`（抬跳数上限）、`duplicate`（换一个节点）是三种
 * **不同的补救动作**；合并成一句等于没有提示。`reverseOnly`（cycle-109）是第四种：
 * 正向走不通但**反向其实是通的**——正确答案是把端点对调，不是"没有这条路"。
 *
 * ## 候选路径列表（cycle-109 · U4 ④）
 *
 * 只在"除首条外还有别的等价路径"时出现（≥2 条），且**不重复**首条（首条已经在
 * 状态文字里逐跳写出）。零占位：只有一条路径时整块不渲染。
 */
import { createElement, type ReactElement } from 'react';
import { MAX_PATH_HOPS, type PathResult } from './graphPathFind.ts';
import type { PathModel } from './graphPathMode.ts';
import { gt } from './graphText.ts';
import { t } from '../../i18n.ts';

/**
 * 状态条该显示的文案（`PathStatus` 的**唯一**文案映射点）。
 *
 * 为什么放在这里而不是渲染函数内部：纯函数可以直接表驱动断言（含
 * `reverseOnly` 与 `unreachable` 两态**必须不同**这条判据），不必渲染元素树。
 */
export function pathStatusTextOf(model: PathModel): string {
  switch (model.status) {
    case 'pickStart': return gt('pathPickStart');
    case 'pickEnd': return gt('pathPickEnd');
    case 'duplicate': return t('graph.pathFindInvalid');
    // 四种失败/半成功**必须分开说**：每种对应的补救动作不同（见文件头）。
    case 'unreachable': return t('graph.pathFindNoPath');
    case 'tooLong': return t('graph.pathFindTooLong', { hops: String(MAX_PATH_HOPS) });
    case 'reverseOnly': return t('graph.pathReverseOnly', { hops: String(model.length) });
    case 'found': return t('graph.pathFindResult', {
      hops: String(model.length),
      // 路径写进文本而不是只靠高亮：高亮在灰度/强制对比下会消失，文本不会。
      path: [...model.highlight].join(' → '),
    });
  }
}

/** 单条候选路径（序号从 2 起：第 1 条已经写在状态文字里）。 */
function renderCandidate(result: PathResult, index: number): ReactElement {
  return createElement('span', {
    key: `cand-${String(index)}`,
    'data-anic-graph-path-candidate': String(index),
    'data-anic-graph-path-candidate-length': String(result.length),
  }, `${String(index + 2)}. ${t('graph.pathFindResult', {
    hops: String(result.length),
    path: result.path.join(' → '),
  })}`);
}

/**
 * 路径模式状态条（`role=status`：AT 自动播报模式切换与结果）。
 *
 * `data-anic-graph-path-*` 锚点把"当前在选择什么 / 结果是什么 / 有没有反向"写进
 * DOM —— 状态是异步交互的结果，没有锚点就只能靠肉眼验收。
 */
export function renderPathBar(input: { model: PathModel; onExit: () => void }): ReactElement {
  const { model } = input;
  // 候选 = 首条之外的其余路径；只有一条时整块不渲染（零占位）。
  const alternatives = model.candidates.slice(1);
  return createElement(
    'div',
    {
      key: 'path-bar',
      'data-anic-graph-path-bar': 'true',
      'data-anic-graph-path-status': model.status,
      'data-anic-graph-path-from': model.from ?? 'none',
      'data-anic-graph-path-to': model.to ?? 'none',
      'data-anic-graph-path-length': String(model.length),
      // 反向可达进 DOM：它是"方向反了"与"真的不通"的唯一机器可读分野。
      'data-anic-graph-path-direction': model.status === 'reverseOnly' ? 'reverse' : 'forward',
      role: 'status',
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        fontSize: 10.5, padding: '2px 8px',
      },
    },
    createElement('span', { key: 'label', 'data-anic-graph-path-label': 'true' }, pathStatusTextOf(model)),
    // 起点的影响半径：选好起点后"从这儿出发能波及多远"是下一步决定的依据。
    model.blast === null || model.blast.down.total === 0
      ? null
      : createElement('span', { key: 'blast', 'data-anic-graph-path-blast': 'true' },
          t('graph.traceDown', { count: String(model.blast.down.total) })),
    alternatives.length === 0
      ? null
      : createElement('span', {
          key: 'candidates',
          'data-anic-graph-path-candidates': 'true',
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, opacity: 0.9 },
        }, ...alternatives.map((r, i) => renderCandidate(r, i))),
    createElement('button', {
      key: 'exit', type: 'button', 'data-anic-graph-path-exit': 'true',
      'aria-label': t('graph.pathFind'),
      onClick: input.onExit,
      style: {
        fontSize: 10, padding: '0 8px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid currentColor', background: 'transparent',
      },
    }, gt('pathExit')),
  );
}