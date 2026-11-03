/**
 * FlowTracker 有界视图的**客户端契约**（cycle-101）—— `GET /anic/api/flows/view` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级与客户端构建产物是**两条独立发版链**。
 * 客户端若 import `src/host/flowTrackerProjection.ts` 的类型，一次宿主字段
 * 改名就会让旧客户端整块崩掉（打包时类型擦除，编译期看不出来）。
 * ⇒ 手工声明可能缺字段的形状，守卫只做最小准入（与 lifecycleTypes 同纪律）。
 *
 * ## 诚实渲染纪律
 *
 * 1. **取不到 ≠ 零**：view 为 null 时读数条整条不渲染（不画空壳、不显示 0）。
 * 2. **被裁必显**：dropped > 0 时必须上屏 —— 读者要知道「我看的是窗口不是全部」。
 * 3. **floor 常驻**：有裁切就显示水位（裁到哪一刻），否则「最近 N 条」没有锚点。
 */

/** 视图条目（与 Host FlowHeadEntry 对齐；缺字段容忍）。 */
export interface FlowHeadEntryJson {
  flowId: string;
  script: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  cycle: string | null;
  phase: string | null;
  gate: string | null;
}

/** 脚本统计读数。 */
export interface FlowScriptStatJson {
  total: number;
  done: number;
  failed: number;
  timeout: number;
  successRate: number;
}

/** 有界视图主体。 */
export interface FlowViewJson {
  stateVersion: number;
  totalEver: number;
  totalRecords: number;
  kept: number;
  dropped: number;
  floorStartedAt: string | null;
  head: FlowHeadEntryJson[];
  stats: Record<string, FlowScriptStatJson>;
}

/** 状态分布读数。 */
export interface FlowDistributionJson {
  byStatus: Record<string, number>;
  failureRate: number;
  avgDurationMs: number;
}

/** GET /anic/api/flows/view 的完整响应。 */
export interface FlowsViewResponseJson {
  view: FlowViewJson;
  distribution: FlowDistributionJson;
  marker: string;
}

/** 端点 URL（面板周期抓取用）。 */
export const FLOWS_VIEW_URL = '/anic/api/flows/view?limit=50';

/**
 * 最小准入守卫：只校验读数条渲染**必需**的字段。
 * 缺 view/distribution 视为不合法（宁可整条不渲染，也不画半截数字）。
 */
export function isFlowsViewResponse(v: unknown): v is FlowsViewResponseJson {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const view = o['view'];
  const dist = o['distribution'];
  if (!view || typeof view !== 'object') return false;
  if (!dist || typeof dist !== 'object') return false;
  const vv = view as Record<string, unknown>;
  return typeof vv['totalEver'] === 'number' && typeof vv['kept'] === 'number';
}
