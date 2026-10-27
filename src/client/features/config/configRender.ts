/**
 * 配置与路径编辑分区（cycle-82）—— 组装层：表单 + 动作栏 + 结果反馈 + 路径表。
 *
 * ## 纯渲染 + 回调（与 prefsDrawer / renderBudget 同款）
 *
 * 不引 hooks、不用 useMemo：offline-smoke 的 stub React 只提供极少 hooks，
 * 面板里任何 `useXxx` 都会让 smoke 的函数组件展开直接 TypeError。
 * 数据腿（GET 拉取、POST 提交、刷新）由 Lead 在面板装配层统一接，
 * 本模块只把「现在有什么事实 + 用户点了什么」变成元素树。
 *
 * ## 为什么不在这里做本地状态
 *
 * 草稿（drafts）由调用方持有：用户改了一半刷新页面/切分区时，草稿的存活策略
 * 属于面板状态机（panelState），不属于一个纯渲染器。这里只**读**草稿算脏标记。
 *
 * ## 反馈纪律（诚实优先）
 *
 * - 没保存过 → 不显示「已保存」；
 * - 预览/保存被拒 → 显示 error 原文（不吞成一句"失败"）；
 * - 回读断言失败并已回滚 → 这话必须说出来（"写了但没生效"是最危险的状态）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { cfgText, type ConfigJson, type ConfigWriteJson } from './configTypes.ts';
import { draftsToPatch, dirtyFieldIds, renderConfigForm, type ConfigFormHandlers } from './configForm.ts';
import { renderConfigPaths, type PathTableHandlers } from './configPaths.ts';

export interface ConfigEditorInput {
  /** GET 事实（null = 尚未拉取，整区不渲染——不伪造空态）。 */
  config: ConfigJson | null;
  /** 当前草稿（id → 文本/布尔）；无草稿 = 未修改。 */
  drafts: Record<string, string | boolean>;
  /** 最近一次预览或保存的结果。 */
  writeResult?: ConfigWriteJson | null;
  /** 请求进行中（按钮禁用，防重复提交同一份 patch）。 */
  busy?: boolean;
  /** 保存成功时的 ISO 时间戳（没有 = 本次会话没保存过）。 */
  savedAt?: string | null;
  /** 错误条（拉取失败等；与 writeResult.error 分开展示，来源不同）。 */
  error?: string | null;
}

export interface ConfigEditorHandlers extends ConfigFormHandlers, PathTableHandlers {
  /** 预览差异（dryRun）。 */
  onPreview: () => void;
  /** 保存（真写）。 */
  onSave: () => void;
  /** 丢弃全部草稿。 */
  onDiscard: () => void;
}

const BAR_STYLE = { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px 2px', flexWrap: 'wrap' } as const;

function button(key: string, label: string, onClick: () => void, opts: { disabled?: boolean; accent?: boolean }): ReactElement {
  return createElement(
    'button',
    {
      key,
      type: 'button',
      'data-anic-config-action': key,
      disabled: opts.disabled === true,
      onClick,
      style: {
        fontSize: 11, padding: '2px 10px', cursor: opts.disabled === true ? 'default' : 'pointer',
        border: `1px solid ${token('anic-border')}`, borderRadius: 4,
        background: opts.accent === true ? token('anic-surface-active') : token('anic-surface'),
        color: token('anic-text'),
      },
    },
    label,
  );
}

/** 写入结果反馈（dryRun → diff 行；真写 → applied/回滚原因）。 */
function renderWriteResult(result: ConfigWriteJson): ReactElement {
  const lines = result.diff ?? [];
  const tone = result.ok ? token('anic-ok-text') : token('anic-bad-text');
  return createElement(
    'div',
    { 'data-anic-config-result': result.ok ? 'ok' : 'fail', 'data-anic-config-dryrun': result.dryRun ? 'true' : 'false', style: { padding: '2px 10px 4px', fontSize: 11 } },
    // 摘要行：词条负责框架文字，**变更数与 error 原文各自独立成节点**——
    // 词条未合并（locale 尚未接线）时插值整体消失，而"改了几个字段""为什么失败"
    // 是机器事实，不能跟着翻译层一起消失（这是本面板最不该沉默的两件事）。
    createElement('div', { style: { color: tone } },
      result.dryRun
        ? [cfgText('previewSummary'), ' ', String(result.changedFields.length)]
        : result.ok
          ? [cfgText('saveSummary'), ' ', String(result.changedFields.length)]
          : [cfgText('saveFailed'), ' ', result.error]),
    result.ok && !result.dryRun && result.backupPath !== null && result.backupPath !== undefined
      ? createElement('div', { 'data-anic-config-backup': 'true', style: { fontSize: 10, color: token('anic-text-faint') } },
          cfgText('backupAt'), ' ', result.backupPath)
      : null,
    lines.length > 0
      ? createElement(
          'pre',
          { 'data-anic-config-diff': 'true', style: { fontSize: 10, margin: '2px 0 0', maxHeight: 160, overflow: 'auto', color: token('anic-text-dim') } },
          // 统一 diff 形态：标记直接贴行首（`+`/`-` + 原始行），行的缩进原样保留——
          // 缩进是 YAML 的语义，diff 里丢掉就看不出"改的是哪一层"。
          lines.map((d) => `${d.kind === 'add' ? '+' : '-'}${d.text}`).join('\n'),
        )
      : null,
    result.warnings.length > 0
      ? createElement('div', { 'data-anic-config-warnings': 'true', style: { fontSize: 10, color: token('anic-warn-text') } }, result.warnings.join(' · '))
      : null,
  );
}

/**
 * 组装配置编辑分区。
 *
 * panelId 由面板实例生成（同 prefsDrawer 的 B5.1 教训：多实例同 id 会让
 * aria-controls 静默错位）；这里把它挂成容器 id 与 aria 关联的锚。
 */
export function renderConfigEditor(input: ConfigEditorInput, handlers: ConfigEditorHandlers, panelId: string): ReactElement | null {
  const cfg = input.config;
  if (cfg === null) return null;

  const formInput = { schema: cfg.schema, values: cfg.values, drafts: input.drafts };
  const dirty = dirtyFieldIds(formInput);
  const patch = draftsToPatch(formInput);
  const result = input.writeResult ?? null;
  const busy = input.busy === true;

  return createElement(
    'div',
    {
      'data-anic-config': 'editor',
      id: panelId,
      // role=region 而非 dialog：它不遮挡主体、不做焦点陷阱（与 ⚙ 抽屉同一裁决）。
      role: 'region',
      'aria-label': cfgText('ariaLabel'),
      style: { borderTop: `1px solid ${token('anic-border')}`, background: token('anic-surface'), paddingBottom: 4 },
    },
    createElement('div', { style: BAR_STYLE },
      createElement('strong', { style: { fontSize: 12, color: token('anic-text-strong') } }, cfgText('title')),
      createElement('span', { 'data-anic-config-dirty-count': String(dirty.length), style: { fontSize: 10, color: dirty.length > 0 ? token('anic-warn-text') : token('anic-text-faint') } },
        cfgText('dirtyCount', { count: String(dirty.length) })),
      createElement('span', { style: { flex: 1 } }),
      button('discard', cfgText('discard'), handlers.onDiscard, { disabled: busy || dirty.length === 0 }),
      button('preview', cfgText('preview'), handlers.onPreview, { disabled: busy || dirty.length === 0 }),
      button('save', busy ? cfgText('saving') : cfgText('save'), handlers.onSave, { disabled: busy || dirty.length === 0, accent: true }),
    ),
    input.error !== null && input.error !== undefined
      ? createElement('div', { 'data-anic-config-error': 'true', style: { padding: '2px 10px', fontSize: 11, color: token('anic-bad-text') } }, input.error)
      : null,
    input.savedAt !== null && input.savedAt !== undefined
      ? createElement('div', { 'data-anic-config-saved': 'true', style: { padding: '2px 10px', fontSize: 10, color: token('anic-ok-text') } }, cfgText('savedAt', { at: input.savedAt }))
      : null,
    result !== null ? renderWriteResult(result) : null,
    createElement('div', { 'data-anic-config-body': 'true', style: { padding: '0 10px' } },
      renderConfigForm(formInput, handlers)),
    renderConfigPaths(cfg.paths, cfg.probe ?? null, handlers),
    createElement('div', { style: { padding: '4px 10px 0', fontSize: 10, color: token('anic-text-faint') } }, cfgText('hint')),
    createElement('span', { 'data-anic-config-patch-size': String(Object.keys(patch).length), style: { display: 'none' } }, ''),
  );
}
