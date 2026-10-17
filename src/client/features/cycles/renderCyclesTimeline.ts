/**
 * Cycle 时间线分区（B1，P0 UI 缺口，cycle-16 ui-domain-plan §3.2）。
 *
 * 用户旅程：「循环走到哪了」——64+ 个 cycle 此前只能从图上数圆点，没有任何
 * 时间维呈现。本分区把 GET /anic/cycle/list（cycles 数组）渲染为水平条带：
 * 每 cycle 一格；当前 cycle（state 聚合）高亮 + 脉冲；过去 cycle 不加裁决
 * （**诚实边界**：/anic/cycle/state 的状态机是全局单份 workflow-state.json，
 * 只反映当前 cycle 的推进——给历史 cycle 画 PASS/FAIL 是伪造，不做）。
 *
 * 着色走 VERDICT_SHAPE 同款双通道思路（gateColors.ts 的 canonicalVerdict 归一），
 * 但语义只有三档：current（active 琥珀脉冲）/ done-today（类型色）/ plain。
 *
 * 数据源（响应形状核验自 src/host/routes/cycleRoute.ts:82-89 + cycleRunner.ts:29-43）：
 *   GET /anic/cycle/list → { cycles: number[], nextCycleNumber: number }
 *   GET /anic/cycle/state → { nodes, edges, state }（本分区只消费它的 state
 *   键集合做「当前推进节点数」摘要——判断最新 cycle 是否活跃）。
 *
 * 纯函数渲染器（与 renderFlows 同构）：不持状态、不发请求。
 * 不加新 flow 开关（开关注册是 lead 的域）；分区默认随面板渲染，
 * 关闭形态问题留给 lead 处置。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** GET /anic/cycle/list 响应（客户端最小形状）。 */
export interface CycleListJson {
  cycles: number[];
  nextCycleNumber: number;
}

/** 形状守卫：cycles 数组是唯一硬契约（与 fetchJson.ts isFlowStatus 同族）。 */
export function isCycleList(value: unknown): value is CycleListJson {
  return typeof value === 'object' && value !== null && Array.isArray((value as { cycles?: unknown }).cycles);
}

/** 形状守卫：cycle/state 的 state 是对象（宽松，与 isObjectLike 同纪律）。 */
export function isCycleState(value: unknown): value is CycleStateJson {
  return typeof value === 'object' && value !== null
    && typeof (value as { state?: unknown }).state === 'object' && (value as { state?: unknown }).state !== null;
}

export const CYCLE_LIST_URL = '/anic/cycle/list';
export const CYCLE_STATE_URL = '/anic/cycle/state';

/** GET /anic/cycle/state 的 state 键集合（只数推进了的节点，形状从简）。 */
export interface CycleStateJson {
  state: Record<string, unknown>;
}

/** 当前 cycle 的活跃摘要：list 尾项 + state 里 done/blocked 的节点数。 */
export interface CycleTimelineInput {
  list: CycleListJson | null;
  state: CycleStateJson | null;
}

/** state 键集合里非 pending 的节点数（推进计数；含 done/running/blocked）。 */
export function advancedCountOf(state: CycleStateJson | null): number {
  if (state === null || state.state === null || typeof state.state !== 'object') return 0;
  let n = 0;
  for (const v of Object.values(state.state)) {
    const status = (v as { status?: unknown } | null)?.status;
    if (typeof status === 'string' && status !== 'pending') n += 1;
  }
  return n;
}

/** 渲染 Cycle 时间线条带。list=null → 整区不渲染（不伪造空态，与 renderFlows 同纪律）。 */
export function renderCyclesTimeline(input: CycleTimelineInput): ReactElement | null {
  const { list, state } = input;
  if (list === null) return null;
  if (!Array.isArray(list.cycles) || list.cycles.length === 0) return null;

  const advanced = advancedCountOf(state);
  const latest = list.cycles[list.cycles.length - 1] ?? null;

  const cells = list.cycles.map((num, i) => {
    const isCurrent = num === latest;
    return createElement(
      'span',
      {
        key: `cycle-${String(num)}`,
        'data-anic-cycle-cell': String(num),
        'data-anic-cycle-current': isCurrent ? 'true' : undefined,
        title: isCurrent
          ? t('cycles.currentTitle', { num: String(num), advanced: String(advanced) })
          : t('cycles.pastTitle', { num: String(num) }),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 18, height: 16, marginRight: 2, borderRadius: 2,
          fontSize: 9,
          background: isCurrent ? token('anic-status-active') : token('anic-type-cycle'),
          color: token('anic-on-accent'),
          // 当前格字形第二通道（WCAG 1.4.1）：▶ 与历史格 · 在无色下也可分。
          fontWeight: isCurrent ? 700 : 400,
        },
      },
      isCurrent ? '▶' : '·',
      i % 10 === 9 || isCurrent ? String(num) : '',
    );
  });

  return createElement(
    'div',
    { 'data-anic-cycles-wrap': 'true', style: { borderTop: `1px solid ${token('anic-border')}`, padding: '6px 10px 8px' } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', fontSize: 11, color: token('anic-text'), marginBottom: 4 } },
      createElement('strong', null, t('cycles.title', { total: String(list.cycles.length) })),
      createElement('span', { style: { color: token('anic-text-faint') } },
        latest !== null
          ? t('cycles.summary', { latest: String(latest), next: String(list.nextCycleNumber), advanced: String(advanced) })
          : t('cycles.noLatest')),
    ),
    // 条带本体：横向 flex，窄面板自动换行（容器查询 420px 档无需特判）。
    createElement(
      'div',
      { 'data-anic-cycle-strip': 'true', role: 'img', 'aria-label': t('cycles.ariaLabel', { total: String(list.cycles.length), latest: latest === null ? '—' : String(latest) }), style: { display: 'flex', flexWrap: 'wrap', gap: 0, alignItems: 'center' } },
      ...cells,
    ),
  );
}
