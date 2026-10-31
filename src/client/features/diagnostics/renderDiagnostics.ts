/**
 * 诊断分区渲染（纯函数，L5）：GET /anic/api/self-check 的 JSON。
 * 展示六项 Runtime INV Probes 结果；失败项红、通过项绿，404（宿主无路由）时
 * 由面板层显示"诊断不可用"——本函数只处理拿到数据的情况。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { renderControlBandRow, type ControlBandJson } from './renderControlBandRow.ts';
import { t } from '../../i18n.ts';
import { DataRow, toneColor } from '../../components/dataRow.ts';

export interface ProbeJson {
  id: string;
  inv?: string;
  ok: boolean;
  detail: string;
}

export interface SelfCheckJson {
  checks: ProbeJson[];
  allOk: boolean;
  requestId: string;
  /**
   * 控制带读数（cycle-96 · 来自 `GET /anic/band-detect` 的 `controlBand`）。
   *
   * 为什么挂在自检分区：控制带回答的是「当前观测值相对历史 μ/σ 偏了多少」——
   * 那是**诊断**语义（跟探针同一类"系统此刻是否健康"），不是预算/账本类治理数据。
   * 缺省 undefined ⇒ 不渲染（零参调用行为不变，与分区既有纪律一致）。
   */
  controlBand?: ControlBandJson | undefined;
}

export function renderDiagnostics(check: SelfCheckJson): ReactElement {
  // B4：flex 基线行收敛到 components/dataRow（原为域内联 style 的重复形状）。
  const rows = check.checks.map((p) =>
    DataRow({
      key: p.id, anchorKey: 'data-anic-probe', anchor: p.id,
      style: { fontSize: 11, padding: '2px 4px' },
      children: [
        // B6.1：PASS/FAIL 走 locale（diag.pass / diag.fail 双侧键已有，此前是
        // 本文件唯一的用户面硬编码字面量）。en 侧文案同为 PASS/FAIL，
        // 缺省 zh 侧输出不变（回归红线）。
        createElement('span', { style: { color: toneColor(p.ok ? 'ok' : 'bad'), fontWeight: 600 } }, p.ok ? t('diag.pass') : t('diag.fail')),
        createElement('span', { style: { color: token('anic-text'), minWidth: 210 } }, p.inv ? `${p.id} (${p.inv})` : p.id),
        createElement('span', { style: { color: toneColor('dim') } }, p.detail),
      ],
    }),
  );
  // 控制带行（cycle-96）：探针之后、requestId 之前 —— 先看"逐个检查"，再看"整体漂移"。
  // 缺省不渲染（零参调用仍是改造前的分区形态）。
  const controlBandRow = check.controlBand === undefined
    ? null
    : renderControlBandRow(check.controlBand);
  return createElement(
    'div',
    { 'data-anic-diagnostics': 'section', style: { padding: '8px 10px', borderTop: `1px solid ${token('anic-border')}` } },
    createElement('div', { style: { fontSize: 12, fontWeight: 600, color: token('anic-text'), marginBottom: 4 } },
      `${t('diag.title')} · ${check.allOk ? t('panel.allOk') : t('panel.someFailed')}`),
    ...rows,
    controlBandRow,
    createElement('div', { style: { fontSize: 10, color: token('anic-text-faint'), marginTop: 4 } }, t('diag.requestId', { requestId: check.requestId })),
  );
}
