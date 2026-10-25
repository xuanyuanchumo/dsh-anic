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
import type { OrgStatusJson } from '../../components/panelTypes.ts';

export type { OrgStatusJson } from '../../components/panelTypes.ts';

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

/** 单条自主级变更（响应字段的子形状——客户端只依赖 JSON 契约，不 import host 类型）。 */
type AutonomyTransition = NonNullable<OrgStatusJson['autonomy']['history']>[number];

/** 面板最多展示条数（与 host summarizeHistory 的默认 limit 同值，两处不漂移）。 */
const HISTORY_SHOWN = 5;

/** 变更行样式：`flexWrap` 是响应式关键——面板可拖窄，单行「L2 → L3 · 时间 · actor · 授权 · 豁免」必然超宽，不折行就被 overflow 裁掉半截。 */
const HISTORY_ROW = { display: 'flex', flexWrap: 'wrap' as const, gap: '2px 10px', alignItems: 'baseline', fontSize: 11 } as const;

/** ISO → `YYYY-MM-DD HH:mm`。非法串原样返回——如实呈现，不静默吞成空白。 */
function shortAt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m !== null ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

/**
 * 自主级变更时间线（cycle-78 缺口修复）。cycle-77 已把「谁在何时把 L? 改成 L?」写进
 * 结构化审计账（`.cycles/autonomy-history.json` → `org-status.autonomy.history`），但面板
 * 只画「当前 L?」——变更过程不可见：L4 是谁授权的、信任豁免是否发生，UI 上查不到。
 *
 * 纪律：空历史且无错误 → 整区不渲染（不留空壳）；historyError 响亮成行 + role=alert
 * （坏账不得吞成"没有变更"）；时间倒序取最近 5 条（ISO 字符串比较即时间序，避开
 * Date.parse 的 NaN 陷阱）；超出 +N 如实计数，total 优先取 historyCount。
 */
function renderAutonomyHistory(autonomy: OrgStatusJson['autonomy']): ReactElement | null {
  const rows = Array.isArray(autonomy.history) ? autonomy.history : [];
  const error = autonomy.historyError;
  if (rows.length === 0 && error === undefined) return null;
  const recent = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, HISTORY_SHOWN);
  const total = Math.max(autonomy.historyCount ?? 0, rows.length);
  const hidden = Math.max(0, total - recent.length);

  return createElement(
    'section',
    {
      className: 'anic-org-autonomy-history',
      'data-anic-org-autonomy-history': 'true',
      // 可访问性：容器有名 ⇒ section 成为 region 地标，读屏可一键跳到变更账
      'aria-label': t('org.autonomyHistoryAria', { shown: recent.length, total }),
    },
    createElement('h4', { style: H4 }, t('org.autonomyHistoryTitle')),
    error !== undefined
      ? createElement('p', { 'data-anic-autonomy-history-error': 'true', role: 'alert', style: { ...P, color: token('anic-fail') } },
          t('org.autonomyHistoryError', { error }))
      : null,
    recent.length > 0 ? createElement('ul', { style: UL }, ...recent.map((tr) => renderTransitionRow(tr))) : null,
    hidden > 0
      ? createElement('p', { 'data-anic-autonomy-hidden': String(hidden), style: P }, t('org.autonomyMore', { count: hidden }))
      : null,
  );
}

/** 一行变更：`L2 → L3` · 时间 · actor · 授权标记 ·（可选）信任豁免警示。 */
function renderTransitionRow(tr: AutonomyTransition): ReactElement {
  const human = tr.authorization === 'human';
  const exemption = tr.trustExemption;
  return createElement(
    'li',
    { key: `${tr.at}-${tr.from}-${tr.to}`, 'data-anic-autonomy-transition': tr.authorization, style: { ...P, ...HISTORY_ROW } },
    createElement('span', { style: { color: token('anic-text-strong'), fontWeight: 600 } },
      t('org.autonomyFromTo', { from: tr.from, to: tr.to })),
    createElement('span', { style: { color: token('anic-text-faint') } }, shortAt(tr.at)),
    createElement('span', null, t('org.autonomyActor', { actor: tr.actor })),
    // 授权来源是「谁负责」的第二通道：human 醒目（人显式承担风险），system 弱化（机器证据）；文案本身已可读。
    createElement('span', { style: { color: human ? token('anic-doubt') : token('anic-text-faint'), fontWeight: human ? 600 : 400 } },
      human ? t('org.authHuman') : t('org.authSystem')),
    // 信任豁免是「这条升级看起来像 bug，其实有人签字」的唯一线索，必须与变更同行可见。
    exemption !== undefined
      ? createElement('span', { 'data-anic-autonomy-exempt': 'true', style: { color: token('anic-fail'), fontWeight: 600 } },
          t('org.autonomyExempt', { avg: exemption.avg, threshold: exemption.threshold }))
      : null,
  );
}

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
      // cycle-78：自主级变更时间线接在自主级分区内——「当前是什么级」与
      // 「怎么变成这个级的」必须在同一视线内，否则用户要跨分区拼因果。
      renderAutonomyHistory(status.autonomy),
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
      // WE 8 规则违例（cycle-7 移植、cycle-9 接线）：违例事实被采集却不可见
      // —— 性能带异常的「为什么」必须白盒（warn/alarm 判定依据）。
      status.band.weViolations !== undefined && status.band.weViolations.length > 0
        ? createElement(
            'ul',
            { className: 'anic-org-we', style: UL, 'data-anic-we-count': String(status.band.weViolations.length) },
            ...status.band.weViolations.slice(0, 5).map((v, i) =>
              createElement('li', { key: `we-${String(i)}`, style: { ...P, color: token('anic-warn-text') } },
                v.desc ?? `WE 规则 ${String(v.rule)}`),
            ),
            status.band.weViolations.length > 5
              ? createElement('li', { key: 'we-more', style: P }, t('org.weMore', { count: String(status.band.weViolations.length - 5) }))
              : null,
          )
        : null,
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
