/**
 * 实时调用分区（cycle-97 动态白盒）——把模型对本插件的**调用过程**实时呈现。
 *
 * 与静态分区的本质区别：步骤流程/诊断/org 读的是**已落盘的产物**（评估报告、
 * 门禁账本、自检结果），本分区轮询 /anic/api/invocations/live 看的是**正在进行
 * 的调用**（请求瞬间 → 执行中 → 完成/失败），进程内存态、随会话流动。
 *
 * 轮询而非 SSE：宿主 webServer 槽位的 exact 路由没有流式契约，多代兼容下
 * 轮询是唯一全版本可用的通道；2s 间隔对"人眼看模型调用工具"足够实时。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { InvocationsJson, InvocationJson } from './renderInvocationsTypes.ts';

export type { InvocationJson, InvocationsJson } from './renderInvocationsTypes.ts';

// useInvocations 轮询钩子已拆至 ./useInvocations.ts（cycle-41 T3 纪律）；
// 消费方从两处各自 import（WorkflowGraphPanel 用钩子、测试用渲染器）。

/**
 * cycle-41（UI 研究 Top5）：单组渲染截限——环形缓冲满载（200 条）时单组可能
 * 数十条，DOM 行数与视口严重失配。数据不裁（total 如实），渲染截断并给
 * 「+X more」计数行——「显示多少」与「共有多少」分开陈述。
 */
const GROUP_RENDER_CAP = 40;

// cycle-60 T3 拆分：分组/时序纯逻辑（groupByTurn/mostRecentCompletedKey/
// turnTimeRange/turnDensity/turnCompletedAt）迁至 invocationGrouping.ts——
// 「算什么」与「怎么渲」分离。
// cycle-71 T-7131：mostRecentCompletedKey 的唯一消费点（turn 组默认展开）已撤
//——「最近一次已完成调用」上移为独立全貌卡（renderLastCompletedCard），
// 由 LiveInvocationsSection 在列表之前渲染；此处改消费量化纯函数
//（invocationQuant.ts，与分组/时序同域但不同族：分布 vs 组）。
import { groupByTurn, turnTimeRange, turnDensity, turnCompletedAt, inFlightElapsedMs } from './invocationGrouping.ts';
import { p95Of, errorCodeHistogram } from './invocationQuant.ts';

/**
 * in-flight 状态点的脉冲动画：样式本体迁移至 components/statusDot.ts（B4 合并
 * 两份 keyframes），此处 import 后转出保持既有 import 面不变（消费点 :98 的
 * <style> 注入与 invocationsRender.test 的 keyframes 断言不受影响）。
 */
import { LIVE_PULSE_STYLE as LIVE_PULSE_STYLE_SRC } from '../../components/statusDot.ts';
export const LIVE_PULSE_STYLE = LIVE_PULSE_STYLE_SRC;

function statusColor(status: InvocationJson['status']): string {
  // 状态点用图形令牌（≥3:1 双表面），文本用文本令牌（≥4.5:1）。
  if (status === 'done') return token('anic-status-done');
  if (status === 'error') return token('anic-status-failed');
  return token('anic-status-active');
}

function statusText(inv: InvocationJson): string {
  if (inv.status === 'in-flight') return inv.possiblyOrphaned ? t('live.statusOrphaned') : t('live.statusInFlight');
  if (inv.status === 'error') return t('live.statusError');
  return t('live.statusDone');
}

/** 单条调用行（分组/平铺共用；既有 data-anic-* 标记是测试与消费方契约，不改名）。
 *  genMs：本轮 feed 快照时刻（epoch ms，由 renderInvocations 从 data.generatedAt
 *  解析一次传入）——in-flight 已进行时长的基准（T-6401）。 */
function invocationRow(inv: InvocationJson, genMs?: number): ReactElement {
  // T-6401：in-flight 已进行时长（时序脉动量化）——基准用快照时刻而非
  // 客户端时钟（跨机偏移会伪装成耗时，见 invocationGrouping.inFlightElapsedMs
  // 的时钟基准裁决）。整秒向下取整；非法形状静默跳过。
  const elapsedMs = inv.status === 'in-flight' && genMs !== undefined ? inFlightElapsedMs(inv, genMs) : null;
  return createElement(
    'div',
    {
      'data-anic-invocation': inv.callId,
      'data-anic-invocation-status': inv.status,
      key: inv.callId,
      style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, fontFamily: 'ui-monospace, monospace', color: token('anic-text') },
    },
    // 状态点：in-flight 走脉冲动画类（普通类名走 anic-live-dot）。
    createElement('span', {
      'data-anic-invocation-dot': inv.status,
      className: inv.status === 'in-flight' ? 'anic-live-dot' : undefined,
      style: { width: 7, height: 7, borderRadius: '50%', background: statusColor(inv.status), flexShrink: 0, alignSelf: 'center' },
    }),
    createElement('span', { style: { color: token('anic-text-strong') } }, inv.name),
    createElement('span', null, statusText(inv)),
    typeof inv.durationMs === 'number' ? createElement('span', { style: { color: token('anic-text-dim') } }, `${String(inv.durationMs)}ms`) : null,
    elapsedMs !== null
      ? createElement('span', { 'data-anic-invocation-elapsed': 'true', style: { color: token('anic-status-active') } },
          t('live.elapsed', { sec: String(Math.floor(elapsedMs / 1000)) }))
      : null,
    typeof inv.turn === 'number' && typeof inv.step === 'number' ? createElement('span', { style: { color: token('anic-text-faint') } }, `t${String(inv.turn)}/s${String(inv.step)}`) : null,
    createElement('span', { style: { color: token('anic-text-faint'), overflowWrap: 'anywhere' } },
      inv.error ? `${inv.error.name}(${inv.error.code})${inv.error.reason ? `: ${inv.error.reason.slice(0, 120)}` : ''}` : inv.argumentsPreview),
    // T-4801：成功调用的结果预览——「调用返回了什么」与「发了什么参数」
    // 成对呈现（⇒ 前缀 + 弱化色区分方向）。错误态无预览（error 行已足），
    // in-flight 无预览（尚未有返回），旧宿主无字段——三者都自然跳过。
    inv.status === 'done' && inv.resultPreview
      ? createElement('span', { 'data-anic-invocation-result': 'true', style: { color: token('anic-text-dim'), overflowWrap: 'anywhere', flexBasis: '100%' } },
          t('live.resultPreview', { preview: inv.resultPreview }))
      : null,
  );
}

/**
 * T-4702：feed 通道诊断行（视觉弱化、非空时才渲染）。五计数来自宿主
 * invocationFeed 的 FeedDiagnostics——「事件没到（计数 0）」与「到了但被
 * 过滤（计数 > 0 而列表空）」在面板上一眼可辨，不再要求排障者去读路由
 * 原始 JSON。旧宿主无此字段时整行不出现（可选字段，零回归面）。
 */
function feedDiagnosticsLine(data: InvocationsJson): ReactElement | null {
  const d = data.diagnostics;
  if (!d) return null;
  return createElement(
    'div',
    {
      'data-anic-feed-diagnostics': 'true',
      style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 10px 0', fontFamily: 'ui-monospace, monospace' },
    },
    t('live.diagnostics', {
      events: String(d.sessionEvents),
      calls: String(d.sessionToolCalls),
      results: String(d.toolsResults),
      anicCalls: String(d.anicCalls),
      anicResults: String(d.anicResults),
    }),
  );
}

/** 渲染实时调用分区。data 为 null 且无错误 = 尚未轮询到（不伪造空态）。 */
export function renderInvocations(data: InvocationsJson | null, pollError: string | null, autoRefreshOn = true, announce = ''): ReactElement {
  const groups = data === null ? null : groupByTurn(data.invocations);
  // cycle-71 T-7131：量化补全（运行状态量化）——P95 长尾耗时 + 错误码 top3 直方图。
  // 样本门槛（只取终态且 durationMs 合法）在 invocationGrouping 内统一裁决。
  const p95 = data === null ? null : p95Of(data.invocations);
  const errorCodes = data === null ? [] : errorCodeHistogram(data.invocations).slice(0, 3);
  // cycle-41：概览量化（运行中/失败计数进标题行——「共有多少」一眼可读）。
  const running = data === null ? 0 : data.invocations.filter((i) => i.status === 'in-flight').length;
  const errors = data === null ? 0 : data.invocations.filter((i) => i.status === 'error').length;
  // T-6401：feed 快照时刻（与 startedAt 同为宿主进程时钟）——in-flight
  // 已进行时长基准。解析一次全行共用；不可解析（旧宿主/异常形状）→ NaN，
  // inFlightElapsedMs 门槛自然跳过（零伪造）。
  const genMs = data === null ? undefined : Date.parse(data.generatedAt);
  return createElement(
    'div',
    { 'data-anic-invocations': 'section', style: { borderTop: `1px solid ${token('anic-border')}` } },
    createElement('style', null, LIVE_PULSE_STYLE),
    // Top4a 聚合播报区：视觉隐藏（anic-sr-only 类）+ role=status polite。
    // 文本只在 total 增长时变化——AT 每次变化播报一次，不会被轮询淹没。
    announce
      ? createElement('span', { role: 'status', 'aria-live': 'polite', 'data-anic-invocations-announce': announce, className: 'anic-sr-only' }, announce)
      : null,
    createElement(
      'div',
      { style: { fontSize: 10, color: token('anic-text-faint'), padding: '4px 10px 0' } },
      t('live.title'),
      data ? t('live.summary', { total: String(data.total), generatedAt: data.generatedAt }) : t('live.notFetched'),
      data && running > 0 ? t('live.summaryRunning', { count: String(running) }) : '',
      data && errors > 0 ? t('live.summaryErrors', { count: String(errors) }) : '',
      // cycle-71 T-7131：P95 长尾耗时（仅样本充足时——无终态样本时 p95 为 null，
      // 不伪造 0ms；此处「数据在 → 有样本」由路由语义保证，仍以 null 门槛兜底）。
      p95 !== null ? t('live.summaryP95', { ms: String(p95) }) : '',
      // 错误码 top3（次数降序，快照式排序在纯函数内定死——渲染层零重排）。
      errorCodes.length > 0
        ? t('live.summaryErrorCodes', { codes: errorCodes.map((e) => `${e.code}×${String(e.count)}`).join(' ') })
        : '',
      pollError ? t('live.pollFailed', { error: pollError }) : '',
    ),
    // 三态分支：null（尚未轮询到）≠ 空流（确实没有调用）≠ 有数据。
    // null 显示"等首轮轮询"而不是空态引导——把"还没拿到"伪装成"没有调用"
    // 与静态分区的"未加载 ≠ 不可用"是同一纪律。
    data === null
      ? createElement('div', { 'data-anic-invocations-pending': 'true', style: { fontSize: 11, color: token('anic-text-faint'), padding: '4px 10px' } },
          t('live.pending'))
      : data.invocations.length === 0
        ? createElement('div', { 'data-anic-invocations-empty': 'true', style: { fontSize: 11, color: token('anic-text-faint'), padding: '4px 10px' } },
            t('live.empty'),
            // 空态最需要诊断：区分「事件没到」vs「到了被过滤」。
            feedDiagnosticsLine(data))
        : createElement(
            'div',
            { 'data-anic-invocation-list': 'true', style: { padding: '4px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 } },
            // T-4702：有数据时诊断行也保留（通道活性的持续可见——计数停止
            // 增长即事件断流，比「列表不动」更早暴露问题）。
            feedDiagnosticsLine(data),
            // autoRefresh 关闭时在分区顶部如实告知（INV-30 关闭形态可观测），
            // 并指路手动刷新——否则用户看到"永远不动"的列表会误以为没有调用。
            autoRefreshOn
              ? null
              : createElement('div', { 'data-anic-invocations-autorefresh-off': 'true', style: { fontSize: 10, color: token('anic-warn-text'), paddingBottom: 2 } }, t('live.pollOff')),
            groups === null
              // 平铺模式（零 turn 元数据）：与分组改造前逐字节同构——既有断言面。
              ? data.invocations.map((inv) => invocationRow(inv, genMs))
              // 分组模式：details 折叠。cycle-71 T-7131（用户要求核心）：turn 组默认
              // 展开只剩**运行中**一个条件——「最近一次已完成调用」已上移为
              // 分区顶部的独立全貌卡（LiveInvocationsSection 内、本渲染器之前），
              // 同一调用不再在两处重复展开。历史组一律折叠收纳（组内摘要有计数）。
              : groups.map((g) => {
                  const gRunning = g.items.some((inv) => inv.status === 'in-flight');
                  const open = gRunning;
                  return createElement(
                    'details',
                    {
                      'data-anic-turn-group': g.turn === null ? 'ungrouped' : `t${String(g.turn)}`,
                      // 运行中/最近完成的组留标记：折叠收纳后仍可一眼定位。
                      'data-anic-turn-group-open-default': open ? 'true' : 'false',
                      open,
                      key: g.turn === null ? 'ungrouped' : `t${String(g.turn)}`,
                      style: { borderTop: `1px dashed ${token('anic-border')}`, paddingTop: 2 },
                    },
                    createElement('summary', { style: { fontSize: 10, color: token('anic-text-faint'), cursor: 'pointer', userSelect: 'none' } },
                      g.turn === null ? t('live.ungrouped', { count: String(g.items.length) }) : t('live.turnGroup', { turn: String(g.turn), count: String(g.items.length) }),
                      // T-6001：组内时间范围（绝对时序白盒）——「这组发生在几点、
                      // 持续多久」与步进坐标互补；无合法时间戳时静默跳过。
                      turnTimeRange(g.items),
                      // T-6301：组内调用密度（次/分钟）——「这组多快」；跨度 0 或
                      // 无合法时间戳时静默跳过（除零不是「无穷密」的诚实陈述）。
                      turnDensity(g.items),
                      // T-6302：组完成时刻（endedAt 产出落定语义——与时间范围
                      // 的 startedAt 边界语义互补两键两文案）；组内含 in-flight
                      // 或 endedAt 缺失时静默跳过（组还没完不伪造完成时刻）。
                      turnCompletedAt(g.items),
                      gRunning ? createElement('span', { style: { color: token('anic-status-active'), marginLeft: 6 } }, t('live.groupRunningSuffix', { count: String(g.items.filter((i) => i.status === 'in-flight').length) })) : null),
                    // Top5 截限：渲染前 GROUP_RENDER_CAP 条，其余以计数行收纳。
                    ...g.items.slice(0, GROUP_RENDER_CAP).map((inv) => invocationRow(inv, genMs)),
                    g.items.length > GROUP_RENDER_CAP
                      ? createElement('div', { 'data-anic-invocation-truncated': 'true', style: { fontSize: 10, color: token('anic-text-faint'), padding: '2px 0' } },
                          t('live.groupTruncated', { hidden: String(g.items.length - GROUP_RENDER_CAP), total: String(g.items.length) }))
                      : null,
                  );
                }),
          ),
  );
}
