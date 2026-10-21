/**
 * useInvocations 轮询钩子（从 renderInvocations.ts 拆出，cycle-41 T3 纪律）。
 *
 * 数据面语义见 renderInvocations.ts 头注释（轮询而非 SSE、2s 实时性依据）；
 * cycle-42（Top2）：data/pollError/announce 三态不再走本组件 useState，改写入
 * 面板外部 store（panelState 三切片）——2s tick 的重渲范围从「根组件全树」
 * 收敛到「LiveInvocationsSection 订阅者」。钩子返回 void。
 *
 * cycle-46（T-4601 写侧收口）：apply/onFail/onRecover 的写路径全部改走
 * panelActions 动作层——announce 回读不变量与三分类降级文案从钩子内联逻辑
 * 收拢为 bindPanelActions 的具名动作（applyInvocations/failInvocations/
 * recoverInvocations），本钩子只保留轮询编排与 lastTotalRef 增量判断。
 */
import { useRef } from 'react';
import { t } from '../../i18n.ts';
import { usePanelFetch } from '../../components/usePanelFetch.ts';
import { bindPanelActions } from '../../components/panelActions.ts';
import { isObjectLike } from './fetchJson.ts';
import type { InvocationsJson } from './renderInvocations.ts';
import type { PanelDataStore } from '../../panelState.ts';

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
 *
 * cycle-42：announce 无增量时保留旧值（回读语义——全等补丁不触发通知）。
 */
export function useInvocations(store: PanelDataStore, pollMs = 2000, manualKey = 0, getHeaders?: () => Record<string, string>): void {
  const lastTotalRef = useRef(0);
  // 动作层实例：绑 store 的具名写路径（applyInvocations 内含 announce 回读）。
  const actions = bindPanelActions(store);

  usePanelFetch(
    [{
      url: LIVE_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { invocations?: unknown }).invocations),
      apply: (v) => {
        const nv = v as InvocationsJson;
        const delta = nv.total - lastTotalRef.current;
        const hasDelta = lastTotalRef.current > 0 && delta > 0;
        lastTotalRef.current = nv.total;
        // T-4601：写路径收口进动作层（announce 回读不变量在 applyInvocations 内）。
        actions.applyInvocations(nv, t('live.newCalls', { count: String(delta) }), hasDelta);
      },
      onFail: (f) => { actions.failInvocations(f); },
      onRecover: () => { actions.recoverInvocations(); },
    }],
    pollMs,
    manualKey,
    () => ({ Accept: 'application/json', ...(getHeaders?.() ?? {}) }),
  );
}
