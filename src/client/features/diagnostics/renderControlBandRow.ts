/**
 * 控制带读数渲染（cycle-96）—— 把宿主 `GET /anic/band-detect` 的 `controlBand`
 * 画成一行人能读的控制带说明。
 *
 * ## 为什么这个渲染器此前是死代码
 *
 * `gateColors.renderControlBand` 早就写好（吃 `ControlBand`：mean/σ2/σ3/value/label），
 * 宿主 `runBandDetection` 也算得出均值与标准差 —— 但 `BandResult` 从没把统计量
 * 暴露出来，客户端也**没有任何地方调用** `renderControlBand`。
 * ⇒ 渲染器在等数据、数据在等出口、出口在等消费者，三段各自完备、链条断开。
 *
 * 本文件是**第三段**（消费）：把已经存在的数据接到已经存在的渲染器上。
 * 它不做任何算法 —— 判定由宿主算好（`status`），客户端不重算（避免两套判据）。
 *
 * ## 为什么带 `untrusted` 分支
 *
 * `sampleSize < 2` 时 σ 恒为 0 ⇒ `|value − μ| = 0` ⇒ 永远 normal。数学上没错，
 * 但把"还没有历史"读成"过程非常稳定"是**假绿**。所以样本不足时**不画控制带**，
 * 只如实显示「样本不足（N 点）」—— 空白比一个好看的数字诚实。
 *
 * ## 纯渲染（零 hook / 零 DOM / 零算法）
 *
 * 可独立单测：喂一个 `ControlBandJson` 就得到元素树断言。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** `BandResult.controlBand` 的宽松投影（宿主形状；字段缺失时**不猜**）。 */
export interface ControlBandJson {
  mean?: number;
  stdDev?: number;
  sigma2?: number;
  sigma3?: number;
  value?: number;
  label?: string;
  status?: 'normal' | 'warn' | 'alarm';
  sampleSize?: number;
}

/** `GET /anic/band-detect` 响应（只取本渲染器需要的部分）。 */
export interface BandDetectJson {
  current?: string;
  controlBand?: ControlBandJson;
}

/** 形状守卫：`controlBand` 里的数值字段若存在必须真的是 number（防字符串化数字进渲染）。 */
export function hasControlBand(v: unknown): v is BandDetectJson {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const band = (v as Record<string, unknown>)['controlBand'];
  if (typeof band !== 'object' || band === null || Array.isArray(band)) return false;
  const b = band as Record<string, unknown>;
  // 只要求**参与渲染的**数值字段；label/status 缺失时走降级文案。
  for (const k of ['mean', 'sigma2', 'sigma3', 'value']) {
    if (b[k] !== undefined && typeof b[k] !== 'number') return false;
  }
  return true;
}

/** 判定色（三通道语义与仪表带/账本同款）。 */
function statusColorOf(status: ControlBandJson['status']): string {
  if (status === 'alarm') return token('anic-fail');
  if (status === 'warn') return token('anic-doubt');
  return token('anic-pass');
}

/** 数值格式化（控制带读数保留 1 位；`NaN` 不出现在文本里）。 */
function fmt(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—';
}

/**
 * 渲染控制带行（样本不足时渲染「样本不足」而不是一条看似正常的带）。
 *
 * 锚点：
 *   - `data-anic-control-band`：控制带存在。
 *   - `data-anic-control-band-status`：normal / warn / alarm（判定是宿主算的，不重算）。
 *   - `data-anic-control-band-untrusted`：样本不足（渲染的是说明，不是带）。
 *   - `data-anic-control-band-sample`：参与统计的点数（读数可断言）。
 */
export function renderControlBandRow(band: ControlBandJson | null | undefined): ReactElement | null {
  if (band === null || band === undefined) return null;

  // 形状守卫在**渲染入口**执行（不是只导出等别人调）：字符串化的数字进渲染会
  // 让 `toFixed` 抛 TypeError，而那一抛发生在 React 渲染树里 —— 整块面板挂掉。
  // 守卫失败时按"无数据"处理（不渲染），而不是硬渲染出 NaN。
  if (!hasControlBand({ controlBand: band })) return null;

  const n = typeof band.sampleSize === 'number' ? band.sampleSize : 0;
  // 样本不足：不画带（见文件头「为什么带 untrusted 分支」）。
  if (n < 2) {
    return createElement(
      'div',
      {
        key: 'control-band-untrusted',
        'data-anic-control-band': 'true',
        'data-anic-control-band-untrusted': 'true',
        'data-anic-control-band-sample': String(n),
        role: 'status',
        style: { fontSize: 10.5, color: token('anic-text-faint'), padding: '2px 0' },
      },
      t('diag.controlBandUntrusted', { count: String(n) }),
    );
  }

  const status = band.status ?? 'normal';
  const label = band.label ?? t('diag.controlBandLabel');
  return createElement(
    'div',
    {
      key: 'control-band',
      'data-anic-control-band': 'true',
      'data-anic-control-band-status': status,
      'data-anic-control-band-sample': String(n),
      style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 10.5, padding: '2px 0' },
    },
    createElement('span', {
      key: 'label',
      style: { minWidth: 80, color: token('anic-text-strong') },
    }, label),
    // 判定文字用**颜色 + 文字**双通道（WCAG 1.4.1：颜色不是唯一手段）。
    createElement('span', {
      key: 'status',
      style: { color: statusColorOf(status), fontWeight: 'bold' },
    }, t(`diag.controlBandStatus.${status}`)),
    createElement('span', {
      key: 'readout',
      style: { color: token('anic-text-faint') },
    }, `μ=${fmt(band.mean)} 2σ=${fmt(band.sigma2)} 3σ=${fmt(band.sigma3)} val=${fmt(band.value)}`),
  );
}
