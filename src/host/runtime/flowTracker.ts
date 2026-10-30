/**
 * 每流程状态跟踪器（M10-a · cycle-91 改双层存储）。
 *
 * 每次 anic_skill 调用创建一个独立 FlowRecord，跟踪
 * INVOKING → RUNNING → DONE/FAILED/TIMEOUT。
 *
 * ## 持久化（cycle-91 起：双层）
 *
 * ```
 * .cycles/flow-tracker.json   ← 热窗口（≤200 条「最近视图」，原子写，滚动）
 * .cycles/flow-history.jsonl  ← append-only 历史（每行一条终态记录，永不重写）
 * ```
 *
 * **为什么改**（cycle-90 收口台账 O-90-04 登记、本轮治本）：原实现把
 * 200 条上限的**滚动淘汰**当作容量管理，而淘汰造成**结构性统计偏差**：
 * 时间选择偏差（淘汰只在触顶时刻发生，样本在时间轴上聚集）、幸存者偏差
 * （只保留最近 200 条）、以及静默截断（读侧不比对 counter 就看不出丢过）。
 *
 * **为什么保留热窗口**：读侧（`loadFlowTracker(...).flows`）零改动即可继续
 * 工作；但历史文件保证**数据永不丢**——偏差从"看不见"变成"可查"。
 * 读侧要真正消除偏差，用 `loadAllFlowRecords()` 取全量。
 *
 * ## 分层（cycle-91 · 守 T3 ≤250 行）
 *
 * - `flowTrackerTypes.ts` —— 类型定义（静态）
 * - `flowTrackerStore.ts` —— 存储规格（常量与版本）
 * - `flowTrackerHistory.ts` —— 历史层读写（只追加）
 * - 本文件 —— 热窗口 + 编排 + 查询
 *
 * 设计约束：
 * - 零外部依赖（仅 node:fs + node:path + ../shared/fs-safe.ts）
 * - 原子写入（atomicWriteFileSync）；历史只 append（O(1)，与 segmentedLedger 同纪律）
 * - 线程安全（单进程同步写入，无并发竞争）
 * - 输出截断（stdout ≤8000, stderr ≤4000）防超大持久化文件
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { atomicWriteFileSync, safeReadFileSync } from '../../shared/fs-safe.ts';
import { resolveFlowAttribution } from './flowAttribution.ts';
import { appendHistory, readHistoryAll } from './flowTrackerHistory.ts';
import {
  MAX_WINDOW,
  STDOUT_MAX,
  STDERR_MAX,
  TRACKER_FILE,
  TRACKER_VERSION,
} from './flowTrackerStore.ts';
import type { FlowRecord, FlowTrackerState } from './flowTrackerTypes.ts';

export type { FlowRecord, FlowTrackerState, FlowStatus, FlowAttribution, FlowAttributionSource } from './flowTrackerTypes.ts';
export { appendHistory, readHistoryAll } from './flowTrackerHistory.ts';
export { recentFlows, activeFlows, flowStats } from './flowTrackerQuery.ts';
export { HISTORY_FILE, MAX_WINDOW, TRACKER_FILE } from './flowTrackerStore.ts';

/** 空状态。 */
export function initialFlowTrackerState(): FlowTrackerState {
  return { flows: [], counter: 0 };
}

/** 从磁盘加载状态。文件不存在或损坏时返回空状态。
 *
 * **向后兼容**：v1 文件（无 `version` 字段）的 `flows` / `counter` 语义与 v2
 * 完全一致（`counter` 本来就是单调累计值），故**无需迁移**。
 */
export function loadFlowTracker(cyclesDir: string): FlowTrackerState {
  const file = join(cyclesDir, TRACKER_FILE);
  const raw = safeReadFileSync(file);
  if (!raw) return initialFlowTrackerState();
  try {
    const parsed = JSON.parse(raw) as Partial<FlowTrackerState> & { version?: number };
    if (Array.isArray(parsed.flows) && typeof parsed.counter === 'number') {
      return { flows: parsed.flows, counter: parsed.counter };
    }
  } catch { /* corrupt → reset */ }
  return initialFlowTrackerState();
}

/** 持久化状态到磁盘（原子写入）。 */
export function saveFlowTracker(cyclesDir: string, state: FlowTrackerState): void {
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const file = join(cyclesDir, TRACKER_FILE);
  const payload: { version: number; flows: FlowRecord[]; counter: number } = {
    version: TRACKER_VERSION,
    flows: state.flows,
    counter: state.counter,
  };
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2));
}

/**
 * 读取全量样本 = **历史（append-only，无上界）∪ 热窗口里尚未进入历史的部分**。
 *
 * ## 为什么要合并而不是只用历史
 *
 * 迁移前写下的记录**只存在于热窗口**（历史文件是本轮新建的）。
 * 只读历史 ⇒ 迁移前的记录凭空消失 ⇒ 读数**变小**（另一种偏差）。
 * 合并后：历史 + 热窗口的记录取**并集**（按 `flowId` 去重，热的优先
 * ——热窗口里的记录更新鲜，可能已从 INVOKING 变为 DONE）。
 *
 * ## ⚠️ 顺序必须按时间重排（cycle-91 实测）
 *
 * 合并的天然顺序是「窗口的全部 + 历史的其余」⇒ **不是时间序**：
 * 热窗口装着最近 200 条（t=51..250），历史装着全部（t=1..250），
 * 直接合并会得到 `[51..250, 1..50]` —— 时间序被打乱。
 *
 * 后果是**静默的统计失真**：任何依赖「记录按时间排列」的消费者
 * （生存分析的区间构造、流程轨迹回放、最近 N 条的选取）都会算错，
 * 而且**不报错**。
 *
 * ⇒ 合并后**按 `startedAt` 升序重排**；同刻记录按 `flowId` 稳定排序
 * （保证同输入同输出，可复算）。
 */
export function loadAllFlowRecords(cyclesDir: string): FlowRecord[] {
  const state = loadFlowTracker(cyclesDir);
  const history = readHistoryAll(cyclesDir);
  const seen = new Set<string>();
  const merged: FlowRecord[] = [];
  // 热窗口优先（更新鲜）。
  for (const f of state.flows) {
    if (seen.has(f.flowId)) continue;
    seen.add(f.flowId);
    merged.push(f);
  }
  // 历史补齐（迁移前的记录只在这里）。
  for (const f of history) {
    if (seen.has(f.flowId)) continue;
    seen.add(f.flowId);
    merged.push(f);
  }
  // 按开始时间升序；同刻按 flowId 稳定排序（可复算）。
  merged.sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const va = Number.isFinite(ta) ? ta : 0;
    const vb = Number.isFinite(tb) ? tb : 0;
    if (va !== vb) return va - vb;
    return a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0;
  });
  return merged;
}

/** 滚动淘汰：超出 MAX_WINDOW 时保留最近 MAX_WINDOW 条。
 *
 * ⚠️ cycle-91 起这只是**热窗口**的裁剪，**不再丢数据**——
 * 终态记录已 append 进 `flow-history.jsonl`。
 */
function trimFlows(flows: FlowRecord[]): FlowRecord[] {
  if (flows.length <= MAX_WINDOW) return flows;
  return flows.slice(flows.length - MAX_WINDOW);
}

/** 创建新流程记录（INVOKING 状态——脚本定位/校验通过但尚未 spawn）并持久化。
 *
 * P3（已修）：'INVOKING' 此前是声明未赋值的死值（startFlow 直接写 'RUNNING'，
 * docs/anic/17:103 声称跟踪 INVOKING→RUNNING 与源码冲突）。现在两相真实落地：
 * INVOKING = 调用已受理、脚本即将 spawn；markRunning() 在 spawn 前推进到 RUNNING。
 */
export function startFlow(
  cyclesDir: string,
  state: FlowTrackerState,
  script: string,
  workspace: string,
  args: string[],
): { state: FlowTrackerState; flowId: string } {
  const counter = state.counter + 1;
  const now = new Date().toISOString();
  const flowId = `${script}-${now}-${counter}`;
  // cycle-89 修正：门禁归属由**脚本语义 + 参数**判定（不再取账本链头——
  // 那是「上次跑过哪道门」的历史残留，会把无关流程误标成有门禁证据）。
  const attr = resolveFlowAttribution(cyclesDir, now, script, args);
  const record: FlowRecord = {
    flowId,
    script,
    workspace,
    args,
    status: 'INVOKING',
    startedAt: now,
    cycle: attr.cycle,
    phase: attr.phase,
    gate: attr.gate,
    attribution: attr.attribution,
  };
  const newState: FlowTrackerState = {
    flows: trimFlows([...state.flows, record]),
    counter,
  };
  saveFlowTracker(cyclesDir, newState);
  return { state: newState, flowId };
}

/** 推进 INVOKING → RUNNING（spawn 前调用；幂等：非 INVOKING 状态不动）。 */
export function markRunning(cyclesDir: string, state: FlowTrackerState, flowId: string): FlowTrackerState {
  const flows = state.flows.map((f) => {
    if (f.flowId !== flowId || f.status !== 'INVOKING') return f;
    return { ...f, status: 'RUNNING' as FlowRecord['status'] };
  });
  const newState: FlowTrackerState = { flows, counter: state.counter };
  saveFlowTracker(cyclesDir, newState);
  return newState;
}

/** 完成流程记录（设置终态 + 输出 + 耗时）并持久化。
 *
 * **cycle-91**：终态记录**同时**追加进 append-only 历史
 * （`flow-history.jsonl`）⇒ 热窗口滚动不再丢数据。
 */
export function finishFlow(
  cyclesDir: string,
  state: FlowTrackerState,
  flowId: string,
  result: {
    exitCode: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    durationMs: number;
  },
): FlowTrackerState {
  const status: FlowRecord['status'] = result.timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'DONE' : 'FAILED';
  const now = new Date().toISOString();
  let finished: FlowRecord | undefined;
  const flows = state.flows.map((f) => {
    if (f.flowId !== flowId) return f;
    const next: FlowRecord = {
      ...f,
      status,
      endedAt: now,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, STDOUT_MAX),
      stderr: result.stderr.slice(0, STDERR_MAX),
      durationMs: result.durationMs,
    };
    finished = next;
    return next;
  });
  const newState: FlowTrackerState = { flows, counter: state.counter };
  saveFlowTracker(cyclesDir, newState);
  // 终态才进历史（INVOKING/RUNNING 不是可统计样本，见 appendHistory 头注）。
  if (finished !== undefined) appendHistory(cyclesDir, finished);
  return newState;
}
