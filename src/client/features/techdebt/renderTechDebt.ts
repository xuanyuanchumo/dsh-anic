/**
 * tech-debt 队列面板渲染（cycle-54 T-5401）。
 *
 * 数据面：宿主 GET /anic/api/tech-debt/list（evolutionRoute 注册——G-C3
 * 消费侧读面）→ {open, openCount, resolvedCount, skipped}。
 *
 * 为什么这个分区该存在：tech-debt 提案是 PatchEngine 的产物（评估失败维度
 * → .cycles/tech-debt/*.json），是「组织欠了什么债、还了什么」的白盒面。
 * 宿主读面端点自 cycle-16 就在，但面板从未消费——纯后端白盒不是白盒。
 *
 * 设计：
 * - 三段呈现：open（工作队列——人/上游 agent 待执行）/ resolved（已消费，
 *   带 consumedAt/consumedBy 审计字段）/ skipped（非提案形态文件——如实
 *   报告不吞，自举轮自由形态提案就是这一类）；
 * - 严重度着色复用 skillhealth 的语义色约定（critical 红 / high 琥珀 /
 *   medium 淡 / low 更淡）——两个债务语义面同源视觉；
 * - 空队列是合法状态（没有欠债），渲染零欠债行而非空态引导；
 * - open 数量上限 TECH_DEBT_RENDER_CAP：与 GROUP_RENDER_CAP 同款截限
 *   纪律（超限显示「还有 N 条」——数据在路由，渲染有界）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { isObjectLike } from '../../components/fetchJson.ts';

export const TECH_DEBT_URL = '/anic/api/tech-debt/list';

/** 与宿主 techDebtQueue.ts TechDebtFile/TechDebtListing 对齐的最小客户端形状。 */
export interface TechDebtEntryJson {
  id: string;
  dimension: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  proposedAction: string;
  createdAt: string;
  resolved: boolean;
  /** 消费审计字段（resolved 条目由 markTechDebtConsumed 追加）。 */
  consumedAt?: string;
  consumedBy?: string;
}

export interface TechDebtListingJson {
  open: Array<{ file: string; entry: TechDebtEntryJson }>;
  openCount: number;
  resolvedCount: number;
  skipped: Array<{ file: string; reason: string }>;
}

/** open 条目渲染上限（截限纪律：渲染有界，数据在路由）。 */
const TECH_DEBT_RENDER_CAP = 12;

/** 响应守卫：open 数组 + 数值计数字段（防畸形数据进渲染层）。 */
export function isTechDebtListing(v: unknown): v is TechDebtListingJson {
  return isObjectLike(v)
    && Array.isArray((v as { open?: unknown }).open)
    && typeof (v as { openCount?: unknown }).openCount === 'number'
    && typeof (v as { resolvedCount?: unknown }).resolvedCount === 'number'
    && Array.isArray((v as { skipped?: unknown }).skipped);
}

/** 严重度 → 色（与 skillhealth 建议着色同源约定——债务语义面统一视觉）。 */
function severityColor(sev: TechDebtEntryJson['severity']): string {
  if (sev === 'critical') return token('anic-fail');
  if (sev === 'high') return token('anic-warn-text');
  return token('anic-text-dim');
}

/** 渲染单条 open 提案行。 */
function renderOpenEntry(rec: { file: string; entry: TechDebtEntryJson }, key: string): ReactElement {
  const e = rec.entry;
  return createElement(
    'div',
    {
      'data-anic-techdebt-entry': e.id,
      'data-anic-techdebt-severity': e.severity,
      key,
      style: { fontSize: 10, fontFamily: 'ui-monospace, monospace', padding: '2px 0', display: 'flex', gap: 6, alignItems: 'baseline' },
    },
    createElement('span', { style: { color: severityColor(e.severity), flexShrink: 0, minWidth: 44 } }, `[${e.severity}]`),
    createElement('span', { style: { color: token('anic-text-dim'), flexShrink: 0 } }, e.dimension),
    createElement('span', { style: { color: token('anic-text'), overflowWrap: 'anywhere' } }, e.description),
  );
}

/**
 * 渲染 tech-debt 队列分区主体（null=未拉到——不渲染伪造空态）。
 */
export function renderTechDebt(data: TechDebtListingJson | null): ReactElement | null {
  if (data === null) return null;
  const shown = data.open.slice(0, TECH_DEBT_RENDER_CAP);
  const hidden = data.open.length - shown.length;
  return createElement(
    'div',
    { 'data-anic-techdebt': 'true', style: { padding: '2px 10px' } },
    // 摘要行：欠债/已还/跳过三计数（量化白盒）。
    createElement(
      'div',
      { 'data-anic-techdebt-summary': 'true', style: { fontSize: 11, color: token('anic-text-dim'), paddingBottom: 2 } },
      t('techdebt.summary', { open: String(data.openCount), resolved: String(data.resolvedCount), skipped: String(data.skipped.length) }),
    ),
    data.open.length === 0
      ? createElement('div', { 'data-anic-techdebt-empty': 'true', style: { fontSize: 11, color: token('anic-text-faint') } }, t('techdebt.empty'))
      : createElement('div', { 'data-anic-techdebt-open': 'true', style: { display: 'flex', flexDirection: 'column' } },
          ...shown.map((rec, i) => renderOpenEntry(rec, rec.entry.id + String(i))),
          hidden > 0
            ? createElement('div', { key: 'more', 'data-anic-techdebt-more': String(hidden), style: { fontSize: 10, color: token('anic-text-faint') } },
                t('techdebt.more', { count: String(hidden) }))
            : null,
        ),
    data.resolvedCount > 0
      ? createElement('div', { 'data-anic-techdebt-resolved': 'true', style: { fontSize: 10, color: token('anic-text-faint'), paddingTop: 2 } },
          t('techdebt.resolvedCount', { count: String(data.resolvedCount) }))
      : null,
    data.skipped.length > 0
      ? createElement('div', { 'data-anic-techdebt-skipped': 'true', title: data.skipped.map((s) => `${s.file}: ${s.reason}`).join('\n'), style: { fontSize: 10, color: token('anic-text-faint') } },
          t('techdebt.skipped', { count: String(data.skipped.length) }))
      : null,
  );
}
