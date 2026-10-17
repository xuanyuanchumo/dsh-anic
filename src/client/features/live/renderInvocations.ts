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
import { createElement, useState, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { usePanelFetch } from '../../components/usePanelFetch.ts';
import { isObjectLike } from './fetchJson.ts';

/** 与宿主 InvocationRecord 对齐的最小客户端形状。 */
export interface InvocationJson {
  callId: string;
  name: string;
  argumentsPreview: string;
  turn?: number;
  step?: number;
  startedAt: number;
  endedAt?: number;
  status: 'in-flight' | 'done' | 'error';
  error?: { name: string; code: string; reason?: string };
  durationMs?: number;
  possiblyOrphaned?: boolean;
}

export interface InvocationsJson {
  invocations: InvocationJson[];
  total: number;
  generatedAt: string;
}

const LIVE_URL = '/anic/api/invocations/live';

/**
 * in-flight 状态点的脉冲动画：样式本体迁移至 components/statusDot.ts（B4 合并
 * 两份 keyframes），此处 import 后转出保持既有 import 面不变（消费点 :98 的
 * <style> 注入与 invocationsRender.test 的 keyframes 断言不受影响）。
 */
import { LIVE_PULSE_STYLE as LIVE_PULSE_STYLE_SRC } from '../../components/statusDot.ts';
export const LIVE_PULSE_STYLE = LIVE_PULSE_STYLE_SRC;

/**
 * 轮询钩子：默认 2s 拉一次实时调用流；pollMs<=0 时只拉一轮不排定时器
 * （flow.autoRefresh 关闭时的降级形态——手动刷新经 manualKey 触发重拉）。
 *
 * 失败语义（如实呈现，不静默）：路由 5xx/网络失败 → pollError 置位并**保留
 * 上次数据**（面板同时显示"轮询失败"与陈旧数据的 generatedAt——用户能分辨
 * "没有调用"和"拉不到"）。无 fetch（smoke 沙盒）→ 一次都不拉。
 *
 * B4：轮询/暂停/降级/防抖机制统一至 components/usePanelFetch；本函数只保留
 * 本域特有部分——pollError 文案映射（http/malformed → locale 键，network →
 * 原始 message）与「失败保留旧数据」的应用层语义（setData 不清空）。
 */
export function useInvocations(pollMs = 2000, manualKey = 0, getHeaders?: () => Record<string, string>): { data: InvocationsJson | null; pollError: string | null } {
  const [data, setData] = useState<InvocationsJson | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  usePanelFetch(
    [{
      url: LIVE_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { invocations?: unknown }).invocations),
      apply: (v) => { setData(v as InvocationsJson); },
      onFail: (f) => {
        if (f.kind === 'http') setPollError(t('panel.routeUnavailable', { status: String(f.status) }));
        else if (f.kind === 'malformed') setPollError(t('panel.malformedNotUsed'));
        else setPollError(f.message);
      },
      onRecover: () => { setPollError(null); },
    }],
    pollMs,
    manualKey,
    () => ({ Accept: 'application/json', ...(getHeaders?.() ?? {}) }),
  );

  return { data, pollError };
}

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

/** 渲染实时调用分区。data 为 null 且无错误 = 尚未轮询到（不伪造空态）。 */
export function renderInvocations(data: InvocationsJson | null, pollError: string | null, autoRefreshOn = true): ReactElement {
  return createElement(
    'div',
    { 'data-anic-invocations': 'section', style: { borderTop: `1px solid ${token('anic-border')}` } },
    createElement('style', null, LIVE_PULSE_STYLE),
    createElement(
      'div',
      { style: { fontSize: 10, color: token('anic-text-faint'), padding: '4px 10px 0' } },
      t('live.title'),
      data ? t('live.summary', { total: String(data.total), generatedAt: data.generatedAt }) : t('live.notFetched'),
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
            t('live.empty'))
        : createElement(
            'div',
            { 'data-anic-invocation-list': 'true', style: { padding: '4px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 } },
            // autoRefresh 关闭时在分区顶部如实告知（INV-30 关闭形态可观测），
            // 并指路手动刷新——否则用户看到"永远不动"的列表会误以为没有调用。
            autoRefreshOn
              ? null
              : createElement('div', { 'data-anic-invocations-autorefresh-off': 'true', style: { fontSize: 10, color: token('anic-warn-text'), paddingBottom: 2 } }, t('live.pollOff')),
            ...data.invocations.map((inv) => createElement(
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
              typeof inv.turn === 'number' && typeof inv.step === 'number' ? createElement('span', { style: { color: token('anic-text-faint') } }, `t${String(inv.turn)}/s${String(inv.step)}`) : null,
              createElement('span', { style: { color: token('anic-text-faint'), overflowWrap: 'anywhere' } },
                inv.error ? `${inv.error.name}(${inv.error.code})${inv.error.reason ? `: ${inv.error.reason.slice(0, 120)}` : ''}` : inv.argumentsPreview),
            )),
          ),
  );
}
