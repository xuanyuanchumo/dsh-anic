/**
 * 自举分区渲染（cycle-89 · 纯函数，无状态、无请求）。
 *
 * ## 这个分区回答的三个问题（每一条都对应一次真实误判）
 *
 * ① **自举现在是什么状态**——状态 + 轮次 + 最近一次评估分/门禁裁决同排可见。
 *    此前这三项只存在于 `.cycles/self-bootstrap.json`，面板上完全看不到，
 *    于是「自举已收敛」与「自举早已炸掉」在 UI 上长得一模一样。
 * ② **这个结论还作数吗**——`stale` 横幅 + 点名「变了哪几项」。真实事故：
 *    10-28 的 `EXHAUSTED` 压住了 10-30 的全 PASS，人读到的结论比项目事实旧两天。
 * ③ **要怎么办**——可重启时给「重置事实基线」按钮（只在可重启形态出现；
 *    进行中被点重启会打断正在跑的评估）。
 *
 * ## 为什么事实基线用「三元组行」而不是表格
 *
 * 表格在 320px 宽的面板里会把 sha 折成两行且列错位（`table-layout` 默认 auto）。
 * 每项一行「标签 · 值 · 补充」在窄屏天然折行，且每行都有 `data-anic-bootstrap-fact`
 * 锚点——契约测试可以逐项断言，不必解析整块文本。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { type BootstrapFactsJson, type BootstrapHistoryEntry, type BootstrapJson, canRestart, staleOf } from './bootstrapTypes.ts';

/** 窄屏可读的行式布局（每项一行；标签定宽，值可折行）。 */
const ROW = { display: 'flex', flexWrap: 'wrap' as const, gap: '0 8px', alignItems: 'baseline', fontSize: 11, margin: '1px 0' } as const;
const LABEL = { color: token('anic-text-faint'), minWidth: 62 } as const;
const VALUE = { color: token('anic-text'), wordBreak: 'break-all' as const } as const;
const H = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;

/** 状态 → 语义色（收敛绿 / 耗尽红 / 进行中黄 / 空闲灰）。 */
function statusColor(status: string): string {
  if (status === 'CONVERGED') return token('anic-pass');
  if (status === 'EXHAUSTED') return token('anic-fail');
  if (status === 'IDLE') return token('anic-text-faint');
  return token('anic-doubt');
}

/** ISO → `MM-DD HH:mm`（跨年场景不缩写年份；非法串原样返回）。 */
function shortAt(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso === '') return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m === null ? iso : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 短哈希（7 位足够人工核对；完整值在 title 里，悬停可见）。 */
function shortSha(sha: string | null | undefined): string {
  if (typeof sha !== 'string' || sha === '') return '—';
  return sha.length > 9 ? sha.slice(0, 9) : sha;
}

/** 一条事实行（`data-anic-bootstrap-fact` 锚点 + 可选 title 全文）。 */
function factRow(key: string, label: string, value: string, title?: string): ReactElement {
  return createElement(
    'div',
    { key, 'data-anic-bootstrap-fact': key, style: ROW },
    createElement('span', { style: LABEL }, label),
    createElement('span', { style: VALUE, ...(title !== undefined ? { title } : {}) }, value),
  );
}

/** 事实基线网格：缺字段显示 `—`（不隐藏——「没采到」本身就是信息）。 */
function renderFacts(facts: BootstrapFactsJson): ReactElement {
  const evalReport = facts.evalReport ?? null;
  const evalText = evalReport === null
    ? '—'
    : `${evalReport.path ?? '?'} · ${shortSha(evalReport.sha256)}`;
  const active = facts.activeCycles === undefined ? '—' : String(facts.activeCycles);
  const archived = facts.archivedCycles === undefined ? '—' : String(facts.archivedCycles);
  return createElement(
    'section',
    { 'data-anic-bootstrap-facts': 'true' },
    createElement('h4', { style: H }, t('bootstrap.factsTitle')),
    factRow('git', t('bootstrap.factGit'), `${shortSha(facts.gitHead)}${facts.gitDirty === true ? ' *' : ''}`,
      facts.gitHead ?? undefined),
    factRow('cycle', t('bootstrap.factCycle'), `${facts.currentCycle ?? '—'} / ${facts.currentPhase ?? '—'}`),
    factRow('ledger', t('bootstrap.factLedger'), `${String(facts.ledgerEntries ?? '—')} · ${shortSha(facts.ledgerHead)}`,
      facts.ledgerHead ?? undefined),
    factRow('eval', t('bootstrap.factEval'), evalText, evalReport?.path ?? undefined),
    // 活跃/归档**分列**是「归档只当历史」的呈现面：一个数会把 89 轮历史读成 89 份活性产物。
    factRow('cycles', t('bootstrap.factCycles'), `${active} ${t('bootstrap.activeUnit')} / ${archived} ${t('bootstrap.archivedUnit')}`),
    factRow('skill', t('bootstrap.factSkill'), facts.skillVersion ?? '—'),
  );
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
    // ② 陈旧横幅：点名变动项 + 存档时间 + 重启入口（这是「历史产物压过最新事实」的解法）。
    stale.stale
      ? createElement(
          'div',
          { 'data-anic-bootstrap-stale': 'true', role: 'status', style: { ...ROW, marginTop: 4, padding: '3px 6px', borderRadius: 4, background: 'transparent', border: `1px dashed ${token('anic-doubt')}` } },
          createElement('span', { style: { color: token('anic-doubt'), fontWeight: 600, fontSize: 10 } }, t('bootstrap.staleBadge')),
          createElement('span', { style: { fontSize: 10, color: token('anic-text-dim') } },
            stale.changed.length > 0
              ? t('bootstrap.staleChanged', { changed: stale.changed.join(', ') })
              : t('bootstrap.staleUnknown')),
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
      ? renderFacts(v.facts)
      : createElement('p', { 'data-anic-bootstrap-nofacts': 'true', style: { fontSize: 10, color: token('anic-text-faint'), margin: '4px 0 0' } },
          t('bootstrap.noFacts')),
    renderHistory(v.history ?? []),
    renderFailure(v),
  );
}
