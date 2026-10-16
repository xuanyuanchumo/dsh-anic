/**
 * 组织状态全景（连通性 + 透明性）— React 渲染。
 *
 * 展示：cycle 统计 + 信任分 + 自主级 + 熔断状态 + 带检测 + 流开关。
 *
 * 接口形状对齐 src/host/evolution/orgStatus.ts OrgStatus。
 *
 * P0-ORG-STRING 修因：本模块原先 `return string`（拼 HTML 串），调用点
 * WorkflowGraphPanel 把它当 **React 子节点**传入
 * （`createElement('div', {...}, renderOrgStatus(orgStatus))`）。
 * React 会转义字符串子节点，于是整段 `<section class="anic-org-cycles">…`
 * 以**可见的字面标记文本**渲染出来，org 分区实际上从来没有成为 UI。
 * 转义只发生在"字符串作为文本子节点"这一条路径上，所以任何字符串返回型
 * 渲染器都不可能在 React 下工作（除非走 dangerouslySetInnerHTML）。
 *
 * 修法：改为返回 ReactElement（与 renderDiagnostics / renderStepTrace 同形），
 * 并把 `esc()` 一并删除——React 自身转义文本子节点，手工转义在 React 路径下
 * 是死代码，且它只转义 `&<>` 而不转义引号，一旦将来有人改用
 * `dangerouslySetInnerHTML` 就会变成属性注入面。删掉它同时消除了这个陷阱。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

export interface OrgStatusJson {
  cycles: { total: number; latest: string | null; converged: number; failed: number };
  ledger: { entries: number; valid: boolean };
  trust: { scores: Record<string, { score: number; approve: number; total: number }>; recommendedBand: string };
  /** configuredBand 为 P1 修复新增的可选字段：配置声明的自主级（与 currentBand 分离，降级时可观测） */
  autonomy: { currentBand: string; configuredBand?: string; breakers: string[]; action: string };
  band: { current: string; trend: string };
  flows: { selfInit: boolean; agentsOrchestration: boolean };
  timestamp: string;
}

/** 信任分阈值 → 语义色（单一来源，避免两处阈值漂移）。 */
function scoreColor(score: number): string {
  return score >= 70 ? token('anic-pass') : score >= 40 ? token('anic-doubt') : token('anic-fail');
}

/** 带状态 → 语义色。 */
function bandColor(band: string): string {
  return band === 'normal' ? token('anic-pass') : band === 'warn' ? token('anic-doubt') : token('anic-fail');
}

const H4 = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;
const P = { fontSize: 11, color: token('anic-text-dim'), margin: '2px 0' } as const;
const UL = { margin: '2px 0', paddingLeft: 18 } as const;

export function renderOrgStatus(status: OrgStatusJson): ReactElement {
  const trustEntries = Object.entries(status.trust.scores);

  const trustSection =
    trustEntries.length > 0
      ? createElement(
          'section',
          { className: 'anic-org-trust' },
          createElement('h4', { style: H4 }, t('org.trustTitle')),
          createElement(
            'ul',
            { style: UL },
            ...trustEntries.map(([gate, ts]) =>
              createElement(
                'li',
                { key: gate, style: P },
                `${gate}: `,
                createElement('span', { style: { color: scoreColor(ts.score) } }, `${String(ts.score)}%`),
                ` (${String(ts.approve)}/${String(ts.total)})`,
              ),
            ),
          ),
          createElement('p', { style: P }, t('org.recommendedBand'), createElement('strong', null, status.trust.recommendedBand)),
        )
      : null;

  const breakers =
    status.autonomy.breakers.length > 0
      ? createElement(
          'ul',
          { className: 'anic-breakers', style: UL },
          ...status.autonomy.breakers.map((b) =>
            createElement('li', { key: b, className: 'anic-breaker-tripped', style: P }, t('org.breaker', { breaker: b })),
          ),
        )
      : createElement('p', { style: P }, t('org.noBreakers'));

  return createElement(
    'div',
    { 'data-anic-org': 'section', style: { padding: '8px 10px', borderTop: `1px solid ${token('anic-border')}` } },
    createElement(
      'section',
      { className: 'anic-org-cycles' },
      createElement('h4', { style: H4 }, t('org.cyclesTitle')),
      createElement(
        'p',
        { style: P },
        t('org.cyclesLine', { total: status.cycles.total, latest: status.cycles.latest ?? '—', converged: status.cycles.converged, failed: status.cycles.failed }),
      ),
    ),
    // P1-5：门禁账本两字段此前被丢弃（服务端返回了 entries/valid 但没渲染）——
    // 账本完整性是自主级升降的信任根基，不可见 = 不可审计。
    createElement(
      'section',
      { className: 'anic-org-ledger' },
      createElement('h4', { style: H4 }, t('org.ledgerTitle')),
      createElement(
        'p',
        { style: P },
        t('org.ledgerLine', {
          entries: status.ledger.entries,
          validity: status.ledger.valid ? t('org.ledgerValid') : t('org.ledgerInvalid'),
        }),
        ' ',
        createElement('span', { style: { color: status.ledger.valid ? token('anic-pass') : token('anic-fail') } },
          status.ledger.valid ? '✓' : '✕'),
      ),
    ),
    trustSection,
    createElement(
      'section',
      { className: 'anic-org-autonomy' },
      createElement('h4', { style: H4 }, t('org.autonomyTitle')),
      createElement(
        'p',
        { style: P },
        t('org.current'),
        createElement('strong', null, status.autonomy.currentBand),
        // P1（autonomy 双投影矛盾）：配置级与运行级不一致时显式示出，
        // 让「降级中」可观测，而不是让用户看到两个互相矛盾的 L 值。
        status.autonomy.configuredBand !== undefined && status.autonomy.configuredBand !== status.autonomy.currentBand
          ? t('org.configuredSuffix', { band: status.autonomy.configuredBand })
          : '',
        t('org.action', { action: status.autonomy.action }),
      ),
      breakers,
    ),
    createElement(
      'section',
      { className: 'anic-org-band' },
      createElement('h4', { style: H4 }, t('org.bandTitle')),
      createElement(
        'p',
        { style: P },
        t('org.current'),
        createElement('span', { style: { color: bandColor(status.band.current) } }, status.band.current),
        t('org.trend', { trend: status.band.trend }),
      ),
    ),
    createElement(
      'section',
      { className: 'anic-org-flows' },
      createElement('h4', { style: H4 }, t('org.flowsTitle')),
      createElement(
        'ul',
        { style: UL },
        createElement('li', { style: P }, `${t('org.selfInit')}: ${status.flows.selfInit ? t('org.enabledMark') : t('org.disabledMark')}`),
        createElement('li', { style: P }, `${t('org.orchestration')}: ${status.flows.agentsOrchestration ? t('org.enabledMark') : t('org.disabledMark')}`),
      ),
    ),
    // P1-5：时间戳——org 全景是"快照"而非"实时"，不带时间戳的快照会让陈旧数据
    // 被当成现状（与 live 分区的 generatedAt 同一纪律）。
    createElement('p', { style: { ...P, color: token('anic-text-faint') }, 'data-anic-org-snapshot-at': status.timestamp }, t('org.snapshotAt', { timestamp: status.timestamp })),
  );
}
