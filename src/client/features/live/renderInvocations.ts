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
import { createElement, useEffect, useRef, useState, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

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

/** in-flight 状态点的脉冲动画（prefers-reduced-motion 逃逸，与 FAIL_PULSE_STYLE 同纪律）。 */
const LIVE_PULSE_STYLE = `@keyframes anic-live-pulse{0%,100%{opacity:1}50%{opacity:.35}}.anic-live-dot{animation:anic-live-pulse 1.2s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.anic-live-dot{animation:none}}`;

/**
 * 轮询钩子：默认 2s 拉一次实时调用流；pollMs<=0 时只拉一轮不排定时器
 * （flow.autoRefresh 关闭时的降级形态——手动刷新经 manualKey 触发重拉）。
 *
 * 失败语义（如实呈现，不静默）：路由 5xx/网络失败 → pollError 置位并**保留
 * 上次数据**（面板同时显示"轮询失败"与陈旧数据的 generatedAt——用户能分辨
 * "没有调用"和"拉不到"）。无 fetch（smoke 沙盒）→ 一次都不拉。
 * getHeaders 为**取头函数**（非对象）：每次 tick 现取，调用方可读 ref 而
 * 不引起本 effect 重跑（对象入依赖数组会因引用不等而逐渲染重轮询）。
 */
export function useInvocations(pollMs = 2000, manualKey = 0, getHeaders?: () => Record<string, string>): { data: InvocationsJson | null; pollError: string | null } {
  const [data, setData] = useState<InvocationsJson | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const getHeadersRef = useRef(getHeaders);
  getHeadersRef.current = getHeaders;

  useEffect(() => {
    aliveRef.current = true;
    if (typeof fetch !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const extra = getHeadersRef.current?.() ?? {};
        const res = await fetch(LIVE_URL, { headers: { Accept: 'application/json', ...extra } });
        if (!res.ok) { setPollError(t('panel.routeUnavailable', { status: String(res.status) })); }
        else {
          const json = (await res.json()) as InvocationsJson;
          // 形状校验：invocations 非数组视为畸形，不采用（与面板其他分区同纪律）。
          if (!Array.isArray(json.invocations)) { setPollError(t('panel.malformedNotUsed')); }
          else { if (aliveRef.current) { setData(json); setPollError(null); } }
        }
      } catch (e) { if (aliveRef.current) setPollError(e instanceof Error ? e.message : String(e)); }
      // pollMs<=0：不排下一轮（autoRefresh 关闭形态）；数据行的 generatedAt
      // 让"最后已知数据"的陈旧性可观测（INV-30 关闭形态可观测的落点之一）。
      finally { if (aliveRef.current && pollMs > 0) timer = setTimeout(() => { void tick(); }, pollMs); }
    };
    void tick();
    return () => { aliveRef.current = false; if (timer) clearTimeout(timer); };
  }, [pollMs, manualKey]);

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
