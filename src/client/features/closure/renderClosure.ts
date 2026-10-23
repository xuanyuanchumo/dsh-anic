/**
 * 闭环体检分区渲染（纯函数，L5）——GET /anic/api/closure-audit 的 JSON。
 *
 * 白盒诉求（用户原文「同时要白盒透明化、可视化流动等可观测性」）：把「注册了但没人消费 /
 * 产出了但没人读」这两张清单直接铺在面板上——此前这两个问题在本仓**没有任何可读面**。
 *
 * 数据来源：closureAuditRoute（同一份 registryClosure 扫描结果，服务端已去本地路径）。
 * 形状守卫在 features/closure/closureTypes 层（isClosureView）——本文件只渲染拿到数据的形态。
 * 纪律：用户面文本一律 t()；颜色走 token() 主题令牌；无绝对 http(s) URL；不持状态不发请求。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

export interface ClosureClusterView { cluster: string; unit: string; total: number; consumed: number; codeConsumed: number; unconsumed: number; }
export interface ClosureUnconsumedView { cluster: string; id: string; definedAt: string; evidenceKind: string; }
export interface ClosureGhostView { cluster: string; id: string; }

export interface ClosureView {
  generatedAt: string;
  totals: { registered: number; produced: number; consumed: number; codeConsumed: number; unconsumed: number; ghost: number };
  clusters: ClosureClusterView[];
  unconsumed: ClosureUnconsumedView[];
  ghost: ClosureGhostView[];
  notes: string[];
}

/** 形状守卫（防半截响应进渲染）：counts 三键 + clusters/unconsumed/ghost 数组齐备才采信。 */
export function isClosureView(v: unknown): v is ClosureView {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<ClosureView>;
  const tot = o.totals as Record<string, unknown> | undefined;
  if (!tot || typeof tot.registered !== 'number' || typeof tot.consumed !== 'number' || typeof tot.ghost !== 'number') return false;
  return Array.isArray(o.clusters) && Array.isArray(o.unconsumed) && Array.isArray(o.ghost);
}

const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;

/**
 * 族名走 locale（cluster id → 键）。**显式映射表而非拼接**——拼接键（t('closure.cluster.' + x)）
 * 既让静态提取器无法枚举（闭环体检自身的可观测性反而被自己的写法遮住），也会在 locale 里
 * 留下形如 `closure.cluster.` 的悬空引用；显式映射同 renderHitl 的 CHECK_LABEL_KEYS 先例。
 */
const CLUSTER_LABEL_KEYS: Record<string, string> = {
  tools: 'closure.cluster.tools',
  i18n: 'closure.cluster.i18n',
  routes: 'closure.cluster.routes',
};

/** 族名（未知族回落原 id——可见的漏翻，不是空白）。 */
function clusterLabel(cluster: string): string {
  const key = CLUSTER_LABEL_KEYS[cluster];
  return key !== undefined ? t(key) : cluster;
}

/** 未消费/幽灵两张表的单行（id + 定义锚点 + 证据类别）。 */
function row(cluster: string, id: string, detail: string, anchor: string, key: string): ReactElement {
  return createElement('div', { key, [anchor]: id, style: { ...ROW, color: token('anic-text') } },
    createElement('span', { style: { color: token('anic-warn-text'), fontWeight: 600 } }, clusterLabel(cluster)),
    createElement('span', { style: { minWidth: 260 } }, id),
    createElement('span', { style: { color: token('anic-text-faint') } }, detail),
  );
}

/** 渲染闭环体检分区（data=null → 上调用 sectionFailure 兜底，本函数只处理有数据形态）。 */
export function renderClosure(view: ClosureView | null): ReactElement | null {
  if (view === null) return null;
  const tot = view.totals;
  const summary = createElement('div', { 'data-anic-closure-summary': 'true', style: { ...ROW, padding: '6px 10px 2px', color: token('anic-text') } },
    createElement('strong', {}, t('closure.title')),
    createElement('span', { 'data-anic-closure-registered': String(tot.registered) }, t('closure.registered', { n: String(tot.registered) })),
    createElement('span', { 'data-anic-closure-consumed': String(tot.consumed) }, t('closure.consumed', { n: String(tot.consumed), code: String(tot.codeConsumed) })),
    createElement('span', { 'data-anic-closure-unconsumed': String(tot.unconsumed), style: { color: tot.unconsumed > 0 ? token('anic-warn-text') : token('anic-pass'), fontWeight: 600 } }, t('closure.unconsumed', { n: String(tot.unconsumed) })),
    createElement('span', { 'data-anic-closure-ghost': String(tot.ghost), style: { color: tot.ghost > 0 ? token('anic-fail') : token('anic-pass'), fontWeight: 600 } }, t('closure.ghost', { n: String(tot.ghost) })),
  );
  const tables = createElement('div', { 'data-anic-closure-tables': 'true', style: { padding: '0 0 6px' } },
    // 两张表：未消费（registered=true & consumed=false）/ 幽灵消费（consumed=true & registered=false）
    createElement('div', { style: { ...ROW, fontWeight: 600, color: token('anic-text-strong') } }, t('closure.tableUnconsumed', { n: String(view.unconsumed.length) })),
    ...(view.unconsumed.length === 0
      ? [createElement('div', { key: 'none', 'data-anic-closure-none': 'true', style: { ...ROW, color: token('anic-pass') } }, t('closure.noneUnconsumed'))]
      : view.unconsumed.slice(0, 24).map((u, i) => row(u.cluster, u.id, t('closure.evidenceOf', { kind: u.evidenceKind }) + ' · ' + u.definedAt, 'data-anic-unconsumed', String(i) + u.id))),
    createElement('div', { style: { ...ROW, marginTop: 4, fontWeight: 600, color: token('anic-text-strong') } }, t('closure.tableGhost', { n: String(view.ghost.length) })),
    ...(view.ghost.length === 0
      ? [createElement('div', { key: 'none', 'data-anic-closure-ghost-none': 'true', style: { ...ROW, color: token('anic-pass') } }, t('closure.noneGhost'))]
      : view.ghost.map((g, i) => row(g.cluster, g.id, t('closure.ghostHint'), 'data-anic-ghost', String(i) + g.id))),
  );
  const notes = createElement('div', { 'data-anic-closure-notes': 'true', style: { padding: '0 10px 6px', fontSize: 10, color: token('anic-text-faint') } },
    createElement('div', {}, t('closure.notesTitle')),
    ...view.notes.map((n, i) => createElement('div', { key: String(i) }, '· ' + n)),
    createElement('div', { style: { marginTop: 2 } }, t('closure.generatedAt', { generatedAt: view.generatedAt })),
  );
  return createElement('div', { 'data-anic-closure': 'section', style: { borderTop: '1px solid ' + token('anic-border') } }, summary, tables, notes);
}
