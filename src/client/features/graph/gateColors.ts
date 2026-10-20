/**
 * M3 门禁三态色 + FAIL 脉冲 + 节点详情。
 *
 * 三态色：PASS 绿 / FAIL 红 / doubt 黄 / pending 灰 / 无裁决 用类型色
 * FAIL 脉冲：CSS @keyframes，prefers-reduced-motion 禁用
 * 控制带：2σ/3σ 边框（在诊断面板呈现）
 */

import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

// ── 三态色 ──────────────────────────────────────────────

/**
 * 三态色改为令牌引用（P1-TOKENS）。
 *
 * 改造前这里是一张私有十六进制表，于是同一个「PASS 绿」在 renderGraph /
 * gateColors / renderStepTrace 三处各写一份，暗色主题只能覆盖到其中被
 * `var()` 引用的那一份 —— 另外两份永远停在浅色档。
 *
 * 键 = `canonicalVerdict` 的五个规范键（全小写）。原先 PASS/FAIL 大写是
 * 遗留拼写，归一化后必须一致，否则 `GATE_COLORS[key]` 永远查空。
 */
export const GATE_COLORS = {
  pass: token('anic-gate-pass'),
  fail: token('anic-gate-fail'),
  doubt: token('anic-gate-doubt'),
  pending: token('anic-gate-pending'),
  skip: token('anic-gate-skip'),
} as const;

/**
 * 把任意裁决拼写归一到五个规范键：pass / fail / doubt / pending / skip。
 *
 * 这是**全仓唯一**的裁决别名表（单一事实来源）。改造前 `gateFillOf` 与
 * renderGraph 的 `verdictKey` 各持一份，靠测试对账防止漂移——两份枚举迟早
 * 漂移，且第三份（文本色）正在加入，于是把归一化收敛到这里：
 *   - `gateFillOf`（SVG 填充）与本文件 `gateTextColorOf`（文本）都查本表；
 *   - renderGraph 的 `verdictKey` 直接转出口（线型/字形键）。
 *
 * 修因（gateColors.ts:124 的混合角色缺陷）：门禁填充按「非文本 ≥3.3」校准，
 * 而 `gateFillOf` 的返回值曾被当作**文本** color 消费——实测 3.3:1，
 * 低于 WCAG 正文 4.5。文本侧必须走文本级令牌，于是需要第三张映射，
 * 而第三张映射绝不能再是第三份别名表。
 */
export function canonicalVerdict(verdict: string | undefined): 'pass' | 'fail' | 'doubt' | 'pending' | 'skip' | null {
  if (verdict === undefined || verdict === '') return null;
  const v = verdict.toLowerCase();
  if (v === 'pass' || v === 'approve') return 'pass';
  if (v === 'fail' || v === 'reject') return 'fail';
  if (v === 'doubt') return 'doubt';
  if (v === 'pending') return 'pending';
  if (v === 'skip' || v === 'skipped') return 'skip';
  return null;
}

/** 根据裁决返回填充色；无裁决返回 null（用类型色） */
export function gateFillOf(verdict: string | undefined): string | null {
  const key = canonicalVerdict(verdict);
  if (key === null) return null;
  return GATE_COLORS[key];
}

/**
 * 根据裁决返回**文本**色（节点详情行等 color: 消费点）。
 *
 * 填充色与文本色是两个对比度档位：填充按非文本 ≥3.3 校准（画在圆里、
 * 面积大），文本按 ≥4.5 校准（11px 等宽字、笔画细）。同一裁决在两种角色
 * 下必须取各自档位的令牌——混用就是 :124 的原始缺陷。
 * pending/skip 无裁决语义色，用 anic-text-dim（信息性文字档）。
 */
export function gateTextColorOf(verdict: string | undefined): string | null {
  const key = canonicalVerdict(verdict);
  if (key === null) return null;
  if (key === 'pass') return token('anic-pass');
  if (key === 'fail') return token('anic-fail');
  if (key === 'doubt') return token('anic-doubt');
  return token('anic-text-dim');
}

// ── FAIL 脉冲 CSS（B4：本体迁移至 components/statusDot.ts，此处转出保 import 面）──

import { FAIL_PULSE_STYLE as FAIL_PULSE_STYLE_SRC } from '../../components/statusDot.ts';
export const FAIL_PULSE_STYLE = FAIL_PULSE_STYLE_SRC;

// ── 控制带（2σ/3σ） ─────────────────────────────────────

export interface ControlBand {
  mean: number;
  sigma2: number; // 2σ 边界
  sigma3: number; // 3σ 边界
  value: number;
  label: string;
}

/** 判定值在控制带中的位置 */
export function bandStatus(band: ControlBand): 'normal' | 'warn' | 'alarm' {
  const dev = Math.abs(band.value - band.mean);
  if (dev > band.sigma3) return 'alarm';
  if (dev > band.sigma2) return 'warn';
  return 'normal';
}

export const BAND_COLORS: Record<string, string> = {
  normal: token('anic-band-normal'),
  warn: token('anic-band-warn'),
  alarm: token('anic-band-alarm'),
};

/** 渲染控制带行 */
export function renderControlBand(band: ControlBand): ReactElement {
  const status = bandStatus(band);
  return createElement(
    'div',
    {
      'data-anic-band': band.label,
      style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, padding: '2px 0' },
    },
    createElement('span', { style: { minWidth: 80, color: token('anic-text-strong') } }, band.label),
    createElement('span', { style: { color: BAND_COLORS[status], fontWeight: 'bold' } }, status.toUpperCase()),
    createElement('span', { style: { color: token('anic-text-faint') } }, `μ=${String(band.mean.toFixed(1))} 2σ=${String(band.sigma2.toFixed(1))} 3σ=${String(band.sigma3.toFixed(1))} val=${String(band.value.toFixed(1))}`),
  );
}

// ── 节点详情抽屉 ────────────────────────────────────────

export interface NodeDetail {
  id: string;
  label: string;
  type: string;
  result?: string;
  detail?: string;
  timestamp?: string;
  previousHash?: string;
  /** W-3 全档（cycle-39）：G2 事件节点的测试报告摘要（「这轮测试什么状态」）。 */
  testReport?: { report: string; passed: number; failures: number; errors: number; layers: string[] };
}

/**
 * 抽屉可交互选项（B5.2 焦点管理）。
 *
 * - `detailId`：容器 id（面板实例生成，与关闭后焦点还原的 querySelector 同源）；
 * - `onClose`：关闭回调。存在时抽屉升级为可关闭 + 键盘可达：
 *   ① 关闭按钮（消费 locale 键 panel.detailClose，此前为死键）；
 *   ② 容器 onKeyDown：Esc 触发 onClose（non-passive 语义：preventDefault 防止
 *      Esc 同时折叠宿主侧其他 UI）；
 *   ③ 关闭按钮 autoFocus：打开时焦点落在抽屉内的第一个控件（APG disclosure
 *      实践），键盘用户立即可 Esc 关闭；
 *   ④ 容器 role="region" + aria-label：AT 可跳入的地标。
 * 焦点还原（关闭后回触发元素）在面板层实现：onClose 里把焦点还给图区 svg
 * （document.querySelector('svg[data-anic-graph]')），不引 focus-trap。
 */
export interface NodeDetailOptions {
  detailId: string;
  onClose: () => void;
}

export function renderNodeDetail(node: NodeDetail | null, opts?: NodeDetailOptions): ReactElement | null {
  if (node === null) return null;
  const closable = opts !== undefined;
  return createElement(
    'div',
    {
      'data-anic-node-detail': 'true',
      id: opts?.detailId,
      role: closable ? 'region' : undefined,
      'aria-label': closable ? t('panel.nodeDetailLabel', { label: node.label }) : undefined,
      onKeyDown: closable
        ? (ev: { key: string; preventDefault: () => void }) => {
            if (ev.key === 'Escape') { ev.preventDefault(); opts.onClose(); }
          }
        : undefined,
      style: {
        position: 'sticky', bottom: 0, background: token('anic-detail-surface'),
        borderTop: `2px solid ${token('anic-border')}`, padding: '8px 12px', fontSize: 11,
        fontFamily: 'monospace', maxHeight: 200, overflow: 'auto',
      },
    },
    closable
      ? createElement('button', {
          type: 'button', 'data-anic-node-detail-close': 'true', className: 'anic-btn',
          autoFocus: true, onClick: opts.onClose,
          style: { float: 'right', fontSize: 11, padding: '1px 8px', margin: '-2px 0 4px 8px' },
        }, t('panel.detailClose'))
      : null,
    createElement('div', { style: { fontWeight: 'bold', marginBottom: 4 } }, `${node.label} [${node.type}]`),
    createElement('div', { style: { color: token('anic-text-strong') } }, `id: ${node.id}`),
    node.result !== undefined
      ? createElement('div', { style: { color: gateTextColorOf(node.result) ?? token('anic-text-strong'), fontWeight: 'bold' } }, `result: ${node.result}`)
      : null,
    node.detail !== undefined
      ? createElement('div', { style: { color: token('anic-text-dim'), marginTop: 4, wordBreak: 'break-all' } }, node.detail)
      : null,
    node.testReport !== undefined
      ? createElement(
          'div',
          { 'data-anic-node-testreport': 'true', style: { marginTop: 6, paddingTop: 6, borderTop: `1px solid ${token('anic-border')}` } },
          createElement('div', { style: { fontWeight: 'bold' } }, `测试报告: ${node.testReport.report}`),
          createElement(
            'div',
            { style: { marginTop: 2 } },
            `通过 ${node.testReport.passed} · `,
            createElement('span', { style: { color: node.testReport.failures > 0 ? token('anic-fail') : token('anic-text-strong'), fontWeight: 'bold' } }, `失败 ${node.testReport.failures}`),
            ` · `,
            createElement('span', { style: { color: node.testReport.errors > 0 ? token('anic-fail') : token('anic-text-strong'), fontWeight: 'bold' } }, `错误 ${node.testReport.errors}`),
          ),
          ...node.testReport.layers.map((l, i) =>
            createElement('div', { key: `layer-${String(i)}`, style: { color: token('anic-text-faint'), marginTop: 1 } }, l),
          ),
        )
      : null,
    node.timestamp !== undefined
      ? createElement('div', { style: { color: token('anic-text-faint'), marginTop: 4 } }, `ts: ${node.timestamp}`)
      : null,
    node.previousHash !== undefined
      ? createElement('div', { style: { color: token('anic-text-faint') } }, `prev: ${node.previousHash.slice(0, 16)}…`)
      : null,
  );
}
