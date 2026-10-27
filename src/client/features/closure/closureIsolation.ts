/**
 * 闭环体检**跨项目隔离**客户端形状与渲染（cycle-82 可观测性收口）。
 *
 * ## 为什么这一行必须显眼（它是所有其他读数的前提）
 *
 * 面板上"未消费 86 条""缺 3 份交付清单"这类数字，全部建立在**读到的是本项目**这个
 * 前提上。一旦某条持久化路径越出 workspace（`..` 逃逸 / `process.cwd()` 兜底 /
 * 写死别的盘），上面的数字就在描述**别的项目**，再精确也毫无意义。
 *
 * 所以这里不是又一个计数行，而是**前提行**：绿 = 前提成立；红 = 请先修路径，
 * 别看下面的数字。违规分两类、**分开显示**：
 *   - `violations`：污染类（越界 / cwd 兜底 / 写死绝对路径）——真事故，要改代码；
 *   - `dangling`：死登记（登记表里有、源码里没有锚点）——登记表漂移，要改登记。
 * 混成一句"有 2 个问题"会让读者不知道先动哪只手。
 *
 * ## 集成与安全
 *
 * 纯函数、无 hooks、无请求；`ClosureView.isolation` 缺席（旧服务端）⇒ 不渲染。
 * 渲染里**不出现任何绝对路径**：服务端投影已去掉 workspace，客户端也不拼回去。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** 与服务端 isolationView 逐字段同构。 */
export interface IsolationItemView {
  id: string;
  relPath: string;
  inWorkspace: boolean;
  source: string;
  evidence: string;
}

export interface IsolationViolationView {
  kind: 'path-escape' | 'cwd-fallback' | 'absolute-literal';
  target: string;
  reason: string;
}

export interface IsolationView {
  ok: boolean;
  items: IsolationItemView[];
  violations: IsolationViolationView[];
  dangling: string[];
  scannedFiles: number;
}

/** 违规类别 → locale 键（显式映射；未知类别回落原值 = 可见的漏翻，不是空白）。 */
const KIND_KEYS: Record<IsolationViolationView['kind'], string> = {
  'path-escape': 'closure.isolation.kind.escape',
  'cwd-fallback': 'closure.isolation.kind.cwdFallback',
  'absolute-literal': 'closure.isolation.kind.absolute',
};

/** fail-closed 形状守卫（在场则严格；未知 kind 不判假 —— 新类别不该打瞎整个分区）。 */
export function isIsolationView(v: unknown): v is IsolationView {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') return false;
  if (typeof o.scannedFiles !== 'number' || !Number.isFinite(o.scannedFiles)) return false;
  if (!Array.isArray(o.items) || !o.items.every((x) => x !== null && typeof x === 'object'
    && typeof (x as IsolationItemView).id === 'string'
    && typeof (x as IsolationItemView).relPath === 'string'
    && typeof (x as IsolationItemView).inWorkspace === 'boolean')) return false;
  if (!Array.isArray(o.violations) || !o.violations.every((x) => x !== null && typeof x === 'object'
    && typeof (x as IsolationViolationView).kind === 'string'
    && typeof (x as IsolationViolationView).target === 'string')) return false;
  if (!Array.isArray(o.dangling) || !o.dangling.every((d) => typeof d === 'string')) return false;
  // 真值自洽：ok=true 却带违规 = 自相矛盾（面板会显示绿色同时列出红项）。
  if (o.ok === true && (o.violations as unknown[]).length > 0) return false;
  return true;
}

const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;

/** 违规明细行（前 3 条点名 + 余量如实上报）。 */
function violationRow(v: IsolationViolationView, i: number): ReactElement {
  const key = KIND_KEYS[v.kind];
  return createElement('div', {
    key: 'v' + String(i),
    'data-anic-isolation-violation': v.kind,
    'data-anic-isolation-target': v.target,
    style: { ...ROW, paddingLeft: 20, color: token('anic-fail'), fontSize: 10 },
  },
    createElement('span', { style: { fontWeight: 600 } }, key === undefined ? v.kind : t(key)),
    createElement('span', {}, v.target),
  );
}

/**
 * 渲染隔离分区（前提行 + 违规点名 + 死登记）。
 *
 * @param view 服务端 isolation 投影；`undefined` = 旧服务端 ⇒ null（不渲染）。
 */
export function renderClosureIsolation(view: IsolationView | undefined): ReactElement | null {
  if (view === undefined) return null;
  const shown = view.violations.slice(0, 3);
  const rest = view.violations.length - shown.length;
  return createElement('div', {
    'data-anic-closure-isolation': view.ok ? 'ok' : 'broken',
    'data-anic-isolation-items': String(view.items.length),
    'data-anic-isolation-violations': String(view.violations.length),
    'data-anic-isolation-dangling': String(view.dangling.length),
    style: { borderTop: '1px solid ' + token('anic-border'), paddingTop: 4 },
  },
    createElement('div', {
      style: { ...ROW, color: view.ok ? token('anic-pass') : token('anic-fail'), fontWeight: 600 },
    },
      createElement('span', {}, view.ok
        ? t('closure.isolation.ok', { n: String(view.items.length) })
        : t('closure.isolation.broken', {
          v: String(view.violations.length), d: String(view.dangling.length),
        })),
      createElement('span', { style: { fontWeight: 400, color: token('anic-text-faint') } },
        t('closure.isolation.scanned', { n: String(view.scannedFiles) })),
    ),
    // 污染类违规（真事故）：点名到 target（路径或源码位置），带类别。
    ...shown.map((v, i) => violationRow(v, i)),
    rest > 0
      ? createElement('div', { style: { ...ROW, paddingLeft: 20, color: token('anic-fail'), fontSize: 10 } },
          t('closure.isolation.moreViolations', { n: String(rest) }))
      : null,
    // 死登记（登记表漂移）：与污染分开一行，因为处置动作不同。
    view.dangling.length === 0
      ? null
      : createElement('div', {
          'data-anic-isolation-dangling-list': view.dangling.join(','),
          style: { ...ROW, color: token('anic-warn-text'), fontSize: 10 },
        }, t('closure.isolation.dangling', { list: view.dangling.slice(0, 3).join(' · ') })),
    createElement('div', { style: { ...ROW, color: token('anic-text-faint'), fontSize: 10 } },
      t('closure.isolation.hint')),
  );
}
