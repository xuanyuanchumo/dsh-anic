/**
 * 自举分区渲染（cycle-89 · 纯函数，无状态、无请求）。
 *
 * ## 这个分区回答的三个问题（每一条都对应一次真实误判）
 *
 * ① **自举现在是什么状态**——状态 + 轮次 + 最近一次评估分/门禁裁决同排可见。
 *    此前这三项只存在于 `.cycles/self-bootstrap.json`，面板上完全看不到，
 *    于是「自举已收敛」与「自举早已炸掉」在 UI 上长得一模一样。
 * ② **这个结论还作数吗**——`stale` 横幅 + 点名「变了哪几项」+ 当前事实摘要。
 *    真实事故：10-28 的 `EXHAUSTED` 压住了 10-30 的全 PASS，人读到的结论比
 *    项目事实旧两天。cycle-95 补的是第三条读数：只说"变了"而不给"现在是哪一份
 *    事实"，人无法核对，告警就退化成噪声。
 * ③ **要怎么办**——可重启时给「重置事实基线」按钮（只在可重启形态出现；
 *    进行中被点重启会打断正在跑的评估）。
 *
 * ★cycle-95 T3 拆分：事实行 / 摘要读数 / 短哈希与时间格式化移到
 *   `renderBootstrapFacts.ts`。拆分的界线是职责——把**一份事实基线读成人能核对的
 *   数字**与**把四段装配成一个分区**是两件事，前者可被单独契约测试。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { type BootstrapHistoryEntry, type BootstrapJson, canRestart, staleOf } from './bootstrapTypes.ts';
import { digestChip, renderFacts, ROW, shortAt } from './renderBootstrapFacts.ts';

const H = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;

/** 状态 → 语义色（收敛绿 / 耗尽红 / 进行中黄 / 空闲灰）。 */
function statusColor(status: string): string {
  if (status === 'CONVERGED') return token('anic-pass');
  if (status === 'EXHAUSTED') return token('anic-fail');
  if (status === 'IDLE') return token('anic-text-faint');
  return token('anic-doubt');
}

/** 轮次历史迷你条：高度按 evalScore（0-100），颜色按门禁裁决。 */
function renderHistory(history: readonly BootstrapHistoryEntry[]): ReactElement | null {
  const rows = history.filter((h) => typeof h.round === 'number').slice(-8);
  if (rows.length === 0) return null;
  return createElement(
    'section',
    { 'data-anic-bootstrap-history': String(rows.length) },
    createElement('h4', { style: H }, t('bootstrap.historyTitle')),
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 28, padding: '2px 0' } },
      ...rows.map((h) => {
        const score = typeof h.evalScore === 'number' ? h.evalScore : 0;
        const pass = h.gateVerdict === 'PASS';
        const hpx = Math.max(3, Math.round((Math.max(0, Math.min(100, score)) / 100) * 26));
        return createElement('div', {
          key: `r${String(h.round)}`,
          'data-anic-bootstrap-bar': `${String(h.round)}:${String(score)}:${h.gateVerdict ?? '—'}`,
          title: `#${String(h.round)} · ${t('bootstrap.barScore', { score: String(score) })} · ${h.gateVerdict ?? '—'}`,
          style: {
            width: 10, height: hpx, borderRadius: 2,
            background: pass ? token('anic-pass') : token('anic-fail'),
            opacity: 0.85,
          },
        });
      }),
    ),
  );
}

/** 最近一次失败原因（最多 4 条；空则不渲染，不留空壳）。 */
function renderFailure(v: BootstrapJson): ReactElement | null {
  const reasons = (v.lastFailure?.reasons ?? []).filter((r) => typeof r === 'string' && r !== '');
  if (reasons.length === 0) return null;
  return createElement(
    'section',
    { 'data-anic-bootstrap-failure': String(reasons.length), role: 'alert' },
    createElement('h4', { style: { ...H, color: token('anic-fail') } }, t('bootstrap.failureTitle')),
    createElement(
      'ul',
      { style: { margin: '2px 0', paddingLeft: 16 } },
      ...reasons.slice(0, 4).map((r, i) => createElement('li', { key: `f${String(i)}`, style: { fontSize: 10, color: token('anic-text-dim'), wordBreak: 'break-word' } }, r)),
    ),
    reasons.length > 4 ? createElement('p', { style: { fontSize: 10, color: token('anic-text-faint') } }, t('bootstrap.failureMore', { count: reasons.length - 4 })) : null,
  );
}

export interface BootstrapRenderHandlers {
  /** 「重置事实基线」按钮（可重启形态才出现；不传则不渲染按钮）。 */
  onRestart?: () => void;
  /** 按钮禁用态（重启进行中）。 */
  restartBusy?: boolean;
}

/** 自举分区主体（纯函数；所有锚点 `data-anic-bootstrap-*` 供契约断言）。 */
export function renderBootstrap(v: BootstrapJson, handlers: BootstrapRenderHandlers = {}): ReactElement {
  const status = v.status ?? 'IDLE';
  const stale = staleOf(v);
  const round = v.round ?? 0;
  const max = v.maxRounds ?? 0;
  const can = canRestart(v);
  const score = v.lastEvalScore === undefined ? '—' : String(v.lastEvalScore);
  const verdict = v.lastGateVerdict ?? '—';

  return createElement(
    'div',
    { 'data-anic-bootstrap': status, style: { padding: '6px 10px' } },
    // ① 状态行：状态胶囊 + 轮次 + 评估分 + 门禁裁决 + 重启次数（一行内可折行）。
    createElement(
      'div',
      { style: { ...ROW, alignItems: 'center', gap: '0 10px' } },
      createElement('span', {
        'data-anic-bootstrap-status': status,
        style: {
          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
          color: statusColor(status), border: `1px solid ${statusColor(status)}`,
        },
      }, status),
      createElement('span', { style: { fontSize: 11, color: token('anic-text') } },
        t('bootstrap.roundLine', { round: String(round), max: String(max) })),
      createElement('span', { style: { fontSize: 11, color: token('anic-text-dim') } },
        t('bootstrap.scoreLine', { score, verdict })),
      typeof v.restartCount === 'number' && v.restartCount > 0
        ? createElement('span', { 'data-anic-bootstrap-restarts': String(v.restartCount), style: { fontSize: 10, color: token('anic-text-faint') } },
            t('bootstrap.restartCount', { count: String(v.restartCount) }))
        : null,
    ),
    // ② 陈旧横幅：点名变动项 + 当前事实摘要 + 存档时间 + 重启入口
    //    （这是「历史产物压过最新事实」的解法）。
    stale.stale
      ? createElement(
          'div',
          { 'data-anic-bootstrap-stale': 'true', role: 'status', style: { ...ROW, marginTop: 4, padding: '3px 6px', borderRadius: 4, background: 'transparent', border: `1px dashed ${token('anic-doubt')}` } },
          createElement('span', { style: { color: token('anic-doubt'), fontWeight: 600, fontSize: 10 } }, t('bootstrap.staleBadge')),
          createElement('span', { style: { fontSize: 10, color: token('anic-text-dim') } },
            stale.changed.length > 0
              ? t('bootstrap.staleChanged', { changed: stale.changed.join(', ') })
              : t('bootstrap.staleUnknown')),
          // 摘要读数在**横幅里也出现**：陈旧告警的整个价值是"能不能核对"。
          digestChip(v, 'stale-digest'),
          createElement('span', { style: { fontSize: 10, color: token('anic-text-faint') } },
            t('bootstrap.factsAt', { at: shortAt(v.factsAt) })),
          handlers.onRestart !== undefined && can
            ? createElement('button', {
                type: 'button',
                'data-anic-bootstrap-restart': 'true',
                disabled: handlers.restartBusy === true,
                onClick: handlers.onRestart,
                style: {
                  fontSize: 10, padding: '1px 8px', cursor: handlers.restartBusy === true ? 'progress' : 'pointer',
                  color: token('anic-text-strong'), border: `1px solid ${token('anic-border')}`,
                  borderRadius: 4, background: 'transparent',
                },
              }, handlers.restartBusy === true ? t('bootstrap.restarting') : t('bootstrap.restart'))
            : null,
        )
      : null,
    // ③ 事实基线（当前项目事实，不是存档）。没有 facts（旧宿主/未跑过）则如实说明。
    v.facts !== null && v.facts !== undefined
      ? renderFacts(v)
      : createElement('p', { 'data-anic-bootstrap-nofacts': 'true', style: { fontSize: 10, color: token('anic-text-faint'), margin: '4px 0 0' } },
          t('bootstrap.noFacts')),
    renderHistory(v.history ?? []),
    renderFailure(v),
  );
}
