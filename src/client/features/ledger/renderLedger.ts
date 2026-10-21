/**
 * 账本事件流分区（B2 · P1 声明与实现断层修复，cycle-18）。
 *
 * 数据源（既有路由，零新增 host 面）：
 *   - GET /anic/api/ledger?limit=N → { total, entries[] }（ledgerRoute.ts:38）
 *   - GET /anic/api/ledger/verify  → { ok, total, brokenAt, reason }（ledgerRoute.ts:67）
 *
 * 白盒叙事：G0-G3 门禁的每次裁决都以哈希链条目留痕——本分区把「最近发生了
 * 什么裁决 + 链是否完整」直接呈现在面板上（此前只有 skill CLI 可见）。
 *
 * 纯函数渲染器范式：不持状态、不发请求（数据获取在面板统一 usePanelFetch），
 * 与 stepTrace/diagnostics/flows 分区同构。data=null → 整区不渲染（不伪造空态）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { isObjectLike } from '../../components/fetchJson.ts';
import { t } from '../../i18n.ts';

/** GET /anic/api/ledger 响应（与 host/runtime/ledger.ts LedgerEntry 对齐）。 */
export interface LedgerEntryJson {
  gate: string;
  gateName: string;
  result: 'PASS' | 'FAIL';
  detail: string;
  timestamp: string;
  previousHash: string | null;
  hash: string;
}

export interface LedgerListJson {
  total: number;
  entries: LedgerEntryJson[];
}

/** GET /anic/api/ledger/verify 响应。 */
export interface LedgerVerifyJson {
  ok: boolean;
  total: number;
  brokenAt: number | null;
  reason: string | null;
}

export const LEDGER_LIST_URL = '/anic/api/ledger?limit=12';
export const LEDGER_VERIFY_URL = '/anic/api/ledger/verify';

/** 分页 URL 工厂（cycle-24 P3 账本分页：服务端 ?limit&?offset 早已支持，本侧接线）。 */
export function ledgerListUrl(limit: number): string {
  return `/anic/api/ledger?limit=${String(limit)}`;
}

/** 形状守卫：entries 数组且首项含 gate/result 字段才采信（防半截响应进渲染）。 */
export function isLedgerList(v: unknown): v is LedgerListJson {
  if (!isObjectLike(v)) return false;
  const entries = (v as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return false;
  const first = entries[0] as Record<string, unknown> | undefined;
  if (first !== undefined && (typeof first.gate !== 'string' || typeof first.result !== 'string')) return false;
  return true;
}

export function isLedgerVerify(v: unknown): v is LedgerVerifyJson {
  return isObjectLike(v) && typeof (v as { ok?: unknown }).ok === 'boolean';
}

/** 短哈希：前 8 位（面板空间有限，完整 64 位在 title 悬停）。 */
function hash8(hash: string): string {
  return hash.slice(0, 8);
}

/** ISO 时间戳压短（面板行内）：MM-DD HH:mm。非法串原样返回（如实呈现）。 */
function shortTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m !== null ? `${m[1]!.slice(2)}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

const ROW_STYLE: Record<string, string> = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline',
  padding: '3px 10px', fontSize: '11px',
};

/**
 * 渲染账本事件流分区。
 * list=null（未拉取/路由缺失）→ 整区不渲染；verify=null → 链完整性行如实显示未验证。
 * actions（可选，cycle-24 分页）：hasMore=true 时渲染「显示更多」按钮，
 * onShowMore 由面板提供（同时抬 ledgerLimit 与 reloadKey——重拉即新 limit 生效）。
 */
export interface LedgerActions {
  hasMore: boolean;
  onShowMore: () => void;
}

export function renderLedger(list: LedgerListJson | null, verify: LedgerVerifyJson | null, actions?: LedgerActions): ReactElement | null {
  if (list === null) return null;
  if (!Array.isArray(list.entries) || list.entries.length === 0) return null;

  const chain = verify !== null
    ? verify.ok
      ? createElement('span', { 'data-anic-ledger-chain': 'ok', style: { color: token('anic-pass') } },
          t('ledger.chainOk', { total: String(verify.total) }))
      : createElement('span', { 'data-anic-ledger-chain': 'broken', style: { color: token('anic-fail') } },
          t('ledger.chainBroken', { at: String(verify.brokenAt) }))
    : createElement('span', { 'data-anic-ledger-chain': 'unknown', style: { color: token('anic-text-faint') } },
        t('ledger.chainUnknown'));

  return createElement(
    'div',
    { 'data-anic-ledger-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}`, paddingBottom: 6 } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', padding: '6px 10px 2px', fontSize: 11, color: token('anic-text') } },
      createElement('strong', {}, t('ledger.title', { shown: String(list.entries.length), total: String(list.total) })),
      chain,
    ),
    ...list.entries.map((e, i) => createElement(
      'div',
      { key: `${e.gate}-${e.timestamp}-${String(i)}`, 'data-anic-ledger-entry': e.result, style: { ...ROW_STYLE, color: token('anic-text') } },
      // 裁决语义色：PASS 绿 / FAIL 红（文字本身即通道，颜色是第二通道）
      createElement('span', { style: { color: e.result === 'PASS' ? token('anic-pass') : token('anic-fail'), fontWeight: 600 } }, e.result),
      createElement('span', { style: { fontWeight: 600 } }, e.gateName),
      createElement('span', { style: { color: token('anic-text-faint') } }, shortTime(e.timestamp)),
      // 哈希链指纹：title 悬停给完整值；previousHash=null（首条）如实显示创世
      createElement('span', { style: { color: token('anic-text-faint'), fontFamily: 'monospace' }, title: `${e.previousHash ?? 'genesis'} → ${e.hash}` },
        e.previousHash === null ? t('ledger.genesis') : hash8(e.hash)),
      e.detail !== '' ? createElement('span', { style: { color: token('anic-text-faint'), flexBasis: '100%' } }, e.detail) : null,
    )),
    // 分页footer：还有未展示条目时给「显示更多」（data-anic-ledger-more 契约标记）。
    actions !== undefined && actions.hasMore
      ? createElement('div', { style: { padding: '4px 10px 2px' } },
          createElement('button', {
            type: 'button',
            'data-anic-ledger-more': 'true',
            className: 'anic-btn',
            onClick: () => { actions.onShowMore(); },
          }, t('ledger.showMore', { shown: String(list.entries.length), total: String(list.total) })))
      : null,
  );
}
