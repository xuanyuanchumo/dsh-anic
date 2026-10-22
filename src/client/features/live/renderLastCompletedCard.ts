/**
 * 「最近一次已完成调用全貌卡」（cycle-71 T-7131·用户要求核心）。
 *
 * 用户原话：默认只展开**最近一次已完成的技能插件调用**，把调用自身的数据、
 * 流程流向、运行状态、运行产物白盒透明化。此前面板默认展开的是分区块，
 * 「最近完成的那一次调用」散落在某个 turn 组里，其**全貌**（身份/时序/入参/
 * 产出/裁决）没有单点落点。
 *
 * 七段设计（用户要求的七个面）与诚实边界：
 *   ① 身份  name + callId 前 8 + turn/step；
 *   ② 时序  startedAt → endedAt + durationMs（>0 门槛，epoch 0 占位不算时刻）；
 *   ③ 参数  argumentsPreview；
 *   ④ 产出  resultPreview（done）或 error 三元组 name/code/reason（error）；
 *   ⑤ 归属  cycle · phase——该调用**发生瞬间**的流程坐标（cycle-71 T-10501）：
 *           宿主在 `tool/call` 事件到达时解析并沉淀进记录，故是**精确字段**，
 *           非 heuristic；两条都缺（多会话歧义/文件缺失）→ 整段不渲染
 *           （不渲染空壳，宁缺勿猜 INV-27）；
 *   ⑥ 证据  **不渲染**——仍无与单次调用绑定的工件路径字段（⑤ 已落地，
 *           ⑥ 待 host 扩字段；如实留空而非伪造）；
 *   ⑦ 门禁裁决  仅当 name ∈ GATE_TOOL_GATES 时按「工具 → 账本 gate」映射取
 *           最近一条账本条目，并**带 heuristic 标注**（工具名 → gate 是推断，
 *           不是结构化事实——INV-27；账本无匹配条目则整段不渲染）。
 *
 * a11y：role="region" + aria-label 命名地标；**不进 live region**（APG：随
 * 轮询自动更新的内容不得放进 aria-live，否则屏幕阅读器被淹没）；参数/结果
 * 长串做视觉截断 + title 全文，不用 aria-label 覆盖字面值（AT 读到的必须
 * 就是可见的那个值）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { InvocationJson } from './renderInvocationsTypes.ts';

/**
 * 门禁裁决段的**最小账本视图**（只声明本卡真正消费的两个字段）。
 *
 * 为什么不直接 import ledger 域的 LedgerListJson：G-FEAT 特性边界守卫禁止
 * features/<域>/ 之间互相 import（cycle-58 清零后回归钉）。本仓既有纪律是
 * 「每域自持与数据面结构对齐的最小客户端形状」（renderInvocationsTypes /
 * renderSkillHealth 的 ScriptHealthJson 同款），故此处声明最小视图——
 * ledger 域的完整响应结构**结构可赋值**给它（多出的 total/gateName 等字段
 * 对本卡无意义，不构成耦合）。
 */
export interface GateLedgerView {
  entries: ReadonlyArray<{ gate: string; result: 'PASS' | 'FAIL' }>;
}

/** 参数/结果单字段字面上限（超长只截展示，title 给全文）。 */
const FIELD_CAP = 240;

/** 门禁工具 → 账本 gate 集（只有这三类工具具备门禁裁决语义）。 */
const GATE_TOOL_GATES: Record<string, readonly string[]> = {
  anic_gate_check: ['G0', 'G1', 'G2', 'G3'],
  anic_flows_gate_check: ['G0', 'G1', 'G2', 'G3'],
  anic_multi_agent_gate: ['intent', 'spec', 'plan', 'pr', 'release'],
};

/** 视觉截断：返回展示串与全文（展示串更短时 title 才有信息量）。 */
function clampText(v: string): { shown: string; full: string } {
  return v.length <= FIELD_CAP ? { shown: v, full: v } : { shown: `${v.slice(0, FIELD_CAP)}…`, full: v };
}

/** epoch ms → 本地 HH:MM:SS；非法（≤0/非有限）→ null（不伪造时刻）。 */
function hhmmss(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 行样式（每段一行：10px 弱化标签 + 值）。 */
function fieldRow(anchor: string, label: string, value: ReactElement | string, key: string): ReactElement {
  return createElement(
    'div',
    { [anchor]: 'true', key, style: { display: 'flex', gap: 6, fontSize: 11, color: token('anic-text') } },
    createElement('span', { style: { color: token('anic-text-faint'), flexShrink: 0 } }, label),
    value,
  );
}

/** 长文本值节点（视觉截断 + title 全文 + 任意处换行）。 */
function longValue(text: string, color: string): ReactElement {
  const c = clampText(text);
  return createElement('span', { title: c.full, style: { color, overflowWrap: 'anywhere' } }, c.shown);
}

/** ⑦ 门禁裁决：工具 → gate 集映射，取最近一条匹配账本条目（无则 null）。 */
function gateFinding(inv: InvocationJson, ledger: GateLedgerView | null | undefined): GateLedgerView['entries'][number] | null {
  const gates = GATE_TOOL_GATES[inv.name];
  if (!gates || !ledger) return null;
  for (let i = ledger.entries.length - 1; i >= 0; i -= 1) {
    const e = ledger.entries[i];
    if (e && gates.includes(e.gate)) return e;
  }
  return null;
}

/**
 * 渲染最近一次已完成调用全貌卡（`inv` 由 mostRecentCompleted 给出；账本
 * 条目可选——缺失或工具非门禁类时 ⑦ 段整段不渲染，不伪造裁决）。
 */
export function renderLastCompletedCard(inv: InvocationJson, ledger?: GateLedgerView | null): ReactElement {
  const callShort = inv.callId.length > 8 ? inv.callId.slice(0, 8) : inv.callId;
  const idValue = typeof inv.turn === 'number' && typeof inv.step === 'number'
    ? `${inv.name} · ${callShort} · t${String(inv.turn)}/s${String(inv.step)}`
    : `${inv.name} · ${callShort}`;
  const startAt = hhmmss(inv.startedAt);
  const endAt = hhmmss(inv.endedAt);
  const timing = [
    startAt !== null && endAt !== null ? `${startAt} → ${endAt}` : startAt ?? endAt,
    typeof inv.durationMs === 'number' ? `${String(inv.durationMs)}ms` : null,
  ].filter((s): s is string => s !== null).join(' · ');
  const gate = gateFinding(inv, ledger);
  // ⑤ 归属：cycle 与 phase 独立可缺——拼出可得的部分（都缺 → 空串 → 整段不渲染）。
  const belonging = [
    typeof inv.cycle === 'string' && inv.cycle !== '' ? inv.cycle : null,
    typeof inv.phase === 'string' && inv.phase !== '' ? inv.phase : null,
  ].filter((s): s is string => s !== null).join(' · ');
  const errorTrio = inv.error
    ? `${inv.error.name}(${inv.error.code})${inv.error.reason ? `: ${inv.error.reason}` : ''}`
    : null;

  return createElement(
    'div',
    {
      'data-anic-last-completed': inv.callId,
      'data-anic-last-completed-status': inv.status,
      role: 'region',
      'aria-label': t('live.cardAria', { name: inv.name }),
      style: { borderTop: `1px solid ${token('anic-border')}`, padding: '4px 10px 6px', display: 'flex', flexDirection: 'column', gap: 2 },
    },
    createElement('div', { 'data-anic-last-completed-title': 'true', style: { fontSize: 11, fontWeight: 600, color: token('anic-text-strong') } },
      t('live.cardTitle')),
    // ① 身份
    fieldRow('data-anic-last-completed-identity', t('live.cardIdentity'), createElement('span', { style: { fontFamily: 'ui-monospace, monospace' } }, idValue), 'id'),
    // ② 时序（无合法时刻且无时长 → 整行不渲染，不渲染空壳）
    timing !== ''
      ? fieldRow('data-anic-last-completed-timing', t('live.cardTiming'), createElement('span', { style: { fontFamily: 'ui-monospace, monospace' } }, timing), 'timing')
      : null,
    // ③ 参数
    inv.argumentsPreview !== ''
      ? fieldRow('data-anic-last-completed-args', t('live.cardArguments'), longValue(inv.argumentsPreview, token('anic-text-dim')), 'args')
      : null,
    // ④ 产出：error 三元组优先，其次 done 的 resultPreview
    errorTrio !== null
      ? fieldRow('data-anic-last-completed-error', t('live.cardError'), longValue(errorTrio, token('anic-fail')), 'err')
      : inv.resultPreview
        ? fieldRow('data-anic-last-completed-result', t('live.cardResult'), longValue(inv.resultPreview, token('anic-text-dim')), 'res')
        : null,
    // ⑤ 归属（cycle-71 T-10501：宿主扩了 join key —— 该调用**发生瞬间**的流程坐标）。
    //   精确字段，**不是** heuristic（值在 tool/call 事件到达时沉淀进记录）；
    //   两条都缺（多会话歧义/文件缺失）→ 整段不渲染（不渲染空壳，INV-27）。
    belonging !== ''
      ? fieldRow('data-anic-last-completed-belonging', t('live.cardBelonging'),
          createElement('span', { style: { fontFamily: 'ui-monospace, monospace' } }, belonging), 'belong')
      : null,
    // ⑥ 证据：仍无与单次调用绑定的工件路径字段——刻意不渲染（见文件头诚实边界）。
    // ⑦ 门禁裁决（+ heuristic 标注，INV-27）
    gate !== null
      ? fieldRow('data-anic-last-completed-gate', t('live.cardGate'),
          createElement('span', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
            createElement('span', { 'data-anic-last-completed-gate-value': gate.gate, style: { color: gate.result === 'PASS' ? token('anic-pass') : token('anic-fail'), fontWeight: 600 } }, `${gate.gate} ${gate.result}`),
            createElement('span', { 'data-anic-last-completed-gate-heuristic': 'true', title: t('trace.heuristicTitle'), style: { color: token('anic-warn-text'), fontSize: 10 } }, t('trace.heuristic'))),
          'gate')
      : null,
  );
}
