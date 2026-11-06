/**
 * Cycle 全景分区（cycle-108 从 renderOrgStatus.ts 拆出，守 ≤250 行）。
 *
 * 为什么单独成文件：原 cycles 分区只有一行统计，而本文件新增的**循环坐标漂移**
 * 判据需要 6 个原因码 × i18n 文案；塞回 renderOrgStatus（恰 248 行）会顶破 T3 上限。
 *
 * 展示纪律：
 *  - 一致时给**显式**一行 ✓（不说"没有漂移"就等于让用户自己推断）；
 *  - 漂移时 role="alert" + 逐条原因码（带三个坐标数字），建议下一循环一并给出；
 *  - 原因码 → i18n 键在客户端映射，宿主只回码与数字（跨语言不重复实现）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { OrgStatusJson } from '../../components/panelTypes.ts';

const H4 = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;
const P = { fontSize: 11, color: token('anic-text-dim'), margin: '2px 0' } as const;

/** 原因码 → i18n 键（未知码不静默丢：原样列出码名，便于上游新增码时有回声）。 */
const REASON_KEYS: Readonly<Record<string, string>> = {
  HEAD_AHEAD_OF_LIVE: 'org.cycleDriftHeadAhead',
  STATE_BEHIND_LIVE: 'org.cycleDriftStateBehind',
  STATE_AHEAD_OF_LIVE: 'org.cycleDriftStateAhead',
  STATE_MISSING: 'org.cycleDriftStateMissing',
  ARCHIVE_AHEAD_OF_LIVE: 'org.cycleDriftArchiveAhead',
};

type Drift = NonNullable<OrgStatusJson['cycles']['drift']>;
type Reason = NonNullable<Drift['reasons']>[number];

/** 一条原因：已知码走 i18n（参数只在码需要的字段上给），未知码原样显示码名。 */
function renderReason(reason: Reason, i: number): ReactElement {
  const key = REASON_KEYS[reason.code];
  const params: Record<string, string | number> = {};
  if (reason.head !== undefined) params.head = reason.head;
  if (reason.state !== undefined) params.state = reason.state;
  if (reason.live !== undefined) params.live = reason.live;
  if (reason.archived !== undefined) params.archived = reason.archived;
  return createElement(
    'li',
    { key: `${reason.code}-${String(i)}`, 'data-anic-cycle-drift-code': reason.code, style: P },
    key === undefined ? reason.code : t(key, params),
  );
}

export function renderOrgCycles(cycles: OrgStatusJson['cycles']): ReactElement {
  const drift = cycles.drift;
  const reasons = Array.isArray(drift?.reasons) ? drift.reasons : [];
  const drifted = drift?.drift === true && reasons.length > 0;

  return createElement(
    'section',
    { className: 'anic-org-cycles' },
    createElement('h4', { style: H4 }, t('org.cyclesTitle')),
    createElement(
      'p',
      { style: P },
      t('org.cyclesLine', {
        total: cycles.total,
        latest: cycles.latest ?? '—',
        converged: cycles.converged,
        failed: cycles.failed,
      }),
    ),
    drifted
      ? createElement(
          'section',
          {
            className: 'anic-org-cycle-drift',
            'data-anic-cycle-drift': 'true',
            'aria-label': t('org.cycleDriftTitle'),
            role: 'alert',
          },
          createElement('h4', { style: { ...H4, color: token('anic-fail') } }, t('org.cycleDriftTitle')),
          createElement(
            'ul',
            { style: { margin: '2px 0', paddingLeft: 18 } },
            ...reasons.map((r, i) => renderReason(r, i)),
          ),
          drift?.suggestedCycle !== undefined
            ? createElement('p', { style: P, 'data-anic-cycle-suggested': drift.suggestedCycle },
                t('org.cycleDriftSuggested', { cycle: drift.suggestedCycle }))
            : null,
        )
      : cycles.drift !== undefined
        ? createElement('p', { style: { ...P, color: token('anic-pass') }, 'data-anic-cycle-drift': 'false' },
            t('org.cycleDriftOk'))
        : null,
  );
}