/**
 * HITL 审计队列分区（B2 · P1 声明与实现断层修复，cycle-18）。
 *
 * 数据源（既有路由，零新增 host 面）：
 *   - GET /anic/hitl-audit → { checks[H1..H4], allPassed, anyCircuit }
 *     （nativeRoute.ts:39，H1-H4 语义与 assets/skill/scripts/hitl-audit.mjs 对齐）
 *
 * flow.approvals 开关（flows.ts:51）首次接线到真实 UI——声明多年的
 * 「批准卡/HITL 队列」落地为只读审计视图：H4 账本冲突是人工专属裁决
 * （append-only，human-only），面板绝不提供一键修复——关闭形态契约
 * 「队列只读展示 + 指引改走技能 CLI」即本分区的语义。
 *
 * 纯函数渲染器范式：不持状态、不发请求；data=null → 整区不渲染。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { isObjectLike } from '../live/fetchJson.ts';
import { t } from '../../i18n.ts';

/** GET /anic/hitl-audit 响应（与 nativeRoute hitlAuditView 对齐）。 */
export interface HitlCheckJson {
  check: string;
  passed: boolean;
  circuit: boolean;
  detail: string;
}

export interface HitlAuditJson {
  checks: HitlCheckJson[];
  allPassed: boolean;
  anyCircuit: boolean;
}

export const HITL_AUDIT_URL = '/anic/hitl-audit';

/** 形状守卫：checks 数组且每项含 check/passed 才采信。 */
export function isHitlAudit(v: unknown): v is HitlAuditJson {
  if (!isObjectLike(v)) return false;
  const checks = (v as { checks?: unknown }).checks;
  if (!Array.isArray(checks) || checks.length === 0) return false;
  const first = checks[0] as Record<string, unknown> | undefined;
  return first !== undefined && typeof first.check === 'string' && typeof first.passed === 'boolean';
}

/** H1-H4 的展示名（审计域标签走 locale，不复用 flows.* 的流程名）。 */
const CHECK_LABEL_KEYS: Record<string, string> = {
  H1: 'hitl.checkH1',
  H2: 'hitl.checkH2',
  H3: 'hitl.checkH3',
  H4: 'hitl.checkH4',
};

function checkLabel(check: string): string {
  const key = CHECK_LABEL_KEYS[check];
  return key !== undefined ? t(key) : check;
}

const ROW_STYLE: Record<string, string> = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline',
  padding: '3px 10px', fontSize: '11px',
};

/**
 * 渲染 HITL 审计队列分区。
 * data=null（未拉取/路由缺失/全过且无熔断时的空响应）→ 整区不渲染。
 */
export function renderHitl(audit: HitlAuditJson | null): ReactElement | null {
  if (audit === null) return null;
  if (!Array.isArray(audit.checks) || audit.checks.length === 0) return null;

  // 总评行：全过=绿；有熔断=琥珀（HITL 熔断是「等待人工」不是失败——语义区分）
  const summary = audit.anyCircuit
    ? createElement('span', { 'data-anic-hitl-summary': 'circuit', style: { color: token('anic-warn-text') } }, t('hitl.summaryCircuit'))
    : audit.allPassed
      ? createElement('span', { 'data-anic-hitl-summary': 'pass', style: { color: token('anic-pass') } }, t('hitl.summaryPass'))
      : createElement('span', { 'data-anic-hitl-summary': 'fail', style: { color: token('anic-fail') } }, t('hitl.summaryFail'));

  return createElement(
    'div',
    { 'data-anic-hitl-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}`, paddingBottom: 6 } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', padding: '6px 10px 2px', fontSize: 11, color: token('anic-text') } },
      createElement('strong', {}, t('hitl.title')),
      summary,
    ),
    ...audit.checks.map((c, i) => {
      // 逐项裁决徽章：circuit 优先于 passed（熔断是更强的状态——审计停摆，不是通过）
      const badge = c.circuit
        ? createElement('span', { 'data-anic-hitl-badge': 'circuit', style: { color: token('anic-warn-text'), fontWeight: 600 } }, t('hitl.badgeCircuit'))
        : c.passed
          ? createElement('span', { 'data-anic-hitl-badge': 'pass', style: { color: token('anic-pass'), fontWeight: 600 } }, t('hitl.badgePass'))
          : createElement('span', { 'data-anic-hitl-badge': 'fail', style: { color: token('anic-fail'), fontWeight: 600 } }, t('hitl.badgeFail'));
      return createElement(
        'div',
        { key: `${c.check}-${String(i)}`, 'data-anic-hitl-check': c.check, style: { ...ROW_STYLE, color: token('anic-text') } },
        createElement('span', { style: { fontWeight: 600 } }, c.check),
        createElement('span', {}, checkLabel(c.check)),
        badge,
        c.detail !== '' ? createElement('span', { style: { color: token('anic-text-faint'), flexBasis: '100%' } }, c.detail) : null,
      );
    }),
    // 只读边界 + CLI 指引（degradation 契约的另一半：H4 冲突是人工专属裁决）
    createElement('div', { 'data-anic-hitl-cli-hint': 'true', style: { padding: '2px 10px 4px', fontSize: 10, color: token('anic-text-faint') } },
      t('hitl.cliHint')),
  );
}
