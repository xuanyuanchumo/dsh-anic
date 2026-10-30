/**
 * 路径表渲染（cycle-82 只读展示 + cycle-83 行内编辑）。
 *
 * ## 为什么路径表必须显示 exists / bytes / mtime
 *
 * 用户诉求是「路径支持可视化」——只印一串路径字符串，用户仍然不知道那条路径
 * **现在是否存在**、技能装在哪一份、dist 是哪次构建的。三个元数据各答一个问题：
 * exists = 有没有落盘；bytes = 是不是空壳；mtime = 是不是最新那次构建/安装。
 *
 * ## 事实值与词条分开渲染（不是塞进一个插值串）
 *
 * 大小/mtime/拒绝原因都是**机器事实**，不该被翻译层包成一句自然语言——
 * 一旦词条缺键（locale 尚未合并），插值就整体消失，用户看到空白，
 * 而"看不到事实"恰恰是这个面板最不该发生的事。所以这里拆成：
 * 词条负责**框架文字**，事实值各自是独立文本节点。
 *
 * ## 编辑入口只在 `entry.editable === true` 时出现（cycle-83）
 *
 * 「能不能改」由**服务端**判定（`PATH_DEFS.overridable` 是唯一白名单），
 * 客户端不自己判断——两份白名单迟早分家，用户就会看到一个点了没反应的按钮。
 * 老宿主不返回该字段 ⇒ 缺省不可编辑（fail-closed：不给入口，好过给假入口）。
 *
 * ## 内联编辑器是纯渲染 + 回调
 *
 * 渲染器不持有「正在编辑哪一行」的状态（那是面板状态）。调用方传入
 * `editingId` 与 `editValue`，渲染器只把它们变成元素树；输入变化、保存、取消
 * 都只是一个回调。草稿校验反馈（`editError`）同样由调用方算——服务端才是
 * 路径判据的唯一权威（客户端只显示它的裁决）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { cfgText, type ConfigPathJson, type PathOverridesJson } from './configTypes.ts';

export interface PathTableHandlers {
  /** 复制路径（调用方决定 clipboard 还是兜底展示）。 */
  onCopy: (path: string) => void;
  /** 进入编辑态（cycle-83）。缺省 = 该路径表不可编辑。 */
  onEditBegin?: (id: string) => void;
  /** 编辑中的输入变化。 */
  onEditChange?: (id: string, value: string) => void;
  /** 保存（提交给 paths 端点；`null` 语义 = 撤销覆盖回默认）。 */
  onEditSave?: (id: string) => void;
  /** 取消编辑（丢弃输入，不改磁盘）。 */
  onEditCancel?: (id: string) => void;
  /** 撤销该项的覆盖（回默认）——与「编辑成别的路径」是两件事。 */
  onEditReset?: (id: string) => void;
}

/** 路径表渲染输入（cycle-83：编辑态与覆盖视图）。 */
export interface PathTableInput {
  entries: ConfigPathJson[];
  warnings: string[];
  /** 覆盖表视图（缺省 = 老宿主 / 无覆盖）。 */
  overrides?: PathOverridesJson | null;
  /** 正在编辑的行 id（null = 没有在编辑）。 */
  editingId?: string | null;
  /** 该行的输入文本。 */
  editValue?: string;
  /** 该行的校验反馈（服务端裁决或本地形状提示；null = 无错误）。 */
  editError?: string | null;
  /** 该行请求进行中（保存按钮禁用）。 */
  editBusy?: boolean;
}

/** 字节数人性化（与 renderBudget 同款口径，但本面板只到 GB）。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v >= 10 || u === 0 ? String(Math.round(v)) : v.toFixed(1)} ${units[u] as string}`;
}

/** 小号文字按钮样式（路径行的复制/编辑/保存等一律用它，视觉一致）。 */
function btnStyle(color: string) {
  return {
    fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color,
  } as const;
}

/** 覆盖状态标记（默认 / 自定义；自定义是用户的意思，必须一眼看得出）。 */
function renderOverrideMark(entry: ConfigPathJson): ReactElement | null {
  if (entry.editable !== true) return null;
  const on = entry.overridden === true;
  return createElement(
    'span',
    {
      'data-anic-config-path-origin': entry.id,
      'data-anic-config-path-overridden': on ? 'true' : 'false',
      style: { fontSize: 9, color: on ? token('anic-warn-text') : token('anic-text-faint') },
    },
    on ? cfgText('pathOverridden') : cfgText('pathDefault'),
  );
}

/** 单行内联编辑器（输入 + 保存/取消/撤销覆盖 + 校验反馈）。 */
function renderEditor(entry: ConfigPathJson, input: PathTableInput, h: PathTableHandlers): ReactElement {
  const rel = input.overrides?.active[entry.id] ?? '';
  const value = input.editValue ?? rel;
  const busy = input.editBusy === true;
  const btn = (key: string, label: string, onClick: () => void, disabled?: boolean): ReactElement =>
    createElement('button', {
      key, type: 'button', 'data-anic-config-path-action': key, disabled: disabled === true,
      onClick: disabled === true ? undefined : onClick, style: btnStyle(token('anic-text-dim')),
    }, label);
  return createElement(
    'div',
    { 'data-anic-config-path-editor': entry.id, style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', width: '100%', padding: '2px 0' } },
    createElement('input', {
      type: 'text',
      'data-anic-config-path-input': entry.id,
      'aria-label': cfgText('pathEditing'),
      value,
      placeholder: cfgText('pathEditHint'),
      onChange: (e: { target?: { value?: string } }) => h.onEditChange?.(entry.id, e?.target?.value ?? ''),
      style: {
        flex: '1 1 200px', fontSize: 10, padding: '1px 5px',
        border: `1px solid ${token('anic-border')}`, borderRadius: 3,
        background: token('anic-surface'), color: token('anic-text'),
      },
    }),
    btn('save', cfgText('pathEditSave'), () => h.onEditSave?.(entry.id), busy),
    btn('cancel', cfgText('pathEditCancel'), () => h.onEditCancel?.(entry.id)),
    // 撤销覆盖只在「当前确有覆盖」时给——没有覆盖时它是个无意义按钮。
    entry.overridden === true ? btn('reset', cfgText('pathEditReset'), () => h.onEditReset?.(entry.id), busy) : null,
    // 校验反馈：显示服务端原文（不吞成"非法"——用户要知道为什么）。
    input.editError !== null && input.editError !== undefined
      ? createElement('span', { 'data-anic-config-path-error': entry.id, style: { fontSize: 10, color: token('anic-bad-text'), width: '100%' } }, input.editError)
      : null,
  );
}

/** 单行路径（不存在时路径串仍显示——"该在哪但不在"本身就是信息）。 */
function renderRow(entry: ConfigPathJson, input: PathTableInput, h: PathTableHandlers): ReactElement {
  if (input.editingId === entry.id) {
    return createElement('div', { 'data-anic-config-path-row': entry.id, style: { padding: '2px 0' } }, renderEditor(entry, input, h));
  }
  const shown = entry.path ?? cfgText('pathUnresolved');
  // 事实串：大小 + mtime 各自独立（不依赖词条是否已合并）。
  const facts = entry.isDir
    ? [cfgText('pathDir'), entry.mtime ?? '-']
    : [humanBytes(entry.bytes), entry.mtime ?? '-'];
  return createElement(
    'div',
    {
      'data-anic-config-path-row': entry.id,
      'data-anic-config-path-exists': entry.exists ? 'true' : 'false',
      style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0', flexWrap: 'wrap' },
    },
    createElement('span', { style: { flex: '0 0 120px', fontSize: 11, color: token('anic-text') } }, t(entry.labelKey)),
    createElement(
      'code',
      {
        'data-anic-config-path-value': entry.id,
        title: entry.source,
        style: { flex: '1 1 220px', fontSize: 10, color: entry.exists ? token('anic-text-dim') : token('anic-text-faint'), wordBreak: 'break-all' },
      },
      shown,
    ),
    createElement(
      'span',
      {
        'data-anic-config-path-meta': entry.id,
        style: { fontSize: 10, color: token('anic-text-faint'), fontVariantNumeric: 'tabular-nums' },
      },
      ...(entry.exists
        ? [facts[0] as string, ' · ', facts[1] as string]
        : [cfgText('pathMissing')]),
    ),
    renderOverrideMark(entry),
    entry.exists && entry.path !== null
      ? createElement('button', {
          type: 'button',
          'data-anic-config-copy': entry.id,
          'aria-label': cfgText('pathCopyLabel', { label: t(entry.labelKey) }),
          onClick: () => h.onCopy(entry.path as string),
          style: btnStyle(token('anic-text-dim')),
        }, cfgText('pathCopy'))
      : null,
    entry.editable === true && h.onEditBegin !== undefined
      ? createElement('button', {
          type: 'button',
          'data-anic-config-edit': entry.id,
          'aria-label': cfgText('pathEditing'),
          onClick: () => h.onEditBegin?.(entry.id),
          style: btnStyle(token('anic-text-dim')),
        }, cfgText('pathEdit'))
      // 不可编辑项给一行**说明**而不是空着：用户看到"这条为什么没有编辑按钮"，
      // 才不会以为界面坏了（静默缺失与"不支持"在观感上是同一件事）。
      : entry.editable === false && entry.overridden === true
        ? createElement('span', { 'data-anic-config-not-editable': entry.id, style: { fontSize: 9, color: token('anic-text-faint') } },
            cfgText('pathNotEditable'))
        : null,
  );
}

/**
 * 路径表（含自定义路径校验结果的回显 + 覆盖表状态）。
 *
 * `probe` 是 GET 带 ?probePath= 时的服务端裁决——被拒时**必须显示原因**，
 * 否则用户只看到"输入了路径但什么都没发生"。原因作为独立文本节点，不靠插值。
 *
 * 覆盖表整份被忽略时（`overrides.ignored`）必须显著提示：那是 fail-closed
 * 生效的信号，用户需要知道「你现在看到的都是默认路径，你的覆盖没被采纳」。
 */
export function renderConfigPaths(
  paths: PathTableInput,
  probe: { ok: boolean; entry?: ConfigPathJson; reason?: string; code?: string } | null | undefined,
  handlers: PathTableHandlers,
): ReactElement | null {
  if (paths.entries.length === 0) return null;
  const rejected = probe !== null && probe !== undefined && !probe.ok;
  const ov = paths.overrides ?? null;
  const active = ov === null ? 0 : Object.keys(ov.active).length;
  return createElement(
    'div',
    { 'data-anic-config-paths': 'true', style: { padding: '4px 10px 6px' } },
    createElement('div', { style: { fontSize: 11, fontWeight: 600, color: token('anic-text-strong'), margin: '6px 0 2px' } }, cfgText('pathTitle')),
    ov === null || ov.editableIds.length === 0
      ? null
      : createElement('div', { 'data-anic-config-overrides-count': String(active), style: { fontSize: 10, color: active > 0 ? token('anic-warn-text') : token('anic-text-faint') } },
          active > 0 ? [cfgText('pathOverridesActive'), ' ', String(active)] : [cfgText('pathOverridesNone')]),
    ...paths.entries.map((e) => renderRow(e, paths, handlers)),
    // 整份忽略：fail-closed 的事实，必须显著（红字 + 原因）。
    ov !== null && ov.ignored
      ? createElement('div', { 'data-anic-config-overrides-ignored': 'true', style: { fontSize: 10, color: token('anic-bad-text'), marginTop: 4 } },
          cfgText('pathOverridesIgnored'), ' ', ov.warnings.join(' · '))
      : null,
    rejected
      ? createElement('div', { 'data-anic-config-probe': 'rejected', 'data-anic-config-probe-code': probe?.code ?? '', style: { fontSize: 10, color: token('anic-bad-text'), marginTop: 4 } },
          cfgText('pathProbeRejected'), ' ', probe?.reason ?? '', ' ', probe?.code ?? '')
      : null,
    probe && probe.ok && probe.entry
      ? createElement('div', { 'data-anic-config-probe': 'accepted', style: { fontSize: 10, color: token('anic-ok-text'), marginTop: 4 } },
          cfgText('pathProbeAccepted'), ' ', probe.entry.path ?? '')
      : null,
    paths.warnings.length > 0
      ? createElement('div', { 'data-anic-config-path-warnings': 'true', style: { fontSize: 10, color: token('anic-warn-text'), marginTop: 4 } },
          paths.warnings.join(' · '))
      : null,
  );
}
