/**
 * 分区壳 + 关闭形态提示（B4 组件整合）。
 *
 * 提取自 WorkflowGraphPanel 里三组逐字重复的形状（ui-domain-plan §2.1）：
 *   ① 分区包裹层：borderTop + data-anic-X-wrap 锚点 + key（stepTrace/diagnostics 两处）；
 *   ② 数据行：fontSize:10 · faint · '4px 10px 0'（traceDataLine/diagDataLine 等）；
 *   ③ 不可用行：fontSize:11 · faint · '4px 10px'（traceUnavailable/diagUnavailable）；
 *   ④ 关闭形态一行文：fontSize:11 · warn · '6px 10px' + borderTop + data-anic-X-disabled
 *      （stepTrace/diagnostics/flowsview 三处完全同构，INV-30 关闭形态可观测的落点）。
 *
 * 纯函数渲染器（与各域 renderXxx 同构）：不持状态、不发请求。
 */
import { createElement, type ReactElement, type SyntheticEvent } from 'react';
import { token } from '../../shared/tokens.ts';
import { t } from '../i18n.ts';
import { foldPrefOf, writeFoldPref } from '../features/prefs/foldPrefs.ts';

export interface SectionWrapProps {
  /** 包裹层 key（面板 children 数组内唯一，随 flowTick 变化以强制重渲染）。 */
  key?: string;
  /** 包裹层锚点名（如 'data-anic-steptrace-wrap'）。 */
  anchorKey: string;
  /** 数据行文案（t() 结果）；省略则不渲染数据行。 */
  dataLine?: string;
  /** 分区主体；为 null 时渲染不可用行（unavailableText）。 */
  body: ReactElement | null;
  /** 主体不可用时的如实说明（t() 结果）。 */
  unavailableText?: string;
}

/** 分区包裹层：borderTop + 数据行 + 主体/不可用行（①②③ 的组合）。 */
export function renderSectionWrap({ key, anchorKey, dataLine, body, unavailableText }: SectionWrapProps): ReactElement {
  return createElement(
    'div',
    {
      ...(key !== undefined ? { key } : {}),
      [anchorKey]: 'true',
      style: { borderTop: `1px solid ${token('anic-border')}` },
    },
    dataLine !== undefined
      ? createElement('div', { style: { fontSize: 10, color: token('anic-text-faint'), padding: '4px 10px 0' } }, dataLine)
      : null,
    body ?? createElement('div', { style: { fontSize: 11, color: token('anic-text-faint'), padding: '4px 10px' } }, unavailableText ?? t('panel.notLoaded')),
  );
}

export interface SectionDisabledProps {
  /** 关闭形态锚点名（如 'data-anic-steptrace-disabled'）。 */
  anchorKey: string;
  /** 关闭说明文案（t() 结果，含开关 id 与契约指引）。 */
  text: string;
}

/** 关闭形态一行文（④）：分区隐藏时的如实说明（INV-30）。 */
export function renderSectionDisabled({ anchorKey, text }: SectionDisabledProps): ReactElement {
  return createElement(
    'div',
    {
      [anchorKey]: 'true',
      style: { fontSize: 11, color: token('anic-warn-text'), padding: '6px 10px', borderTop: `1px solid ${token('anic-border')}` },
    },
    text,
  );
}

/** 折叠开关的 tooltip（折叠记忆是持久偏好，用户可以据此理解行为）。 */
function foldHint(): string {
  return t('panel.foldMemoryHint');
}

/**
 * cycle-41（UI 研究 Top4b · 用户目标 B 面板丰富度）：可折叠分区壳。
 *
 * 原生 details/summary——零 JS 状态、静态可渲染、键盘可达（与 invocations 的
 * turn 分组同款机制）。
 *
 * cycle-71 T-7131 折叠策略收口（用户要求核心）：`open` 从「初值即 true」改为
 * **受控值** `foldPrefOf(id) ?? defaultOpen`，onToggle 立即写记忆
 * （features/prefs/foldPrefs，PREFS_KEY 的 folds 段）。默认值由调用方给：
 * 只有 live 分区传 true，其余静态产物分区 false（诊疗 diagnostics 与关闭
 * 形态兜底 hitl 例外保留 true——理由见 panelSections 各调用点注释）。
 *
 * 为什么必须受控而不是「初值当受控值」（本改动钉死的工程风险）：
 * 旧实现靠「React 不触碰未变化的 DOM 属性」这一未文档化行为保住用户的
 * 手动折叠。改受控后受控 value 必须与用户操作同步（onToggle 写记忆 →
 * 下次渲染读回同值），否则 2s/4s tick 的任意数据更新都会把用户刚折叠的
 * 分区**弹回** open——tests/unit/foldPrefs.test.ts 有反向自检用例。
 *
 * 折叠状态不经 React state（无受控往返）：分区开关门控（INV-30 关闭形态）
 * 是「分区是否存在」，本壳是「分区是否收纳」——两个正交维度，互不替代。
 *
 * @param id 稳定标识（锚点 data-anic-fold 与 React key 同源——条件分区出现/
 *   消失时按 key 复用 DOM，折叠状态不因兄弟分区增删而丢失）。
 * @param title 摘要行标题（t() 结果）；@param children 分区主体。
 * @param defaultOpen 无折叠记忆时的默认展开态。默认 **false**（收纳）——用户
 *   要求「默认只展开最近一次已完成调用与运行时调用可视化」；显式传 true 的
 *   调用点必须在注释里写明理由。
 */
export function renderFoldableSection({ id, title, children, defaultOpen = false }: { id: string; title: string; children: ReactElement | ReadonlyArray<ReactElement | null> | null; defaultOpen?: boolean }): ReactElement {
  const open = foldPrefOf(id) ?? defaultOpen;
  return createElement(
    'details',
    {
      'data-anic-fold': id,
      // cycle-71 T-7131：与 data-anic-fold 并列的受控态锚点（测试与真机旅程可读，
      // 且使「受控 value 是否与用户操作同步」成为可断言的外部契约）。
      'data-anic-fold-state': open ? 'open' : 'closed',
      open,
      key: id,
      onToggle: (e: SyntheticEvent<HTMLDetailsElement>): void => {
        writeFoldPref(id, e.currentTarget.open);
      },
      style: { borderTop: `1px solid ${token('anic-border')}` },
    },
    createElement(
      'summary',
      {
        title: foldHint(),
        style: { cursor: 'pointer', userSelect: 'none', fontSize: 11, fontWeight: 600, color: token('anic-text-strong'), padding: '6px 10px 2px' },
      },
      title,
    ),
    children,
  );
}
