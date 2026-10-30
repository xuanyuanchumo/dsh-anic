/**
 * 生命周期指标的**面板渲染**（cycle-90）—— 归属量化条下方的一组读数。
 *
 * ## 为什么放在「流程」分区（而不是新开一个分区）
 *
 * 面板有 18 个固定 feature 目录，新增分区要过 G-FEAT 守卫（成本高）。
 * 而这组读数与流程分区**讲的是同一件事**（「这些流程跑得怎么样」）——
 * 归属量化条回答「它们属于谁」，本组回答「它们跑了多久、成不成功」。
 * 放在一起，读者不用在两个分区间来回跳。
 *
 * ## 五条诚实渲染纪律
 *
 * 1. **取不到 ≠ 零**：模型不可判定 → 显示服务端给的 `detail`
 *    （「样本不足（n=7 < 20），不可判定」），**不显示 0**。
 * 2. **归属覆盖常驻**：孤儿比例必须显示 —— 否则读者会把「只统计了 3%」
 *    当成「统计了全部」。
 * 3. **截断徽标常驻**：窗口截断时必须显示告警。
 * 4. **灵敏度必须说**：run 级口径下 3σ 判据**几乎不可达**（实测 LCL=−0.5048 ≤ 0，
 *    EWMA 距中心线最多 ~1.81σ）—— 读者若不知道，会把「没报警」读成「没问题」。
 *    面板显示的是 **σ 数地板**（不是「需要 N 次失败」—— N 无穷大，报它是误导）。
 * 5. **长尾形态要给结论**：Gini 双尺度 → 形态（long-tail / balanced），
 *    让读者知道「尾部很重」还是「整体不均衡」。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import {
  humanizeMs,
  isAvailable,
  type LifecycleMetricsJson,
  type MetricProjectionJson,
} from './lifecycleTypes.ts';
// 生存分析 / 控制图读数块已拆至 renderLifecycleModels.ts（T3 ≤250 行）。
import {
  metricRow,
  renderControlChart,
  renderSurvival,
  unavailableRow as lifecycleUnavailableRow,
} from './renderLifecycleModels.ts';

/** 一个度量行（label + 值 + 可选注解）。 */
const row = metricRow;
/** 不可判定时的行（显示服务端给的 reason/detail，绝不显示 0）。 */
const unavailableRow = lifecycleUnavailableRow;

/**
 * 渲染生命周期指标读数。
 *
 * @param data 矩阵响应（null = 还没拉到 → 不渲染主体）
 */
export function renderLifecycleMetrics(data: LifecycleMetricsJson | null): ReactElement | null {
  if (data === null) return null;

  const win = data.window ?? {};
  const attr = data.attribution ?? {};
  const survival = data.gateRepairTime;
  const control = data.gatePassRate;
  const duration = data.duration;
  const inequality = data.inequality;

  // 「完全没有事实」⇒ 如实说明（不渲染一张全空的假表）。
  //
  // ⚠️ 判据是「有没有**任何**事实」，不是「有没有**可用读数**」——
  // 后者会把「模型不可判定」误判成「没有数据」，从而吞掉不可判定行
  // （那是本面板最重要的一类信息：取不到 ≠ 零）。
  const hasAnyFact = isAvailable(survival) || isAvailable(control) || isAvailable(duration) || isAvailable(inequality)
    || survival !== undefined || control !== undefined || duration !== undefined || inequality !== undefined
    || (typeof attr.orphans === 'number' && attr.orphans > 0)
    || (typeof win.everWritten === 'number' && win.everWritten > 0);
  if (!hasAnyFact) {
    return createElement(
      'div',
      { 'data-anic-lifecycle': 'empty', style: { fontSize: 11, opacity: 0.7, padding: '4px 0' } },
      t('flowLifecycle.insufficient', { n: '0', min: '1' }),
    );
  }

  const children: ReactElement[] = [];

  // 归属覆盖（常驻 —— 「只统计了 3%」必须让读者看见）。
  if (typeof attr.coverage === 'number') {
    children.push(row(
      'attribution',
      t('flowLifecycle.unattributed'),
      `${(attr.coverage * 100).toFixed(1)}%`,
      typeof attr.orphans === 'number' ? t('flowLifecycle.orphansNote', { n: String(attr.orphans) }) : undefined,
    ));
  }

  // 截断徽标（常驻 —— 截断窗口下「近期优于历史」可能是假象）。
  if (win.truncated === true) {
    children.push(createElement(
      'div',
      { key: 'truncation', 'data-anic-lifecycle-truncated': 'true', style: { fontSize: 10, color: token('anic-warn-text'), padding: '2px 0' } },
      typeof win.truncationWarning === 'string' && win.truncationWarning !== ''
        ? win.truncationWarning
        : t('flowLifecycle.truncated', { n: String(win.evicted ?? 0) }),
    ));
  }

  // 门禁修复时间（KM）—— 渲染在 renderLifecycleModels.ts（解释与实现同处）。
  children.push(renderSurvival(survival));
  // 跑门禁通过率（EWMA 控制图）—— 渲染在 renderLifecycleModels.ts。
  children.push(renderControlChart(control));

  // 耗时分位数（双口径）。
  if (isAvailable(duration)) {
    const v = duration.value;
    children.push(row('p50', t('flowLifecycle.p50'), humanizeMs(v?.p50) ?? '—'));
    children.push(row('p95Type7', t('flowLifecycle.p95Type7'), humanizeMs(v?.p95Type7) ?? '—'));
    children.push(row('p95Rank', t('flowLifecycle.p95NearestRank'), humanizeMs(v?.p95NearestRank) ?? '—'));
  } else {
    children.push(unavailableRow('duration', t('flowLifecycle.p50'), duration));
  }

  // Gini 双尺度 + 形态结论。
  if (isAvailable(inequality)) {
    const v = inequality.value;
    const g = typeof v?.gini === 'number' ? v.gini.toFixed(3) : '—';
    const gl = typeof v?.giniLog === 'number' ? v.giniLog.toFixed(3) : '—';
    children.push(row(
      'gini',
      t('flowLifecycle.gini'),
      g,
      `log ${gl}`,
    ));
    if (v?.shape === 'long-tail') {
      children.push(createElement(
        'div',
        { key: 'shape', 'data-anic-lifecycle-shape': 'long-tail', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
        t('flowLifecycle.shapeLongTail'),
      ));
    } else if (v?.shape === 'balanced') {
      children.push(createElement(
        'div',
        { key: 'shape', 'data-anic-lifecycle-shape': 'balanced', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
        t('flowLifecycle.shapeBalanced'),
      ));
    }
  } else {
    children.push(unavailableRow('gini', t('flowLifecycle.gini'), inequality));
  }

  return createElement(
    'div',
    { 'data-anic-lifecycle': 'true', style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' } },
    // 分组标题（读数多起来后需要路标）。
    createElement(
      'div',
      { key: 'title', 'data-anic-lifecycle-title': 'true', style: { fontSize: 11, fontWeight: 600, opacity: 0.85, paddingBottom: 2 } },
      t('flowLifecycle.title'),
    ),
    // 数据窗口行（读者需要知道这些数字覆盖多长时间）。
    createElement(
      'div',
      { key: 'window', 'data-anic-lifecycle-window': 'true', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
      t('flowLifecycle.window'),
    ),
    // 账本口径行（H1–H4 账本内 0 条 —— 不说读者会以为 HITL 门也统计了）。
    typeof win.retained === 'number'
      ? createElement(
        'div',
        { key: 'ledger', 'data-anic-lifecycle-ledger': 'true', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
        t('flowLifecycle.ledgerNote', { n: String(win.retained), gates: 'G0–G3' }),
      )
      : null,
    ...children,
  );
}
