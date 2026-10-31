/**
 * 自举分区的**事实基线渲染部件**（cycle-95 · 从 renderBootstrap.ts 拆出，守 T3 ≤250 行）。
 *
 * ## 拆出的理由（不只是行数）
 *
 * `renderBootstrap.ts` 在 cycle-95 加入「事实摘要 + 活跃/归档分列」两行后越过了 250 行
 * 硬限。但拆分的界线本来就该是**职责**：本文件负责「把一份事实基线读成人能核对的
 * 数字」，而 renderBootstrap 负责「把状态/陈旧/历史/根因四段装配成一个分区」。
 * 事实基线的每行都有独立语义与独立锚点，它可以被单独契约测试（本仓既有惯例：
 * closurePanelParts.ts 同款拆分）。
 *
 * ## 为什么事实行用「三元组行」而不是表格
 *
 * 表格在 320px 宽的面板里会把 sha 折成两行且列错位（`table-layout` 默认 auto）。
 * 每项一行「标签 · 值 · 补充」在窄屏天然折行，且每行都有 `data-anic-bootstrap-fact`
 * 锚点——契约测试可以逐项断言，不必解析整块文本。
 *
 * ## 缺字段的呈现纪律
 *
 * 值缺失一律显示 `—` 或「未取得」，**不隐藏、不猜默认值**：「没采到」本身就是信息。
 * 一个好看的默认值会让面板显示的读数与项目真相脱钩，而这正是本域要修的缺陷形态。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { BootstrapJson } from './bootstrapTypes.ts';

/** 窄屏可读的行式布局（每项一行；标签定宽，值可折行）。 */
export const ROW = { display: 'flex', flexWrap: 'wrap' as const, gap: '0 8px', alignItems: 'baseline', fontSize: 11, margin: '1px 0' } as const;
export const LABEL = { color: token('anic-text-faint'), minWidth: 62 } as const;
const VALUE = { color: token('anic-text'), wordBreak: 'break-all' as const } as const;
const H = { fontSize: 11, fontWeight: 600, color: token('anic-text'), margin: '4px 0 2px' } as const;

/** ISO → `MM-DD HH:mm`（跨年场景不缩写年份；非法串原样返回）。 */
export function shortAt(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso === '') return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m === null ? iso : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 短哈希（7–9 位足够人工核对；完整值在 title 里，悬停可见）。 */
export function shortSha(sha: string | null | undefined): string {
  if (typeof sha !== 'string' || sha === '') return '—';
  return sha.length > 9 ? sha.slice(0, 9) : sha;
}

/** 一条事实行（`data-anic-bootstrap-fact` 锚点 + 可选 title 全文）。 */
export function factRow(key: string, label: string, value: string, title?: string): ReactElement {
  return createElement(
    'div',
    { key, 'data-anic-bootstrap-fact': key, style: ROW },
    createElement('span', { style: LABEL }, label),
    createElement('span', { style: VALUE, ...(title !== undefined ? { title } : {}) }, value),
  );
}

/**
 * 当前事实摘要的 8 位读数（cycle-95）——回答"这条结论基于哪份事实"。
 *
 * 为什么只显示 8 位而不是 16 位全文：面板宽度常被压到 320px，16 位会被折成两行
 * 且与相邻读数错位；8 位足够人工核对"同一份/换了一份"，完整值放 `title` 悬停可见
 * （`data-anic-bootstrap-digest` 锚点让契约测试能逐位断言）。
 *
 * 为什么缺摘要时显示「未取得」而不是 `—` 或留白：`—` 与"摘要真的是空"无法区分，
 * 留白更会被读成"面板没渲染这一项"。摘要缺失只有两种成因（旧宿主没有该字段 /
 * 从未采集过），两者都该被读成**未取得**——这正是"字段缺失如实显示"的落地形态。
 *
 * 文本一律复用既有词条（`live.notFetched` / `org.reloadRevision`）：本工作流的写域
 * **不含** `locale/*.json`，新词条必须由词表拥有者接线，否则就是"加键不接线"的死键
 * （零死键棘轮会红）。`org.reloadRevision`（"revision {rev}"）语义正是事实基线的
 * 版本标识，跨域复用比自造新前缀更安全。
 */
export function digestChip(v: BootstrapJson, key: string): ReactElement {
  const d = typeof v.factsDigest === 'string' && v.factsDigest !== '' ? v.factsDigest : null;
  const short = d === null ? null : d.slice(0, 8);
  return createElement(
    'span',
    {
      key,
      'data-anic-bootstrap-digest': short ?? 'absent',
      ...(d === null ? {} : { title: d }),
      style: { fontSize: 10, color: token('anic-text-faint') },
    },
    short === null ? t('live.notFetched') : t('org.reloadRevision', { revision: short }),
  );
}

/**
 * 事实基线网格：缺字段显示 `—`（不隐藏——「没采到」本身就是信息）。
 *
 * 分列口径优先走宿主的 `activeVsArchived`（唯一口径，且带 `evaluationInput`）；
 * 缺该字段的**旧宿主**回落到 `facts` 的两个计数——降级也要分列，绝不把
 * 活跃与归档合成一个数（一个数会把 89 轮历史读成 89 份活性产物）。
 */
export function renderFacts(v: BootstrapJson): ReactElement {
  const facts = v.facts ?? {};
  const evalReport = facts.evalReport ?? null;
  const evalText = evalReport === null
    ? '—'
    : `${evalReport.path ?? '?'} · ${shortSha(evalReport.sha256)}`;
  const split = v.activeVsArchived ?? null;
  const cyclesText = split === null
    ? `${facts.activeCycles === undefined ? '—' : String(facts.activeCycles)} ${t('bootstrap.activeUnit')} / `
      + `${facts.archivedCycles === undefined ? '—' : String(facts.archivedCycles)} ${t('bootstrap.archivedUnit')}`
    : `${String(split.active?.length ?? 0)} ${t('bootstrap.activeUnit')} / `
      + `${String(split.archived ?? 0)} ${t('bootstrap.archivedUnit')}`;
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
    // 活跃/归档**分列**是「归档只当历史」的呈现面（见函数头注）。
    factRow('cycles', t('bootstrap.factCycles'), cyclesText),
    factRow('skill', t('bootstrap.factSkill'), facts.skillVersion ?? '—'),
    // 摘要单独成行而不是塞进 cycles：它回答的是另一个问题（"结论基于哪份事实"），
    // 混进计数行会让「产物数量」与「事实指纹」读起来像同一件事。
    createElement(
      'div',
      { 'data-anic-bootstrap-fact': 'digest', style: ROW },
      createElement('span', { style: LABEL }, t('bootstrap.factsTitle')),
      digestChip(v, 'digest-value'),
    ),
  );
}
