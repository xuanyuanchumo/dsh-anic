/**
 * 面板一次性拉取任务的 target 工厂（B4 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * 快照/步骤流程/自检三个「挂载 + 手动刷新」任务，与轮询任务共享
 * components/usePanelFetch 的防抖/降级/学头机制；本文件只保留**各域特有**的
 * 部分：成功文案、三分类降级文案（与历史 fetchLive 逐字一致——回归红线）、
 * 快照任务的 X-ANIC-Workspace 学头副作用。
 */
import { t } from './i18n.ts';
import { isObjectLike } from './features/live/fetchJson.ts';
import { syncTelemetryCounts } from './features/live/fetchJson.ts';
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import type { GraphData } from './features/graph/renderGraph.ts';
import type { StepTraceJson } from './features/stepTrace/renderStepTrace.ts';
import type { SelfCheckJson } from './features/diagnostics/renderDiagnostics.ts';

export const SNAPSHOT_URL = '/anic/api/workflow-snapshot';
export const STEP_TRACE_URL = '/anic/api/step-trace';
export const SELF_CHECK_URL = '/anic/api/self-check';
export const ORG_STATUS_URL = '/anic/org-status';
export const FLOWS_STATUS_URL = '/anic/flows/status';

/** 面板数据 state 的 setter 集（组件 useState 的下传；类型而非实现）。
 *
 * cycle-45（T-4502a）：setFetchState 拆成两个顶层切片写通道——line 单值直写、
 * source 与 line 的复合更新走函数式补丁（panelStore setState updater 语义）。
 * 全等补丁（同 source+同 line）零通知——原嵌套对象每次新建的恒通知失效点收口。
 */
export interface PanelLiveSetters {
  setData: (d: GraphData) => void;
  /** 复合写：读当前 source/line 原子快照计算新行（malformed 降级保 source 等）。 */
  setFetchLine: (updater: (s: { source: 'embedded' | 'live'; line: string }) => { source: 'embedded' | 'live'; line: string }) => void;
  setTrace: (v: StepTraceJson | null) => void;
  setTraceLine: (v: string) => void;
  setCheck: (v: SelfCheckJson | null) => void;
  setCheckLine: (v: string) => void;
  /** 学得的工作区根写回（ref.current 赋值）。 */
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
        s.setTrace(json); s.setTraceLine(t('panel.traceLine', { steps: String(json.steps.length), generatedAt: json.generatedAt }));
      },
      onFail: (f) => {
        s.setTrace(null);
        if (f.kind === 'http') s.setTraceLine(t('panel.routeUnavailable', { status: String(f.status) }));
        else if (f.kind === 'malformed') s.setTraceLine(t('panel.malformedNotUsed'));
        else s.setTraceLine(t('panel.fetchFailedWith', { error: f.message }));
      },
    },
    {
      url: SELF_CHECK_URL,
      guard: (v) => isObjectLike(v) && Array.isArray((v as { checks?: unknown }).checks),
      apply: (v) => {
        const json = v as SelfCheckJson;
        s.setCheck(json); s.setCheckLine(json.allOk ? t('panel.allOk') : t('panel.someFailed'));
      },
      onFail: (f) => {
        s.setCheck(null);
        if (f.kind === 'http') s.setCheckLine(t('panel.routeUnavailable', { status: String(f.status) }));
        else if (f.kind === 'malformed') s.setCheckLine(t('panel.malformedNotUsed'));
        else s.setCheckLine(t('panel.fetchFailedWith', { error: f.message }));
      },
    },
  ];
}
