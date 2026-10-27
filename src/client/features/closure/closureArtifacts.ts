/**
 * 闭环体检**第五族（.cycles 文档生命周期）客户端形状与渲染**
 * （cycle-82 可观测性收口）。
 *
 * ## 为什么这一族必须落在客户端
 *
 * 前四族的缺口是"某段代码没人读"，读者看一张清单就能行动。文档生命周期的缺口
 * 形态不同：它是**逐循环 × 逐模板的格子**。79 个循环 × 11 个模板 = 869 格，
 * 一句"产物不全"没有信息量 —— 用户要能自己看到"cycle-80 缺非功能验证报告"
 * 这类**可点名**的事实。所以这里给的是矩阵与点名清单，不是一个汇总数。
 *
 * ## 三种作用域必须分开呈现（不是设计洁癖，是防误读）
 *
 *   - `cycle`：每个循环都应有 ⇒ 渲染成矩阵，缺失点名到 `cycle-N/文件`；
 *   - `project`：项目级单份（intent/spec/plan/REVIEW/PR 模板）⇒ 只报存在与否；
 *   - `ondemand`：事故/复盘，零发生是**健康的** ⇒ 报累计次数，绝不进缺失清单。
 * 把三者混成"15 个模板，缺 3 个"会让读者去补一份本来就不该存在的 incident。
 *
 * ## 集成与安全
 *
 * 纯函数（`createElement`，不引 hooks、不发请求）；文本经 `t()`；颜色走 token()；
 * 从 `ClosureView.artifacts` 读（**缺席 = 旧服务端 ⇒ 不渲染该分区，不是失败**）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** 与服务端 artifactsView 逐字段同构（客户端只读渲染，不做判据重算）。 */
export interface ArtifactsItemView {
  id: string;
  label: string;
  gate: string;
  scope: 'cycle' | 'project' | 'ondemand';
  registered: boolean;
  consumed: boolean;
  coverage: number | null;
  occurrences: number | null;
  projectPresent: boolean | null;
  /** 逐循环存在位（`cycle-81:1` / `cycle-80:0`）。 */
  matrix: string[];
  missing: string[];
}

export interface ArtifactsView {
  cyclesScanned: string[];
  totals: { templates: number; registered: number; consumed: number; missing: number; uncovered: number };
  items: ArtifactsItemView[];
}

/** fail-closed 形状守卫（与服务端同构；未知多余字段放行 = 向前兼容）。 */
export function isArtifactsView(v: unknown): v is ArtifactsView {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.cyclesScanned) || !o.cyclesScanned.every((x) => typeof x === 'string')) return false;
  const tot = o.totals;
  if (tot === null || typeof tot !== 'object') return false;
  for (const k of ['templates', 'registered', 'consumed', 'missing', 'uncovered']) {
    const n = (tot as Record<string, unknown>)[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
  }
  if (!Array.isArray(o.items)) return false;
  for (const it of o.items) {
    if (it === null || typeof it !== 'object') return false;
    const i = it as Record<string, unknown>;
    if (typeof i.id !== 'string' || typeof i.label !== 'string' || typeof i.gate !== 'string') return false;
    if (i.scope !== 'cycle' && i.scope !== 'project' && i.scope !== 'ondemand') return false;
    if (typeof i.registered !== 'boolean' || typeof i.consumed !== 'boolean') return false;
    if (!Array.isArray(i.matrix) || !i.matrix.every((m) => typeof m === 'string')) return false;
    if (!Array.isArray(i.missing) || !i.missing.every((m) => typeof m === 'string')) return false;
  }
  // 真值自洽：registered/consumed 计数必须由明细推出（自报数字要有比对面）。
  const reg = o.items.filter((x) => (x as ArtifactsItemView).registered).length;
  if (reg !== (tot as ArtifactsView['totals']).registered) return false;
  const con = o.items.filter((x) => (x as ArtifactsItemView).consumed).length;
  return con === (tot as ArtifactsView['totals']).consumed;
}

const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;

/** 作用域标签键（显式映射，不拼接 —— 拼键会让静态提取器无法枚举）。 */
const SCOPE_KEYS: Record<ArtifactsItemView['scope'], string> = {
  cycle: 'closure.artifacts.scopeCycle',
  project: 'closure.artifacts.scopeProject',
  ondemand: 'closure.artifacts.scopeOnDemand',
};

/** 作用域配色（语义令牌：cycle 有覆盖率才有意义，ondemand 不判红）。 */
function scopeColor(scope: ArtifactsItemView['scope'], ok: boolean): string {
  if (!ok) return token('anic-fail');
  return scope === 'ondemand' ? token('anic-text-faint') : token('anic-pass');
}

/**
 * 一格：`cycle-81:1` → 一个带 aria-label 的方块。
 *
 * 为什么用方块而不是表格：24 列 × 11 行的表格在面板宽度下会换行错位，
 * 而方块矩阵在任何宽度下都保持"一行一个模板"的语义。`title` 给出可读全名
 * （矩阵编码对屏幕阅读器不友好，必须补一维文本）。
 */
function cell(entry: string, key: string): ReactElement {
  const [cycle, bit] = entry.split(':');
  const on = bit === '1';
  return createElement('span', {
    key,
    'data-anic-artifact-cell': entry,
    'data-anic-artifact-on': on ? 'true' : 'false',
    title: (cycle ?? '') + (on ? ' ✓' : ' ✗'),
    'aria-label': (cycle ?? '') + (on ? ' present' : ' missing'),
    style: {
      display: 'inline-block', width: 9, height: 9, borderRadius: 2,
      background: on ? token('anic-pass') : token('anic-fail'),
      opacity: on ? 1 : 0.85,
    },
  });
}

/** 一个模板一行：标签 / 门禁归属 / 作用域 / 覆盖率或次数 / 矩阵 / 点名。 */
function row(it: ArtifactsItemView, idx: number): ReactElement {
  const ok = it.registered && it.consumed;
  const missingShown = it.missing.slice(0, 4);
  return createElement('div', {
    key: it.id,
    'data-anic-artifact': it.id,
    'data-anic-artifact-scope': it.scope,
    'data-anic-artifact-missing': String(it.missing.length),
    style: { ...ROW, color: token('anic-text') },
  },
    createElement('span', {
      'data-anic-artifact-registered': it.registered ? 'true' : 'false',
      'data-anic-artifact-consumed': it.consumed ? 'true' : 'false',
      style: { color: scopeColor(it.scope, ok), fontWeight: 600 },
    }, (it.registered ? '● ' : '○ ') + it.label),
    createElement('span', { 'data-anic-artifact-gate': it.gate, style: { color: token('anic-text-faint') } }, it.gate),
    createElement('span', { 'data-anic-artifact-scope-label': SCOPE_KEYS[it.scope], style: { color: token('anic-text-dim') } }, t(SCOPE_KEYS[it.scope])),
    // 读数：cycle 级报覆盖率、project 级报有无、ondemand 报次数（三者语义不同，绝不并成一句）。
    it.scope === 'cycle'
      ? createElement('span', { 'data-anic-artifact-coverage': String(it.coverage ?? 0) },
          t('closure.artifacts.coverage', { pct: String(Math.round((it.coverage ?? 0) * 100)) }))
      : it.scope === 'project'
        ? createElement('span', { 'data-anic-artifact-present': it.projectPresent ? 'true' : 'false' },
            it.projectPresent ? t('closure.artifacts.present') : t('closure.artifacts.absent'))
        : createElement('span', { 'data-anic-artifact-occurrences': String(it.occurrences ?? 0) },
            t('closure.artifacts.occurrences', { n: String(it.occurrences ?? 0) })),
    // 矩阵（仅 cycle 级；越靠右越新 —— 与服务端 slice(-N) 顺序一致）。
    it.matrix.length === 0 ? null : createElement('span', {
      'data-anic-artifact-matrix': it.id,
      style: { display: 'inline-flex', gap: 1 },
    }, ...it.matrix.map((e, i) => cell(e, it.id + ':' + String(i)))),
    // 缺失点名（可当待办用）。超出 4 条时如实说"还有 N 条"，不静默截断。
    it.missing.length === 0 ? null : createElement('span', {
      'data-anic-artifact-missing-list': it.id,
      style: { color: token('anic-warn-text'), fontSize: 10 },
    }, '· ' + missingShown.join(' · ')
      + (it.missing.length > missingShown.length
        ? ' ' + t('closure.artifacts.moreMissing', { n: String(it.missing.length - missingShown.length) })
        : '')),
  );
}

/**
 * 渲染第五族分区。
 *
 * @param view 服务端 artifacts 投影；`undefined` = 旧服务端 ⇒ 返回 null（不渲染，
 *   不是失败）：加字段不该让旧宿主上出现一条假红分区。
 */
export function renderClosureArtifacts(view: ArtifactsView | undefined): ReactElement | null {
  if (view === undefined) return null;
  const tot = view.totals;
  return createElement('div', {
    'data-anic-closure-artifacts': 'section',
    'data-anic-artifacts-templates': String(tot.templates),
    'data-anic-artifacts-missing': String(tot.missing),
    style: { borderTop: '1px solid ' + token('anic-border'), paddingTop: 4 },
  },
    createElement('div', { style: { ...ROW, fontWeight: 600, color: token('anic-text-strong') } },
      createElement('span', {}, t('closure.artifacts.title', {
        reg: String(tot.registered), total: String(tot.templates), cons: String(tot.consumed),
      })),
      createElement('span', {
        'data-anic-artifacts-window': String(view.cyclesScanned.length),
        style: { color: token('anic-text-faint'), fontWeight: 400 },
      }, t('closure.artifacts.window', { n: String(view.cyclesScanned.length) })),
      tot.missing > 0
        ? createElement('span', { style: { color: token('anic-warn-text') } }, t('closure.artifacts.missingTotal', { n: String(tot.missing) }))
        : createElement('span', { style: { color: token('anic-pass') } }, t('closure.artifacts.noneMissing')),
    ),
    ...view.items.map((it, i) => row(it, i)),
    createElement('div', { style: { ...ROW, color: token('anic-text-faint'), fontSize: 10 } },
      t('closure.artifacts.hint')),
  );
}
