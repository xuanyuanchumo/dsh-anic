/**
 * 治理预算分区（P3 · ui-domain-plan:135，cycle-24）。
 *
 * 数据源（既有路由，零新增 host 面）：
 *   - GET /anic/governance/budget → BudgetReport（governanceRoute.ts:68）
 *     { totalBytes, fileCount, dirCount, status: normal|warn|alert,
 *       warnBytes, alertBytes, largestFiles: [{path,bytes}] }
 *
 * 白盒叙事：.cycles/ 工作区的磁盘预算此前只在 CLI 可见（checkBudget）——
 * 本分区把「治理数据自身占了多少、离告警阈值还有多远、谁在吃空间」呈现到面板。
 *
 * 纯函数渲染器范式：不持状态、不发请求（数据获取在面板统一 usePanelFetch），
 * 与 ledger/hitl 分区同构。data=null → 整区不渲染（不伪造空态）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { isObjectLike } from '../live/fetchJson.ts';
import { t } from '../../i18n.ts';

/** GET /anic/governance/budget 响应（与 host/governance/budget.ts BudgetReport 对齐）。 */
export interface BudgetJson {
  totalBytes: number;
  fileCount: number;
  dirCount: number;
  status: 'normal' | 'warn' | 'alert';
  warnBytes: number;
  alertBytes: number;
  /** 大文件 Top 5（>1MB 才进榜，host 侧约定）。 */
  largestFiles: Array<{ path: string; bytes: number }>;
}

export const BUDGET_URL = '/anic/governance/budget';

/** 形状守卫：数值三件套 + 合法 status + largestFiles 数组才采信（防半截响应进渲染）。 */
export function isBudget(v: unknown): v is BudgetJson {
  if (!isObjectLike(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.totalBytes !== 'number' || typeof o.warnBytes !== 'number' || typeof o.alertBytes !== 'number') return false;
  if (typeof o.fileCount !== 'number' || typeof o.dirCount !== 'number') return false;
  if (o.status !== 'normal' && o.status !== 'warn' && o.status !== 'alert') return false;
  return Array.isArray(o.largestFiles);
}

/** 字节数人性化（面板行内）：B/KB/MB/GB，一位小数（<10 时）否则取整。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const text = value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 状态色（与仪表带/账本同款语义三通道：normal 绿 / warn 琥珀 / alert 红）。 */
function statusColor(status: BudgetJson['status']): string {
  if (status === 'alert') return token('anic-fail');
  if (status === 'warn') return token('anic-warn-text');
  return token('anic-pass');
}

/**
 * 渲染治理预算分区。
 * data=null（未拉取/路由缺失）→ 整区不渲染。
 * 余量条语义：填充宽度 = totalBytes / alertBytes（封顶 100%）；warn 阈值处画
 * 竖线刻度（用户可读出「离告警还有多远」与「warn 线在哪」两个事实）。
 */
export function renderBudget(data: BudgetJson | null): ReactElement | null {
  if (data === null) return null;

  const fillPct = data.alertBytes > 0 ? Math.min(100, (data.totalBytes / data.alertBytes) * 100) : 100;
  const warnPct = data.alertBytes > 0 ? Math.min(100, (data.warnBytes / data.alertBytes) * 100) : 100;

  const bar = createElement(
    'div',
    {
      'data-anic-budget-bar': data.status,
      role: 'img',
      // 整条余量条一个 aria 标签（屏阅读器无需逐段听）：现状 + 阈值语义。
      'aria-label': t('budget.barLabel', { used: humanBytes(data.totalBytes), warn: humanBytes(data.warnBytes), alert: humanBytes(data.alertBytes) }),
      style: { position: 'relative', height: 8, borderRadius: 4, background: token('anic-surface-active'), margin: '4px 10px 2px', overflow: 'visible' },
    },
    // 填充：当前用量占 alert 阈值的比例（颜色随状态走语义三通道）。
    createElement('div', {
      'data-anic-budget-fill': 'true',
      style: { width: `${fillPct.toFixed(1)}%`, height: '100%', borderRadius: 4, background: statusColor(data.status) },
    }),
    // warn 刻度线：绝对定位竖线（alert=100% 右缘即容器边界，不另画）。
    createElement('div', {
      'data-anic-budget-warnmark': 'true',
      style: { position: 'absolute', top: -2, bottom: -2, left: `${warnPct.toFixed(1)}%`, width: 2, background: token('anic-warn-text'), opacity: 0.85 },
    }),
  );

  const stats = createElement(
    'div',
    { 'data-anic-budget-stats': 'true', style: { padding: '2px 10px 4px', fontSize: 11, color: token('anic-text-faint') } },
    t('budget.stats', { used: humanBytes(data.totalBytes), files: String(data.fileCount), dirs: String(data.dirCount) }),
  );

  const largest = data.largestFiles.length > 0
    ? createElement(
        'div',
        { 'data-anic-budget-largest': 'true', style: { padding: '0 10px 6px' } },
        createElement('div', { style: { fontSize: 11, fontWeight: 600, color: token('anic-text'), padding: '2px 0' } }, t('budget.largest')),
        ...data.largestFiles.map((f, i) => createElement(
          'div',
          { key: `${f.path}-${String(i)}`, 'data-anic-budget-file': 'true', style: { display: 'flex', gap: 8, fontSize: 11, padding: '1px 0', color: token('anic-text') } },
          createElement('span', { style: { color: token('anic-text-faint'), minWidth: 72, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, humanBytes(f.bytes)),
          createElement('span', { style: { wordBreak: 'break-all' }, title: f.path }, f.path),
        )),
      )
    : null;

  return createElement(
    'div',
    { 'data-anic-budget-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}`, paddingBottom: 6 } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', padding: '6px 10px 2px', fontSize: 11, color: token('anic-text') } },
      createElement('strong', {}, t('budget.title')),
      createElement('span', { 'data-anic-budget-status': data.status, style: { color: statusColor(data.status), fontWeight: 600 } }, t(`budget.status_${data.status}`)),
    ),
    bar,
    stats,
    largest,
  );
}
