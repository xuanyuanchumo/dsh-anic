/**
 * 流程归属量化条（cycle-89）—— 面板「流程」分区里的**归属率 / 孤儿 / 门禁证据覆盖**。
 *
 * ## 为什么需要它
 *
 * 用户要「白盒透明化、可视化流动」。此前 `flowJoin` 生产了归属数据，
 * 但**没有任何消费面** —— 面板上看不到「这些流程到底归属于哪些循环/相位/门禁」。
 * 这条量化条是那个出口。
 *
 * ## 诚实渲染纪律（三条，都写进代码）
 *
 * 1. **取不到 ≠ 零**：字段缺失时显示「—」，**不**显示 0%。
 *    「归属率 0%」与「读不到归属率」在面板上必须可区分 —— 前者是事实，后者是故障。
 * 2. **门禁证据按白名单校正**：只有门禁脚本本身的记录算证据
 *    （见 `flowMatrixTypes.isGateEvidenceScript`）。
 * 3. **无数据即无条**：整个分区没有记录时显示「暂无流程记录」，
 *    **不**渲染一张全是 0 的假表。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import {
  attributionRateOf,
  gateCoverageOf,
  orphanCountOf,
  phaseCountsOf,
  type FlowMatrixJson,
} from './flowMatrixTypes.ts';

/** 一个度量行（label + 值 + 可选注解）。 */
function metricRow(id: string, label: string, value: string, note?: string): ReactElement {
  return createElement(
    'div',
    { key: id, 'data-anic-flowmatrix-metric': id, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' } },
    createElement('span', { style: { fontSize: 11, opacity: 0.75 } }, label),
    createElement(
      'span',
      { style: { fontSize: 11, fontWeight: 600 } },
      value,
      note === undefined ? null : createElement('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 4 } }, note),
    ),
  );
}

/**
 * 渲染归属量化条。
 *
 * @param data 矩阵响应（null = 还没拉到 → 不渲染主体）
 */
export function renderFlowMatrix(data: FlowMatrixJson | null): ReactElement | null {
  if (data === null) return null;
  const total = typeof data.total === 'number' ? data.total : 0;
  const rate = attributionRateOf(data);
  const orphans = orphanCountOf(data);
  const phases = phaseCountsOf(data);
  const gates = gateCoverageOf(data);

  // 诚实空态：一条记录都没有 → 如实说明，不渲染假表。
  if (total === 0 && phases.length === 0 && gates.length === 0) {
    return createElement(
      'div',
      { 'data-anic-flowmatrix': 'empty', style: { fontSize: 11, opacity: 0.7, padding: '4px 0' } },
      t('flowMatrix.empty'),
    );
  }

  return createElement(
    'div',
    { 'data-anic-flowmatrix': 'true', style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' } },
    // 归属率
    metricRow(
      'attribution',
      t('flowMatrix.attributionLabel'),
      rate === null ? '—' : `${(rate * 100).toFixed(1)}%`,
      rate === null ? undefined : t('flowMatrix.attributedOf', { n: String(total) }),
    ),
    // 孤儿
    metricRow(
      'orphans',
      t('flowMatrix.orphanLabel'),
      orphans === null ? '—' : String(orphans),
      orphans === null ? undefined : t('flowMatrix.orphanNote'),
    ),
    // 六相分布
    phases.length === 0
      ? metricRow('phases', t('flowMatrix.phaseLabel'), t('flowMatrix.none'))
      : createElement(
        'div',
        { key: 'phases', 'data-anic-flowmatrix-metric': 'phases', style: { padding: '2px 0' } },
        createElement('span', { style: { fontSize: 11, opacity: 0.75 } }, t('flowMatrix.phaseLabel')),
        createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 } },
          ...phases.map((p) => createElement(
            'span',
            {
              key: p.phase,
              'data-anic-flowmatrix-phase': p.phase,
              style: {
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 3,
                border: `1px solid ${token('anic-border')}`,
                opacity: 0.85,
              },
            },
            `${p.phase} ${String(p.count)}`,
          )),
        ),
      ),
    // 门禁证据覆盖
    gates.length === 0
      ? metricRow('gates', t('flowMatrix.gateLabel'), t('flowMatrix.noGateEvidence'))
      : createElement(
        'div',
        { key: 'gates', 'data-anic-flowmatrix-metric': 'gates', style: { padding: '2px 0' } },
        createElement('span', { style: { fontSize: 11, opacity: 0.75 } }, t('flowMatrix.gateLabel')),
        createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 } },
          ...gates.map((g) => createElement(
            'span',
            {
              key: g.gate,
              'data-anic-flowmatrix-gate': g.gate,
              style: {
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 3,
                border: `1px solid ${token('anic-border')}`,
                color: token('anic-pass'),
              },
            },
            `${g.gate} ${String(g.flows)}`,
          )),
        ),
      ),
  );
}
