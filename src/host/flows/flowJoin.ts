/**
 * 流程 ↔ 循环/相位/门禁 join key 与量化覆盖率（cycle-89 WP-D）。
 *
 * 缺口（上轮评审原文）：「白盒四元组『流程流向/运行产物』两元仍缺——调用与
 * cycle/phase/门禁零 join key」。也就是说 `flow-tracker.json` 里的每条 FlowRecord
 * 知道自己「跑了哪个脚本、成功与否」，却不知道自己「属于哪个循环、哪个宏观相、
 * 哪道门禁」——于是面板只能把调用和流程并排放着，无法下钻。
 *
 * ## 为什么是「聚合纯函数」而不是在路由里现算
 *
 * 聚合规则（排序、去重、孤儿判定、门禁证据判定）是**判据**，一旦散落在路由里，
 * 面板、状态工具、契约测试就会各算一套，出现「同一条记录在两个视图里归属不同」。
 * 所以本模块只做三件事，全部零 IO、零 clock、零 random，可独立单测：
 *   1. 把记录按 cycle / phase / gate 三个维度分组（joinFlows）；
 *   2. 给出可被面板直接显示的量化指标（coverageMetrics）；
 *   3. 工作区归一 + 过滤（filterByWorkspace），防止多项目串味。
 *
 * ## 降级纪律（宁缺勿猜，INV-27 同族）
 *
 * `attribution.source === 'none'`（或旧记录压根没有 attribution 字段）就是**孤儿**：
 * 它照实计入 orphans，绝不按 startedAt 去「猜」当时的 cycle、也绝不拿
 * `.cycles/workflow-state.json` 的**现值**回填历史记录——那是把「看的时候的坐标」
 * 钉到「发生时的记录」上，是最坏的伪造。
 *
 * 由此推出严格口径：**字段不能自证归属，只有 source 能**。一条只有 `cycle` 却
 * 没有 `attribution` 的记录仍算孤儿。gate 维度另有一道白名单闸
 * （见 flowGateSemantics.ts）：字段存在 ≠ 有门禁证据。
 *
 * ## 边界
 *
 * - 不读盘、不写盘、不排序副作用（返回新数组）；
 * - 不依赖 locale/、不依赖宿主包：纯类型 + 纯函数，host/client 皆可安全引用。
 */
import type { FlowRecord } from '../runtime/flowTracker.ts';
import { isGateEvidence } from './flowGateSemantics.ts';

/** 归属来源：只有这三态，`none` 代表「诚实的未知」。 */
export type AttributionSource = 'workflow-state' | 'ledger' | 'none';

/** 宏观六相（与 flows/macroPhaseEngine.ts 的 PHASE_IDS 同序，此处独立声明避免反向依赖）。 */
export const JOIN_PHASE_ORDER: readonly string[] = ['plan', 'design', 'build', 'test', 'deploy', 'maintain'];

/** 收敛门 G0-G3 + HITL 门 H1-H4（门禁证据覆盖面的全集）。 */
export const JOIN_GATE_IDS: readonly string[] = ['G0', 'G1', 'G2', 'G3', 'H1', 'H2', 'H3', 'H4'];

/** 单维度分组结果。 */
export interface FlowGroup {
  /** 维度取值（如 `cycle-89` / `build` / `G2`）。 */
  key: string;
  /** 组内记录（保持输入顺序，不做再排序——调用方需要时间序）。 */
  flows: FlowRecord[];
  /** 记录数。 */
  total: number;
  /** DONE 数。 */
  done: number;
  /** FAILED 数。 */
  failed: number;
  /** TIMEOUT 数。 */
  timeout: number;
  /** INVOKING + RUNNING（已受理未终结）。 */
  active: number;
  /** 脚本 → 次数。 */
  scripts: Record<string, number>;
}

/** joinFlows 的结果：三维分组 + 无归属记录。 */
export interface FlowJoinIndex {
  /** 输入记录数。 */
  total: number;
  /** 按 cycle 分组（仅含已归属记录）。 */
  byCycle: FlowGroup[];
  /** 按 phase 分组（仅含已归属记录）。 */
  byPhase: FlowGroup[];
  /** 按 gate 分组（仅含已归属记录）。 */
  byGate: FlowGroup[];
  /** 无归属记录（source 缺省/none）。 */
  orphans: FlowRecord[];
  /** 孤儿数（= orphans.length，扁平化便于消费）。 */
  orphanCount: number;
}

/** 门禁证据行：哪道门有流证据、有几条。 */
export interface GateEvidence {
  gate: string;
  /** 是否至少有一条归属到该门的流。 */
  evidence: boolean;
  /** 归属到该门的流条数。 */
  flows: number;
}

/** 量化覆盖率指标（GET /anic/api/flows/matrix 的 metrics 段）。 */
export interface CoverageMetrics {
  total: number;
  attributed: number;
  /** 0-1；total===0 时为 0（不是 NaN——面板要能直接乘 100）。 */
  attributionRate: number;
  /** cycle 取值 → 条数。 */
  byCycle: Record<string, number>;
  /** phase 取值 → 条数。 */
  byPhase: Record<string, number>;
  /** gate 取值 → 条数。 */
  byGate: Record<string, number>;
  /** 无归属条数。 */
  orphans: number;
  /** G0-G3 + H1-H4 的证据覆盖（顺序固定，面板可直排）。 */
  gateEvidence: GateEvidence[];
  /** 有流但**无任何门禁证据**的循环（按 cycle 名排序）。 */
  unGatedCycles: string[];
}

/** 归属来源归一：非法/缺失 → 'none'（未知就是未知）。 */
export function attributionSourceOf(record: FlowRecord): AttributionSource {
  const s = record.attribution?.source;
  return s === 'workflow-state' || s === 'ledger' ? s : 'none';
}

/**
 * **门禁脚本白名单**：只有这些脚本本身在执行门禁，才算「有门禁证据」。
 *
 * 判据与实测反例见 flowGateSemantics.ts 头注（字段存在 ≠ 有门禁证据）。
 * 该文件是**独立声明**的第二份白名单（不反向 import runtime 层）——
 * 指标口径是判据，应当被独立钉住，而不是随 runtime 改动静默漂移。
 */
export { GATE_SCRIPT_NAMES, isGateEvidence } from './flowGateSemantics.ts';

/**
 * 是否已归属（严格口径）。
 * source 为权威：source==='none' 时，即使残留 cycle 字段也不算归属（见文件头）。
 *
 * gate 维度另受白名单约束：**非门禁脚本即便残留 gate 字段也不算门禁归属**
 * （见 flowGateSemantics.ts 头注的实测反例）。
 */
export function isAttributed(record: FlowRecord): boolean {
  if (attributionSourceOf(record) === 'none') return false;
  if (record.cycle || record.phase) return true;
  return isGateEvidence(record);
}

/**
 * 多项目隔离（归一 + 过滤）：独立成 flowWorkspaceScope.ts（隔离判据与归属判据
 * 正交，混在一起会让两个失败模式共享一个改动人）。此处**再导出**保既有
 * 消费者 import 路径零变更。
 */
export { normalizeWorkspace, sameWorkspace, filterByWorkspace } from './flowWorkspaceScope.ts';

const UNKNOWN = '\u0000unknown';

/** 维度取值：缺省 → UNKNOWN 标记（分组时过滤掉，不构造「未归属」组）。 */
function dimOf(record: FlowRecord, dim: 'cycle' | 'phase' | 'gate'): string {
  const v = record[dim];
  return typeof v === 'string' && v !== '' ? v : UNKNOWN;
}

/** 空组骨架。 */
function newGroup(key: string): FlowGroup {
  return { key, flows: [], total: 0, done: 0, failed: 0, timeout: 0, active: 0, scripts: {} };
}

/** 把一条记录并入组（就地累加，组是本函数新建的局部对象）。 */
function addToGroup(group: FlowGroup, record: FlowRecord): void {
  group.flows.push(record);
  group.total++;
  if (record.status === 'DONE') group.done++;
  else if (record.status === 'FAILED') group.failed++;
  else if (record.status === 'TIMEOUT') group.timeout++;
  else group.active++;
  const script = typeof record.script === 'string' ? record.script : '';
  group.scripts[script] = (group.scripts[script] ?? 0) + 1;
}

/** 维度排序键：已知枚举按声明序，未知按字典序排在后面（确定性输出，便于快照断言）。 */
function orderIndex(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

function compareGroups(order: readonly string[], a: FlowGroup, b: FlowGroup): number {
  const oa = orderIndex(order, a.key);
  const ob = orderIndex(order, b.key);
  if (oa !== ob) return oa - ob;
  // 同序时（典型：byCycle 无显式序）：总量降序（更活跃在前）+ key 降序（更新 cycle 在前）
  if (a.total !== b.total) return b.total - a.total;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

/**
 * 按维度分组（跳过缺省维度；不做归属判定——归属判定在调用方，见 joinFlows）。
 *
 * **gate 维度另受白名单约束**：非门禁脚本即便残留 gate 字段也不进 gate 组
 * （见 isGateEvidence 头注的实测反例：workflow-state 被打上 gate:'G3'）。
 */
function groupBy(records: readonly FlowRecord[], dim: 'cycle' | 'phase' | 'gate', order: readonly string[]): FlowGroup[] {
  const map = new Map<string, FlowGroup>();
  for (const r of records) {
    if (dim === 'gate' && !isGateEvidence(r)) continue;
    const key = dimOf(r, dim);
    if (key === UNKNOWN) continue;
    let g = map.get(key);
    if (!g) { g = newGroup(key); map.set(key, g); }
    addToGroup(g, r);
  }
  return [...map.values()].sort((a, b) => compareGroups(order, a, b));
}

/**
 * 三维 join：按 cycle / phase / gate 聚合已归属记录，并把孤儿单独列出。
 * 纯函数：不修改入参，返回全新对象。
 */
export function joinFlows(records: readonly FlowRecord[]): FlowJoinIndex {
  const list = [...records];
  const attributed = list.filter(isAttributed);
  const orphans = list.filter((r) => !isAttributed(r));
  return {
    total: list.length,
    byCycle: groupBy(attributed, 'cycle', []),
    byPhase: groupBy(attributed, 'phase', JOIN_PHASE_ORDER),
    byGate: groupBy(attributed, 'gate', JOIN_GATE_IDS),
    orphans,
    orphanCount: orphans.length,
  };
}

// 量化指标（coverageMetrics）拆至 flowJoinMetrics.ts（T3 ≤250 行）。
export { coverageMetrics } from './flowJoinMetrics.ts';
