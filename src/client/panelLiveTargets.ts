/**
 * 面板一次性拉取任务的 target 工厂（B4 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * 快照/步骤流程/自检三个「挂载 + 手动刷新」任务，与轮询任务共享
 * components/usePanelFetch 的防抖/降级/学头机制；本文件只保留**各域特有**的
 * 部分：成功文案、三分类降级文案（与历史 fetchLive 逐字一致——回归红线）、
 * 快照任务的 X-ANIC-Workspace 学头副作用。
 *
 * cycle-46（T-4601 写侧收口）：PanelLiveSetters 的六个 store 写通道（setData/
 * setFetchLine/setTrace/setTraceLine/setCheck/setCheckLine）收窄为**动作层
 * 引用**——setGraph/setFetchLine/setTrace/setCheck 四个具名动作（setTraceLine/
 * setCheckLine 不再独立存在，行文案与数据经 setTrace(v,line)/setCheck(v,line)
 * 两切片一次写）；workspace 学头两通道保留（它们写 ref 而非 store，不属于
 * 动作层管辖）。snapshot 域 onFail 的三分类降级路径与 fetchLive 历史文案
 * 逐字对齐的回归红线由 tests/unit/panelLiveTargets 行为契约与全量回归钉住。
 */
import { t } from './i18n.ts';
import { isObjectLike } from './features/live/fetchJson.ts';
import { syncTelemetryCounts } from './features/live/fetchJson.ts';
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import type { GraphData } from './features/graph/renderGraph.ts';
import type { StepTraceJson } from './features/stepTrace/renderStepTrace.ts';
import type { SelfCheckJson } from './features/diagnostics/renderDiagnostics.ts';
import type { FetchLineView, PanelActions } from './components/panelActions.ts';

export const SNAPSHOT_URL = '/anic/api/workflow-snapshot';
export const STEP_TRACE_URL = '/anic/api/step-trace';
export const SELF_CHECK_URL = '/anic/api/self-check';
export const ORG_STATUS_URL = '/anic/org-status';
export const FLOWS_STATUS_URL = '/anic/flows/status';

/**
 * 一次性任务的写侧依赖集（动作子集 + 工作区学头两 ref 通道）。
 *
 * cycle-45（T-4502a）：setFetchLine 复合更新走函数式补丁（updater 收原子快照）；
 * cycle-46（T-4601）：六个 setter 通道收窄为四个动作引用——setGraph/
 * setFetchLine/setTrace/setCheck（行文案合并进数据动作，两切片一次写）。
 */
export interface PanelLiveSetters {
  /** 快照数据落地（= actions.setGraph）。 */
  setData: PanelActions['setGraph'];
  /** 复合写：读当前 source/line 原子快照计算新行（malformed 降级保 source 等）。 */
  setFetchLine: (updater: (view: FetchLineView) => FetchLineView) => void;
  /** 步骤流程：数据与行文案两切片一次写（= actions.setTrace）。 */
  setTrace: (v: StepTraceJson | null, line: string) => void;
  /** 自检：数据与行文案两切片一次写（= actions.setCheck）。 */
  setCheck: (v: SelfCheckJson | null, line: string) => void;
  /** 学得的工作区根写回（ref.current 赋值——非 store 写路径，留在接口）。 */
  learnWorkspace: (root: string) => void;
  /** 当前已学得的工作区根（null = 未学得，学头只在首得时生效）。 */
  workspaceKnown: () => string | null;
}

/**
 * 三个一次性 target（pollMs=0 形态由调用方决定）。
 * 降级文案分类与原 fetchLive 逐字对齐：http → 路由不可用/构建期快照(route)、
 * malformed → 响应畸形、network → 拉取失败。
 */
export function panelLiveTargets(s: PanelLiveSetters): PanelFetchTarget[] {
  return [
    {
      url: SNAPSHOT_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { nodes?: unknown }).nodes) && Array.isArray((v as { edges?: unknown }).edges),
      apply: (v) => {
        const json = v as GraphData & { generatedAt?: string; counts?: { nodes: number; edges: number } };
        s.setData({ nodes: json.nodes, edges: json.edges });
        syncTelemetryCounts(json.nodes.length, json.edges.length);
        const c = json.counts;
        s.setFetchLine(() => ({ source: 'live', line: t('panel.sourceLive', { generatedAt: json.generatedAt ?? '', nodes: String(c?.nodes ?? json.nodes.length), edges: String(c?.edges ?? json.edges.length) }) }));
      },
      onFail: (f) => {
        if (f.kind === 'http') s.setFetchLine(() => ({ source: 'embedded', line: t('panel.sourceEmbeddedWithRoute', { status: String(f.status) }) }));
        else if (f.kind === 'malformed') s.setFetchLine((prev) => ({ source: prev.source, line: t('panel.sourceMalformed') }));
        else s.setFetchLine(() => ({ source: 'embedded', line: t('panel.sourceEmbeddedFetchFailed', { error: f.message }) }));
      },
      onResponse: (res) => {
        // 学得工作区根（encodeURIComponent 形式）：后续请求回带（面板 wsHeaders）。
        const learned = (res as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('X-ANIC-Workspace');
        if (learned && s.workspaceKnown() === null) {
          try { s.learnWorkspace(decodeURIComponent(learned)); } catch { s.learnWorkspace(learned); }
        }
      },
    },
    {
      url: STEP_TRACE_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { steps?: unknown }).steps),
      apply: (v) => {
        const json = v as StepTraceJson;
        s.setTrace(json, t('panel.traceLine', { steps: String(json.steps.length), generatedAt: json.generatedAt }));
      },
      onFail: (f) => {
        const line = f.kind === 'http'
          ? t('panel.routeUnavailable', { status: String(f.status) })
          : f.kind === 'malformed'
            ? t('panel.malformedNotUsed')
            : t('panel.fetchFailedWith', { error: f.message });
        s.setTrace(null, line);
      },
    },
    {
      url: SELF_CHECK_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { checks?: unknown }).checks),
      apply: (v) => {
        const json = v as SelfCheckJson;
        s.setCheck(json, json.allOk ? t('panel.allOk') : t('panel.someFailed'));
      },
      onFail: (f) => {
        const line = f.kind === 'http'
          ? t('panel.routeUnavailable', { status: String(f.status) })
          : f.kind === 'malformed'
            ? t('panel.malformedNotUsed')
            : t('panel.fetchFailedWith', { error: f.message });
        s.setCheck(null, line);
      },
    },
  ];
}
