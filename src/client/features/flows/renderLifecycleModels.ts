/**
 * 生命周期面板的**生存分析 / 控制图**读数块（cycle-90 · 从
 * `renderLifecycleMetrics.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 拆出的理由（职责，不是行数）
 *
 * `renderLifecycleMetrics.ts` 是**编排层**（把各模型的读数排成一张表）；
 * 本文件是**两个需要额外解释的模型**的渲染：
 *
 * - **KM 生存分析**：中位数 + 置信区间 + episode/删失计数；
 * - **EWMA 控制图**：通过率 + 越界点 + **灵敏度提示**。
 *
 * 这两个模型都需要**额外一段解释**（CI 的宽窄意味着什么、3σ 在本口径下
 * 触不到意味着什么），把它们单独成文件，解释与实现就在一起 ——
 * 混在编排层里，解释很容易被后续改动挤掉。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import {
  ewmaSigmaFloor,
  failureSensitivity,
  humanizeMs,
  isAvailable,
  unavailableReason,
  type LifecycleEwmaJson,
  type LifecycleSurvivalJson,
  type MetricProjectionJson,
} from './lifecycleTypes.ts';

/** 一个度量行（label + 值 + 可选注解）。 */
export function metricRow(id: string, label: string, value: string, note?: string): ReactElement {
  return createElement(
    'div',
    { key: id, 'data-anic-lifecycle-metric': id, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' } },
    createElement('span', { style: { fontSize: 11, opacity: 0.75 } }, label),
    createElement(
      'span',
      { style: { fontSize: 11, fontWeight: 600 } },
      value,
      note === undefined ? null : createElement('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 4 } }, note),
    ),
  );
}

/** 不可判定时的行（显示服务端给的 reason/detail，绝不显示 0）。 */
export function unavailableRow(
  id: string,
  label: string,
  p: MetricProjectionJson<unknown> | undefined,
): ReactElement {
  const reason = unavailableReason(p);
  return createElement(
    'div',
    { key: id, 'data-anic-lifecycle-metric': id, 'data-anic-lifecycle-unavailable': 'true', style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' } },
    createElement('span', { style: { fontSize: 11, opacity: 0.75 } }, label),
    createElement('span', { style: { fontSize: 11, color: token('anic-text-faint') } }, reason ?? t('flowLifecycle.insufficient', { n: '0', min: '0' })),
  );
}

/** 生存分析读数（KM 中位数 + CI + episode/删失计数）。 */
export function renderSurvival(
  survival: MetricProjectionJson<LifecycleSurvivalJson> | undefined,
): ReactElement {
  if (!isAvailable(survival)) {
    return unavailableRow('survival', t('flowLifecycle.survivalMedian'), survival);
  }
  const v = survival.value;
  const median = humanizeMs(v?.medianMs);
  const ci = Array.isArray(v?.medianCi95Ms) && v.medianCi95Ms.length === 2 ? v.medianCi95Ms : null;
  const ciText = ci !== null ? `${humanizeMs(ci[0]) ?? '—'} ~ ${humanizeMs(ci[1]) ?? '—'}` : undefined;
  return createElement(
    'div',
    { key: 'survival' },
    metricRow(
      'survival',
      t('flowLifecycle.survivalMedian'),
      median ?? '—',
      ciText === undefined ? undefined : t('flowLifecycle.survivalCi'),
    ),
    typeof v?.n === 'number'
      ? metricRow(
        'episodes',
        t('flowLifecycle.repairEpisodes'),
        String(v.n),
        `${String(v.events ?? 0)} / ${t('flowLifecycle.censored')} ${String(v.censored ?? 0)}`,
      )
      : null,
  );
}

/** 控制图读数（通过率 + 越界点 + 灵敏度提示 + run 边界口径）。 */
export function renderControlChart(
  control: MetricProjectionJson<LifecycleEwmaJson> | undefined,
): ReactElement {
  if (!isAvailable(control)) {
    return unavailableRow('passRate', t('flowLifecycle.runPassRate'), control);
  }
  const v = control.value;
  const rate = typeof v?.pHat === 'number' ? `${(v.pHat * 100).toFixed(1)}%` : '—';
  // ⚠️ run 级口径下 3σ 判据**几乎不可达**（实测 LCL=−0.5048 ≤ 0），
  // 所以报「需要 N 次失败」是**误导**（N 无穷大）。诚实的表达是报
  // **σ 数地板**：连续失败再多，EWMA 也只到中心线下方 ~1.81σ ⇒ 3σ 触不到。
  const floor = ewmaSigmaFloor(v?.pHat);
  const sens = failureSensitivity(v?.pHat);
  return createElement(
    'div',
    { key: 'control' },
    metricRow(
      'passRate',
      t('flowLifecycle.runPassRate'),
      rate,
      `${t('flowLifecycle.runs')} ${String(v?.n ?? 0)}`,
    ),
    typeof v?.violations?.length === 'number'
      ? metricRow('outOfControl', t('flowLifecycle.outOfControl'), String(v.violations.length))
      : null,
    v?.degenerate !== true && floor !== null
      ? createElement(
        'div',
        {
          key: 'sensitivity',
          'data-anic-lifecycle-sensitivity': 'true',
          'data-anic-lifecycle-sigma-floor': floor.toFixed(2),
          style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' },
        },
        // sens !== null 时 3σ 确实可达（p̄ 极高时）⇒ 报次数；
        // 否则报 σ 地板 + 「3σ 触不到」的事实。
        sens !== null
          ? t('flowLifecycle.sensitivity', { n: String(sens) })
          : t('flowLifecycle.sensitivityFloor', { n: floor.toFixed(2) }),
      )
      : null,
    // run 边界口径（聚类是启发式，必须说明）。
    createElement(
      'div',
      { key: 'runBoundary', 'data-anic-lifecycle-run-boundary': 'true', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
      t('flowLifecycle.runBoundary', { n: '5' }),
    ),
  );
}
