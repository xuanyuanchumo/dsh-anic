/**
 * 冲突条与备份下拉的**纯渲染**（cycle-83：从 configRender.ts 拆出，T3 ≤250 行）。
 *
 * ## 为什么这两块单独成文件
 *
 * configRender.ts 是组装层（表单 + 动作栏 + 结果）。冲突条与备份下拉是**两条独立
 * 的信息带**：冲突条说的是「你的基线过期了」，备份带说的是「你可以退回过去」。
 * 它们与表单不同源（一个读草稿三值，一个读备份清单），塞进组装层会让那个文件
 * 同时承载三种数据形状。拆开后的边界是「两条带各自一块」。
 *
 * ## 冲突条为什么不是阻断式弹窗（Lead 裁决）
 *
 * 冲突的含义是「磁盘已经变了，你的基线过期」——而**不是**「你不能保存」。
 * 用户永远可以保留自己的值（那是他的输入），但他必须知道磁盘变了。
 * 所以形态是**常驻条**：一句事实 + 两个动作（采用磁盘 / 保留我的），
 * 不遮挡表单、不抢焦点、不弹窗。弹窗会把「知道」变成「被打断」。
 *
 * ## 备份下拉为什么必须带 diff 摘要
 *
 * 只列文件名等于让用户自己 diff 三份文件。摘要给的是**字段级**（`changedFields`），
 * 因为用户能理解的单位是「L4 会变成 L3」，不是「第 17 行不同」。
 * 恢复按钮按**备份名**回传（服务端只接受清单内的名字，不接受路径）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { cfgText, type BackupViewJson } from './configTypes.ts';
import type { FieldConflict } from './configConflict.ts';

/**
 * 冲突条回调。
 *
 * 三个都**可选**：数据腿由 Lead 在装配层接（本任务禁止改 panelState/panelActions）。
 * 回调缺省时按钮不渲染——不给"点了没反应"的按钮，与路径编辑入口同款纪律。
 */
export interface ConflictBarHandlers {
  /** 采用磁盘值（把草稿改成新事实）。 */
  onAdoptServer?: (fieldId: string) => void;
  /** 保留我的：只 acknowledge，不改草稿（用户自己的值继续留着）。 */
  onKeepMine?: (fieldId: string) => void;
  /** 关闭整条（全部 acknowledge；之后同签名冲突不再提示）。 */
  onDismiss?: () => void;
}

/**
 * 冲突条。
 *
 * 每条显示三值：草稿、磁盘、原基线。为什么原基线也要显示——
 * 「你改成 B，磁盘已是 C」在用户看来可能像「C 才是原本的值」；
 * 把基线 A 一并显示出来，用户才看清这是**两个人都改过**的局面。
 */
export function renderConflictBar(
  conflicts: readonly FieldConflict[],
  h: ConflictBarHandlers,
): ReactElement | null {
  if (conflicts.length === 0) return null;
  const row = (c: FieldConflict): ReactElement =>
    createElement(
      'div',
      {
        key: c.fieldId,
        'data-anic-config-conflict': c.fieldId,
        style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', padding: '1px 0' },
      },
      createElement('span', { style: { fontSize: 11, color: token('anic-warn-text') } },
        cfgText('conflictLine', { field: t(c.labelKey), draft: c.draft, server: c.server })),
      // 原基线是独立事实节点（插值缺键时不会跟着消失）。
      createElement('span', { 'data-anic-config-conflict-origin': c.fieldId, style: { fontSize: 10, color: token('anic-text-faint') } },
        cfgText('conflictOriginal'), ' ', c.original),
      h.onAdoptServer === undefined ? null : createElement('button', {
        type: 'button', 'data-anic-config-conflict-adopt': c.fieldId,
        onClick: () => h.onAdoptServer?.(c.fieldId),
        style: { fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color: token('anic-ok-text') },
      }, cfgText('conflictAdopt')),
      h.onKeepMine === undefined ? null : createElement('button', {
        type: 'button', 'data-anic-config-conflict-keep': c.fieldId,
        onClick: () => h.onKeepMine?.(c.fieldId),
        style: { fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color: token('anic-text-dim') },
      }, cfgText('conflictKeep')),
    );
  return createElement(
    'div',
    {
      'data-anic-config-conflicts': String(conflicts.length),
      style: { padding: '3px 10px', borderTop: `1px solid ${token('anic-border')}`, background: token('anic-surface') },
    },
    createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
      createElement('span', { style: { fontSize: 11, fontWeight: 600, color: token('anic-warn-text') } }, cfgText('conflictTitle')),
      createElement('span', { style: { flex: 1 } }),
      h.onDismiss === undefined ? null : createElement('button', {
        type: 'button', 'data-anic-config-conflict-dismiss': 'true',
        onClick: () => h.onDismiss?.(),
        style: { fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color: token('anic-text-faint') },
      }, cfgText('conflictDismiss')),
    ),
    ...conflicts.map(row),
  );
}

/**
 * 备份回调（同款可选理由：数据腿在装配层）。
 *
 * 缺省时**不渲染恢复按钮**——宁可让用户看到"有备份但这里不能恢复"，
 * 也不给一个点了没反应的按钮（前者是事实，后者是撒谎）。
 */
export interface BackupHandlers {
  /** 预览恢复（dryRun：看 diff，不动磁盘）。 */
  onPreviewRestore?: (name: string) => void;
  /** 真恢复。 */
  onRestore?: (name: string) => void;
}

export interface BackupInput {
  /** 带 diff 摘要的清单（新到旧）。 */
  views: readonly BackupViewJson[];
  /** 回落用：老宿主只给名字列表。 */
  names?: readonly string[];
  /** 恢复进行中的备份名（按钮禁用）。 */
  busyName?: string | null;
  /** 恢复结果反馈（成功/失败原文）。 */
  result?: { ok: boolean; message: string; safetyBackupPath?: string | null } | null;
}

/**
 * 备份下拉（含 diff 摘要与恢复按钮）。
 *
 * 为什么不是 `<select>`：每项要带「改了 N 个字段 + 哪几个」与两个按钮，
 * 原生 select 装不下这些结构，硬塞会让选项文本变成一长串。这里用
 * 可折叠的列表（原生 `<details>`，零 JS 状态），列表项各自是完整的一行。
 */
export function renderBackupPanel(input: BackupInput, h: BackupHandlers): ReactElement | null {
  const views: readonly BackupViewJson[] = input.views.length > 0
    ? input.views
    : (input.names ?? []).map((name) => ({ name, at: null, bytes: 0, changedFields: [], values: {} }));
  if (views.length === 0) {
    return createElement('div', { 'data-anic-config-backups': 'none', style: { padding: '2px 10px', fontSize: 10, color: token('anic-text-faint') } },
      cfgText('backupNone'));
  }
  const busyName = input.busyName ?? null;
  const row = (v: BackupViewJson): ReactElement => {
    const busy = busyName === v.name;
    const fields = v.changedFields.length > 0
      ? cfgText('backupChanged', { count: String(v.changedFields.length) }) + ' ' + v.changedFields.join(', ')
      : cfgText('backupChanged', { count: '0' });
    return createElement(
      'div',
      { key: v.name, 'data-anic-config-backup-row': v.name, style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', padding: '1px 0' } },
      createElement('code', { style: { fontSize: 10, color: token('anic-text-dim'), wordBreak: 'break-all' } }, v.name),
      createElement('span', { 'data-anic-config-backup-at': v.name, style: { fontSize: 9, color: token('anic-text-faint') } }, v.at ?? '-'),
      createElement('span', { 'data-anic-config-backup-diff': v.name, style: { fontSize: 10, color: v.changedFields.length > 0 ? token('anic-warn-text') : token('anic-text-faint') } }, fields),
      h.onPreviewRestore === undefined ? null : createElement('button', {
        type: 'button', 'data-anic-config-backup-preview': v.name, disabled: busy,
        onClick: busy ? undefined : () => h.onPreviewRestore?.(v.name),
        style: { fontSize: 10, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'transparent', color: token('anic-text-dim') },
      }, cfgText('backupPreviewRestore')),
      h.onRestore === undefined ? null : createElement('button', {
        type: 'button', 'data-anic-config-backup-restore': v.name, disabled: busy,
        onClick: busy ? undefined : () => h.onRestore?.(v.name),
        style: { fontSize: 10, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'transparent', color: busy ? token('anic-text-faint') : token('anic-warn-text') },
      }, busy ? cfgText('backupRestoring') : cfgText('backupRestore')),
    );
  };
  const res = input.result ?? null;
  return createElement(
    'div',
    { 'data-anic-config-backups': String(views.length), style: { padding: '2px 10px 4px' } },
    createElement('div', { style: { fontSize: 10, fontWeight: 600, color: token('anic-text-strong'), marginTop: 4 } }, cfgText('backupTitle')),
    ...views.map(row),
    res === null
      ? null
      : createElement('div', {
          'data-anic-config-backup-result': res.ok ? 'ok' : 'fail',
          style: { fontSize: 10, color: res.ok ? token('anic-ok-text') : token('anic-bad-text'), marginTop: 2 },
        },
        res.message,
        // 回滚前的状态落在哪必须说出来——这是「回滚可再回滚」的唯一线索。
        res.ok && res.safetyBackupPath !== null && res.safetyBackupPath !== undefined
          ? [' ', cfgText('backupSafety'), ' ', res.safetyBackupPath]
          : null),
  );
}
