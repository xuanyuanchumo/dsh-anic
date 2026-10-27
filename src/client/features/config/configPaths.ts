/**
 * 路径表渲染（cycle-82）—— 只读展示 + 复制按钮。
 *
 * ## 为什么路径表必须显示 exists / bytes / mtime
 *
 * 用户诉求是「路径支持可视化」——但如果只印一串路径字符串，用户仍然不知道
 * 那条路径**现在是否存在**、技能到底装在哪一份、dist 是哪次构建的。
 * 三个元数据各自回答一个问题：exists = 有没有落盘；bytes = 是不是空壳；
 * mtime = 这是不是最新那次构建/安装。
 *
 * ## 为什么事实值与词条分开渲染（不是塞进一个插值串）
 *
 * 大小/mtime/拒绝原因都是**机器事实**，不该被翻译层包成一句自然语言——
 * 一旦词条缺键（locale 尚未合并），插值就整体消失，用户看到的是空白，
 * 而"看不到事实"恰恰是这个面板最不该发生的事。所以这里拆成：
 * 词条负责**框架文字**（"不存在"/"复制"），事实值各自是独立文本节点。
 *
 * ## 复制按钮为什么是「回调 + 降级」
 *
 * 服务端渲染环境下 `navigator.clipboard` 不存在；面板也可能跑在无剪贴板权限
 * 的宿主里。渲染器不碰剪贴板——它只发一个意图，由调用方决定 clipboard 还是
 * 兜底展示（用户可手动选中）。这是纯函数渲染器的边界。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { cfgText, type ConfigPathJson } from './configTypes.ts';

export interface PathTableHandlers {
  /** 复制路径（调用方决定 clipboard 还是兜底展示）。 */
  onCopy: (path: string) => void;
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

/** 单行路径（不存在时路径串仍显示——"该在哪但不在"本身就是信息）。 */
function renderRow(entry: ConfigPathJson, h: PathTableHandlers): ReactElement {
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
    entry.exists && entry.path !== null
      ? createElement('button', {
          type: 'button',
          'data-anic-config-copy': entry.id,
          'aria-label': cfgText('pathCopyLabel', { label: t(entry.labelKey) }),
          onClick: () => h.onCopy(entry.path as string),
          style: { fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color: token('anic-text-dim') },
        }, cfgText('pathCopy'))
      : null,
  );
}

/**
 * 路径表（含自定义路径校验结果的回显）。
 *
 * `probe` 是 GET 带 ?probePath= 时的服务端裁决——被拒时**必须显示原因**，
 * 否则用户只看到"输入了路径但什么都没发生"。原因作为独立文本节点，
 * 不靠插值（同文件头「事实与词条分开」的理由）。
 */
export function renderConfigPaths(
  paths: { entries: ConfigPathJson[]; warnings: string[] },
  probe: { ok: boolean; entry?: ConfigPathJson; reason?: string; code?: string } | null | undefined,
  handlers: PathTableHandlers,
): ReactElement | null {
  if (paths.entries.length === 0) return null;
  const rejected = probe !== null && probe !== undefined && !probe.ok;
  return createElement(
    'div',
    { 'data-anic-config-paths': 'true', style: { padding: '4px 10px 6px' } },
    createElement('div', { style: { fontSize: 11, fontWeight: 600, color: token('anic-text-strong'), margin: '6px 0 2px' } }, cfgText('pathTitle')),
    ...paths.entries.map((e) => renderRow(e, handlers)),
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
