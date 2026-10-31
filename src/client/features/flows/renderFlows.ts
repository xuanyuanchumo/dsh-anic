/**
 * 流程状态机面板分区（cycle-9 · D10 宿主域接线）。
 *
 * FlowRegistry/FlowMachine（R3 阶段 2/3）落成后，状态机只在 HTTP 面
 * （GET /anic/flows*）可观测 —— 客户端一个分区都没消费（D10 域消费率
 * ≈12% 的主因）。本分区消费 GET /anic/flows/status 的一站式响应，
 * 让「每个流程专属的状态流转机」在面板上白盒可见：
 *   - 注册表全景：流程 id/label/引擎/技能回退
 *   - 当前态（语义色）+ 最近转移 + 转移计数
 *   - 从未运行如实显示（projection=null 不伪造 IDLE）
 *
 * 纯函数渲染器范式：不持状态、不发请求（数据获取在面板统一 fetchLive），
 * 与 stepTrace/diagnostics/org 分区同构。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
// cycle-96 WS-A：相位漂移读数条（stored / inferred / drift 三值上屏）。
import type { MacroPhaseStatusJson } from './macroPhaseTypes.ts';
import { renderMacroPhaseDrift } from './renderMacroPhaseDrift.ts';

/** GET /anic/flows/status 响应（与 flowsRoute descriptorView + 投影对齐）。 */
export interface FlowEntryJson {
  id: string;
  labelKey: string;
  states: string[];
  initial: string;
  transitions: Array<{ from: string; to: string; trigger: string; guard: string | null }>;
  persistence: { kind: string; path?: string };
  engine: string | null;
  scriptFallback: string | null;
  projection: {
    flowId: string;
    current: string;
    history: Array<{ trigger: string; from: string; to: string; at: string; reason?: string }>;
    updatedAt: string;
    ledgerHead?: string;
  } | null;
}

export interface FlowStatusJson {
  flows: FlowEntryJson[];
  total: number;
  running: number;
  terminal: number;
  neverRun: number;
  /**
   * cycle-96 WS-A：宏观相位读数（stored / inferred / drift 三值）。
   * 旧宿主没有这个字段 ⇒ undefined ⇒ 读数条整行不渲染（不伪造读数）。
   */
  macroPhase?: MacroPhaseStatusJson | null;
}

/** 状态语义色：运行中=琥珀、成功终态=绿、失败终态=红、其余=淡。 */
function stateColor(state: string): string {
  if (state === 'RUNNING') return token('anic-warn-text');
  if (state === 'PASSED' || state === 'DONE' || state === 'CONVERGED') return token('anic-pass');
  if (state === 'FAILED' || state === 'BLOCKED' || state === 'EXHAUSTED') return token('anic-fail');
  return token('anic-text-faint');
}

const ROW_STYLE: Record<string, string> = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline',
  padding: '4px 10px', fontSize: '11px',
};

/** 渲染流程状态机分区。data=null（未拉取/路由缺失）→ 整区不渲染（不伪造空态）。 */
export function renderFlows(data: FlowStatusJson | null): ReactElement | null {
  if (data === null) return null;
  if (!Array.isArray(data.flows) || data.flows.length === 0) return null;

  return createElement(
    'div',
    { 'data-anic-flows-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}`, paddingBottom: 6 } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', padding: '6px 10px 2px', fontSize: 11, color: token('anic-text') } },
      createElement('strong', {}, t('flows.panelTitle', { total: String(data.total) })),
      createElement('span', { style: { color: token('anic-text-faint') } },
        t('flows.summary', { running: String(data.running), terminal: String(data.terminal), neverRun: String(data.neverRun) })),
    ),
    // cycle-96 WS-A：相位读数条挂在标题行**下方**、明细之上 —— 它回答的是
    // 「这些流程所处的宏观相位，是谁说了算」，属于全景摘要而非某条流程的明细。
    // macroPhase 缺失（旧宿主）→ 该函数返回 null ⇒ 这行不渲染（不伪造读数）。
    renderMacroPhaseDrift(data.macroPhase),
    ...data.flows.map((f) => {
      const label = t(f.labelKey);
      const last = f.projection?.history?.[f.projection.history.length - 1] ?? null;
      return createElement(
        'div',
        { key: f.id, 'data-anic-flow': f.id, style: { ...ROW_STYLE, color: token('anic-text') } },
        // 流程名 + 引擎/回退标识（哪个引擎在驱动、缺引擎时退到哪个技能脚本）
        createElement('span', { style: { fontWeight: 600 } }, label),
        f.engine !== null ? createElement('span', { style: { color: token('anic-text-faint') } }, t('flows.engine', { engine: f.engine })) : null,
        f.scriptFallback !== null ? createElement('span', { style: { color: token('anic-text-faint') } }, t('flows.fallback', { script: f.scriptFallback })) : null,
        // 当前态：语义色；从未运行如实显示（不伪造 IDLE）
        f.projection !== null
          ? createElement('span', { style: { color: stateColor(f.projection.current), fontWeight: 600 } }, t('flows.state', { state: f.projection.current }))
          : createElement('span', { style: { color: token('anic-text-faint') } }, t('flows.neverRun')),
        // 最近转移 + 转移计数（流转历史的可见摘要；完整 history 在投影文件）
        last !== null
          ? createElement('span', { style: { color: token('anic-text-faint') } },
              t('flows.lastEvent', { trigger: last.trigger, from: last.from, to: last.to }))
          : null,
        f.projection !== null && f.projection.history.length > 0
          ? createElement('span', { style: { color: token('anic-text-faint') } },
              t('flows.history', { count: String(f.projection.history.length) }))
          : null,
      );
    }),
  );
}
