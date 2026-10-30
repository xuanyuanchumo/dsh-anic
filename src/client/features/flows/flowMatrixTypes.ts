/**
 * 流程矩阵的**客户端契约**（cycle-89）—— `GET /anic/api/flows/matrix` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级（响应字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import `src/host/flows/flowMatrixView.ts` 的类型，
 * 一次宿主字段改名就会让旧客户端整块崩掉（且打包时是类型擦除，编译期看不出来）。
 *
 * ⇒ 这里**手工声明可能缺字段**的形状，守卫只做最小准入，渲染层对每个字段单独降级。
 *
 * ## 字段全可选的理由
 *
 * 宿主侧可能先部署旧版（没有 metrics）或后部署新版（多字段）。
 * 客户端对**缺字段**必须能降级显示，而不是整块失败 ——
 * 「取不到」与「没有数据」在面板上必须可区分（前者是故障，后者是事实）。
 */

/** 门禁证据行（哪道门有流证据）。 */
export interface FlowGateEvidenceJson {
  gate?: string;
  evidence?: boolean;
  flows?: number;
}

/** 量化指标。 */
export interface FlowMetricsJson {
  total?: number;
  attributed?: number;
  /** 0-1；total 为 0 时宿主落 0（不是 NaN）。 */
  attributionRate?: number;
  byCycle?: Record<string, number>;
  byPhase?: Record<string, number>;
  byGate?: Record<string, number>;
  orphans?: number;
  gateEvidence?: FlowGateEvidenceJson[];
  unGatedCycles?: string[];
}

/** 单条记录摘要。 */
export interface FlowSummaryJson {
  flowId?: string;
  script?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number;
  cycle?: string;
  phase?: string;
  gate?: string;
}

/** 分组摘要。 */
export interface FlowGroupJson {
  key?: string;
  total?: number;
  done?: number;
  failed?: number;
  timeout?: number;
  active?: number;
  scripts?: Record<string, number>;
  flows?: FlowSummaryJson[];
}

/** `GET /anic/api/flows/matrix` 的响应。 */
export interface FlowMatrixJson {
  workspace?: string | null;
  total?: number;
  metrics?: FlowMetricsJson;
  byCycle?: FlowGroupJson[];
  byPhase?: FlowGroupJson[];
  byGate?: FlowGroupJson[];
  orphans?: FlowSummaryJson[];
}

/** 归属矩阵端点（`GET /anic/api/flows/matrix`）。 */
export const FLOW_MATRIX_URL = '/anic/api/flows/matrix';

/** 对象形（与 `features/live/fetchJson.isObjectLike` 同判据，独立实现避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「能取到 metrics 对象」。
 *
 * 刻意**不**校验全部字段 —— 任何新增/缺失字段都不该让整块面板走失败行。
 */
export function isFlowMatrix(v: unknown): v is FlowMatrixJson {
  if (!isObj(v)) return false;
  return isObj(v['metrics']) || Array.isArray(v['byCycle']);
}

/**
 * 门禁脚本白名单 —— 只有这些脚本**本身在执行门禁**才算「有门禁证据」。
 *
 * ## 为什么不能只看「gate 字段存在」
 *
 * 归属机制修好之前，`gate` 字段取自**账本链头**（上次跑过的门禁），
 * 于是任意流程都会被打上门禁标签 —— 「门禁证据覆盖」指标因此**永久假绿**。
 * 宿主侧已改为按脚本语义判定，但客户端仍要守一道：
 * 一条 `gate:'G3'` 但 script 是 `workflow-state` 的记录，**不得**计入 G3 证据。
 *
 * 与 host 侧的 `gateOfScript` 是**同一份白名单的两个实现**
 * （client 不能 import host），测试用同一批向量对账。
 */
export const GATE_EVIDENCE_SCRIPTS: readonly string[] = ['gate-check', 'hitl-audit'];

/** 该脚本是否算门禁证据源。 */
export function isGateEvidenceScript(script: string | undefined): boolean {
  if (typeof script !== 'string' || script === '') return false;
  return GATE_EVIDENCE_SCRIPTS.includes(script);
}

/** 从分组里筛出**真正**的门禁证据记录（白名单判据）。 */
export function gateEvidenceFlows(group: FlowGroupJson | undefined): FlowSummaryJson[] {
  if (!isObj(group)) return [];
  const flows = Array.isArray(group['flows']) ? (group['flows'] as FlowSummaryJson[]) : [];
  return flows.filter((f) => isGateEvidenceScript(f?.script));
}

/** 归属率（0-1；缺字段 → null，**不**落 0 —— 0 与「取不到」必须可区分）。 */
export function attributionRateOf(v: FlowMatrixJson): number | null {
  const rate = v.metrics?.attributionRate;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
}

/** 孤儿数（缺字段 → null）。 */
export function orphanCountOf(v: FlowMatrixJson): number | null {
  const n = v.metrics?.orphans;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 六相分布（按固定相序；缺字段的相不补 0 —— 「没有记录」≠「计数为 0」）。 */
export const PHASE_ORDER: readonly string[] = ['plan', 'design', 'build', 'test', 'deploy', 'maintain'];

/** 六相计数（phase → 条数；只列有记录的相）。 */
export function phaseCountsOf(v: FlowMatrixJson): Array<{ phase: string; count: number }> {
  const byPhase = v.metrics?.byPhase;
  if (!isObj(byPhase)) return [];
  const out: Array<{ phase: string; count: number }> = [];
  for (const phase of PHASE_ORDER) {
    const n = byPhase[phase];
    if (typeof n === 'number' && n > 0) out.push({ phase, count: n });
  }
  return out;
}

/** 有流证据的门禁列表（按宿主给的 gateEvidence 顺序，附**校正后**的条数）。 */
export function gateCoverageOf(v: FlowMatrixJson): Array<{ gate: string; flows: number }> {
  const groups = Array.isArray(v.byGate) ? v.byGate : [];
  const out: Array<{ gate: string; flows: number }> = [];
  for (const g of groups) {
    if (!isObj(g)) continue;
    const gate = typeof g['key'] === 'string' ? g['key'] : '';
    if (gate === '') continue;
    // **白名单校正**：只有门禁脚本的记录算证据。
    const evidence = gateEvidenceFlows(g);
    if (evidence.length === 0) continue;
    out.push({ gate, flows: evidence.length });
  }
  return out;
}
