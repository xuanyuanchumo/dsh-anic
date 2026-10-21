/**
 * 自主级仪表带（ui-domain-plan P2 · cycle-20）——org 全景的"一眼可读"形态。
 *
 * 旅程：「AI 的自主权现在是多少、往哪走」。renderOrgStatus 的 autonomy/band
 * 两段是纯文本行；本渲染器把它们收敛为单行仪表：L1–L4 刻度 + 当前档指针 +
 * 配置档双指针（分歧=降级中可观测）+ 熔断徽标 + 性能带芯片 + 分数火花线。
 *
 * 纯函数渲染器范式：不持状态、不发请求（数据来自面板既有 org-status 轮询，
 * 零新端点）；OrgStatusJson 类型复用 org 域（接口形状单一事实源）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { OrgStatusJson } from '../../components/panelTypes.ts';

/** 刻度顺序与 trustModel.AutonomyBand 一致（L1–L4；宿主自主级枚举的单一事实源在那）。 */
const BANDS = ['L1', 'L2', 'L3', 'L4'] as const;

/** 性能带 → 语义色（band-normal/warn/alarm 令牌族，图形对比度 ≥3:1）。 */
function bandFill(band: string): string {
  if (band === 'normal') return token('anic-band-normal');
  if (band === 'warn') return token('anic-band-warn');
  return token('anic-band-alarm');
}

/** 分数序列（0-100）→ 火花线 points 属性。少于 2 点返回 null（画不出线）。
 *
 * cycle-20 真机发现：宿主侧 band-history.json 是「代码质量带」历史（cycle-15 的
 * 技术债带检测器），entry 无 `score` 字段（是 avgScore/totalScore/fileCount）——
 * `map(e => e.score)` 会产出 `[null, null]`。火花线对 null/非有限值逐点跳过，
 * 有效点 <2 时不画线（不伪造平线）。
 */
function sparkPoints(recent: number[] | undefined): string | null {
  if (!recent) return null;
  const valid = recent.filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  if (valid.length < 2) return null;
  const w = 64;
  const h = 14;
  const step = w / (valid.length - 1);
  return valid
    .map((s, i) => {
      const clamped = Math.max(0, Math.min(100, s));
      return `${String(Math.round(i * step))},${String(Math.round(h - (clamped / 100) * h))}`;
    })
    .join(' ');
}

/**
 * 渲染自主级仪表带。status 为 null 时由调用方不渲染（面板已门控 orgStatus 非空）。
 */
export function renderAutonomyGauge(status: OrgStatusJson): ReactElement {
  const current = status.autonomy.currentBand;
  const configured = status.autonomy.configuredBand;
  const divergent = configured !== undefined && configured !== current;
  const breakers = status.autonomy.breakers.length;
  const recommended = status.trust.recommendedBand;
  const points = sparkPoints(status.band.recent);

  const segStyle = (isCurrent: boolean, isConfigured: boolean): Record<string, unknown> => ({
    display: 'inline-block',
    minWidth: 26,
    textAlign: 'center' as const,
    padding: '1px 6px',
    fontSize: 10,
    fontFamily: 'ui-monospace, monospace',
    // 当前档：实底 + 粗字（填充块是色盲第二通道，不依赖颜色区分档位）；
    // 配置档（分歧时）：虚线描边——双指针语义，降级一眼可辨。
    background: isCurrent ? token('anic-surface-active') : 'transparent',
    color: isCurrent ? token('anic-text-strong') : token('anic-text-dim'),
    border: `1px ${isConfigured && !isCurrent ? 'dashed' : 'solid'} ${isConfigured ? token('anic-doubt') : token('anic-border')}`,
    fontWeight: isCurrent ? 700 : 400,
  });

  return createElement(
    'section',
    {
      'data-anic-gauge': 'section',
      style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const, padding: '4px 10px 6px', fontSize: 10, color: token('anic-text-dim') },
    },
    createElement(
      'div',
      {
        // 刻度条整体是一个"图形"：aria-label 给全文描述，避免逐段播报四个碎片。
        role: 'img',
        'data-anic-gauge-scale': current,
        'aria-label': t('gauge.ariaLabel', { current, configured: configured ?? current, breakers: String(breakers), band: status.band.current, trend: status.band.trend }),
        style: { display: 'flex', gap: 2 },
      },
      ...BANDS.map((b) => createElement(
        'span',
        { key: b, 'data-anic-gauge-seg': b, 'data-current': b === current ? 'true' : 'false', 'data-configured': b === configured ? 'true' : 'false', style: segStyle(b === current, b === configured) },
        b,
      )),
    ),
    // 分歧说明行：双指针的语义出口（不靠虚线自解释）。
    divergent ? createElement('span', { 'data-anic-gauge-divergent': 'true', style: { color: token('anic-doubt') } }, t('gauge.divergent', { current, configured: configured ?? '' })) : null,
    // 熔断徽标：0 → 无熔断（✓ 绿）；>0 → ⚠ 红字形双通道。
    createElement(
      'span',
      {
        'data-anic-gauge-breakers': String(breakers),
        style: { color: breakers > 0 ? token('anic-fail') : token('anic-pass') },
      },
      breakers > 0 ? `⚠ ${t('gauge.breakers', { count: String(breakers) })}` : `✓ ${t('gauge.noBreakers')}`,
    ),
    // 性能带芯片：色块 + 文本双通道。
    createElement(
      'span',
      { 'data-anic-gauge-band': status.band.current, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: bandFill(status.band.current) } }),
      t('gauge.bandChip', { band: status.band.current, trend: status.band.trend }),
    ),
    // 信任模型建议档：与当前不一致时显式「往哪走」。
    recommended !== current ? createElement('span', { 'data-anic-gauge-recommended': recommended, style: { color: token('anic-text-faint') } }, t('gauge.recommended', { band: recommended })) : null,
    // 分数火花线：SVG 折线（最近 12 点，orgStatus band.recent 数据面）。
    points
      ? createElement(
          'svg',
          {
            'data-anic-gauge-sparkline': 'true',
            width: 64,
            height: 14,
            viewBox: '0 0 64 14',
            role: 'img',
            'aria-label': t('gauge.sparkline'),
            style: { flexShrink: 0 },
          },
          createElement('polyline', { points, fill: 'none', stroke: bandFill(status.band.current), strokeWidth: 1.5 }),
        )
      : null,
  );
}
