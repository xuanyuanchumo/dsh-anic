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
import { createElement, type ReactElement } from 'react';
import { token } from '../../shared/tokens.ts';
import { t } from '../i18n.ts';

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
