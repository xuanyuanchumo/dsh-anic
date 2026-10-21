/**
 * useInvocations 轮询钩子（从 renderInvocations.ts 拆出，cycle-41 T3 纪律）。
 *
 * 数据面语义见 renderInvocations.ts 头注释（轮询而非 SSE、2s 实时性依据）；
 * 本文件只承载钩子本体：data/pollError/announce 三态回流。
 */
import { useRef, useState } from 'react';
import { t } from '../../i18n.ts';
import { usePanelFetch } from '../../components/usePanelFetch.ts';
import { isObjectLike } from './fetchJson.ts';
import type { InvocationsJson } from './renderInvocations.ts';

const LIVE_URL = '/anic/api/invocations/live';

/**
 * 轮询钩子：默认 2s 拉一次实时调用流；pollMs<=0 时只拉一轮不排定时器
 * （flow.autoRefresh 关闭时的降级形态——手动刷新经 manualKey 触发重拉）。
 *
 * 失败语义（如实呈现，不静默）：路由 5xx/网络失败 → pollError 置位并**保留
 * 上次数据**（面板同时显示"轮询失败"与陈旧数据的 generatedAt——用户能分辨
 * "没有调用"和"拉不到"）。无 fetch（smoke 沙盒）→ 一次都不拉。
 *
 * cycle-41（UI 研究 Top4a）：announce 聚合播报——列表本体绝不进 live region
 * （APG：自动更新内容禁用 live region——2s 轮询会把屏幕阅读器淹没）；改为
 * 独立的视觉隐藏 polite 区，只在 total 增长时更新一次文本「新增 N 个调用」。
 * 已知局限：环形缓冲满载后 total 封顶，驱逐替换不再产生增量（此时组内首条
 * callId 变化是更好信号，留作后续增强——注释钉死防遗忘）。
 */
export function useInvocations(pollMs = 2000, manualKey = 0, getHeaders?: () => Record<string, string>): { data: InvocationsJson | null; pollError: string | null; announce: string } {
  const [data, setData] = useState<InvocationsJson | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const lastTotalRef = useRef(0);

  usePanelFetch(
    [{
      url: LIVE_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { invocations?: unknown }).invocations),
      apply: (v) => {
        const nv = v as InvocationsJson;
        const delta = nv.total - lastTotalRef.current;
        if (lastTotalRef.current > 0 && delta > 0) setAnnounce(t('live.newCalls', { count: String(delta) }));
        lastTotalRef.current = nv.total;
        setData(nv);
      },
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

  return { data, pollError, announce };
}
