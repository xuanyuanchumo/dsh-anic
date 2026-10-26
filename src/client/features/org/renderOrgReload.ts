/**
 * 构建新鲜度 / 最近一次重载（cycle-80 WS-2）—— org 分区的 reload 子节。
 *
 * ## 被守卫的缺陷（本轮缺口）
 *
 * 热更新链路（`anic_reload_self` / `POST /anic/api/reload` / `.cycles/reload-history.json`）
 * 落地后，"面板上这张图到底是**哪一版 dist** 跑出来的、上一次重载**成没成**"在 UI 上
 * 完全不可见——用户只能凭"改了没生效"去反推，而"没生效"有三种完全不同的原因：
 * dist 没重建（stale）、重载被拒（refused）、hmr 不可用（unavailable）。三者都必须在
 * 同一行可读，否则修 bug 的第一步（确认跑的是不是新代码）永远靠猜。
 *
 * ## 为什么单独一文件
 *
 * `renderOrgStatus.ts` 已贴 T3 250 行上限（本文件拆出后它仍在范围内），与 cycle-72
 * closure 分区拆分的先例同构（一域一文件 / 单文件 ≤250 行）。
 *
 * ## 降级纪律（防空壳、防假绿）
 *   - `reload` 缺省（旧宿主 / 未部署该能力）→ **整节不渲染**，不留空壳标题；
 *   - 无重载历史 → 不渲染"最近一次重载"行（它不是当前事实），但 **fresh/stale 必须显示**
 *     ——那是当前事实，不是历史；
 *   - `error` 存在 → `role="alert"` 响亮成行，绝不静默吞成"没有重载记录"。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { OrgStatusJson } from '../../components/panelTypes.ts';

const H4 = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;
const P = { fontSize: 11, color: token('anic-text-dim'), margin: '2px 0' } as const;
/** 行内 flex-wrap：revision + 状态 + 相对时间在窄面板必然超宽，折行而不是溢出。 */
const ROW = { ...P, display: 'flex', flexWrap: 'wrap' as const, gap: '2px 10px', alignItems: 'baseline' } as const;

/**
 * ISO → `YYYY-MM-DD HH:mm`。
 *
 * 与 renderOrgStatus.ts 的 shortAt 同形但**刻意各自保留**：两个模块互相 import 会
 * 形成运行时环（renderOrgStatus → renderOrgReload → renderOrgStatus），而为一个
 * 8 行格式化函数新开中立模块的收益低于它的 import 面成本。
 */
function shortAt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m !== null ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

/**
 * 相对时间（面板上"多久以前"比绝对时间更能回答"这是不是刚才那次"）。
 * 非法时间戳 → null（调用方回落到绝对时间，不伪造"刚刚"）。
 */
function relTime(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const diff = now - at;
  if (diff < 60_000) return t('org.reloadAgoJustNow');
  const min = Math.floor(diff / 60_000);
  if (min < 60) return t('org.reloadAgoMin', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('org.reloadAgoHour', { n: hours });
  return t('org.reloadAgoDay', { n: Math.floor(hours / 24) });
}

/** 重载终态 → 语义色：成功=绿、失败=红、被拒/不可用/进行中=中性或警示。 */
function statusColor(status: string): string {
  if (status === 'reloaded') return token('anic-pass');
  if (status === 'failed') return token('anic-fail');
  if (status === 'refused' || status === 'unavailable') return token('anic-warn-text');
  return token('anic-text-dim'); // in-flight 等
}

/**
 * 渲染「构建与重载」小节。
 *
 * @param reload host `org-status.reload` 投影；undefined = 旧宿主/未部署 ⇒ 整节不渲染
 */
export function renderOrgReload(reload: OrgStatusJson['reload']): ReactElement | null {
  if (reload === undefined) return null;
  const fresh = !reload.stale;
  const last = reload.lastStatus;
  const ago = reload.lastAt === null ? null : relTime(reload.lastAt, Date.now());
  return createElement(
    'section',
    { className: 'anic-org-reload', 'data-anic-org-reload': 'true', 'aria-label': t('org.reloadAria', { count: reload.historyCount }) },
    createElement('h4', { style: H4 }, t('org.reloadTitle')),
    // ① 当前事实：新鲜度。stale 用警示色——它等价于"你现在看到的是旧 dist"的告警，
    //    比任何历史行都重要（所以即使零历史也显示，见降级纪律）。
    createElement(
      'p',
      {
        'data-anic-reload-row': 'freshness',
        ...(reload.stale ? { 'data-anic-reload-stale': 'true' } : { 'data-anic-reload-fresh': 'true' }),
        style: { ...ROW, color: fresh ? token('anic-pass') : token('anic-warn-text') },
      },
      fresh ? `✓ ${t('org.reloadFresh')}` : `⚠ ${t('org.reloadStale')}`,
      reload.revision !== null ? t('org.reloadRevision', { revision: reload.revision }) : '',
    ),
    // ② 最近一次重载：无历史 → 一行如实说明（不是空壳，也不冒充有历史）。
    //    失败态红字 + role=alert：异步重载失败与"点了没反应"必须可区分。
    last !== null
      ? createElement(
          'p',
          {
            'data-anic-reload-row': 'last',
            ...(last === 'failed' ? { role: 'alert' } : {}),
            style: { ...ROW, color: statusColor(last) },
          },
          t('org.reloadLast', {
            status: last,
            at: reload.lastAt !== null ? shortAt(reload.lastAt) : '—',
          }),
          ago !== null ? ` · ${ago}` : '',
        )
      : createElement('p', { 'data-anic-reload-none': 'true', style: { ...P, color: token('anic-text-faint') } },
          t('org.reloadNone')),
    // ③ 读数失败：响亮成行（坏 JSON 不得吞成"没有重载记录"）。
    reload.error !== null
      ? createElement(
          'p',
          { 'data-anic-reload-error': 'true', role: 'alert', style: { ...P, color: token('anic-fail') } },
          t('org.reloadError', { error: reload.error }),
        )
      : null,
    // ④ 诚实提示：hmr 可用性只能按请求探测，本段是只读快照（不冒充能力探测结果）。
    reload.hmrProbeHint !== ''
      ? createElement('p', { 'data-anic-reload-hint': 'true', style: { ...P, fontSize: 10, color: token('anic-text-faint') } },
          reload.hmrProbeHint)
      : null,
  );
}
