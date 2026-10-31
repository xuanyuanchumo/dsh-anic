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
// cycle-94：淘汰策略 + 水位线（纯函数；见 flowRetention.ts 头注）。
import { trimWithWatermark, type EvictionWatermark } from './flowRetention.ts';
import {
  MAX_WINDOW,
  STDOUT_MAX,
  STDERR_MAX,
} from './flowTrackerStore.ts';
import type { FlowRecord, FlowTrackerState } from './flowTrackerTypes.ts';

export type { FlowRecord, FlowTrackerState, FlowStatus, FlowAttribution, FlowAttributionSource } from './flowTrackerTypes.ts';
export type { EvictionWatermark } from './flowRetention.ts';
export { EMPTY_WATERMARK, isLive, mergeWatermarks, trimWithWatermark, MAX_LIVE_RESCUE } from './flowRetention.ts';
export { appendHistory, readHistoryAll } from './flowTrackerHistory.ts';
export { recentFlows, activeFlows, flowStats } from './flowTrackerQuery.ts';
export { HISTORY_FILE, MAX_WINDOW, TRACKER_FILE } from './flowTrackerStore.ts';
// cycle-94：持久化面拆至 flowTrackerPersist.ts（T3 ≤250 行）；此处再导出保持导入路径不变。
export { initialFlowTrackerState, loadFlowTracker, saveFlowTracker } from './flowTrackerPersist.ts';
import { initialFlowTrackerState, loadFlowTracker, saveFlowTracker } from './flowTrackerPersist.ts';

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
 *
 * ★cycle-94：淘汰策略与**水位线**下沉到 `flowRetention.ts`（纯函数可单测）。
 * 本函数只做形态适配。两个行为变化（都是有意的）：
 *   1. **进行中的流程永不淘汰**（`INVOKING`/`RUNNING` 即使落在被裁区间也捞回来）
 *      —— 超时的任务正是最旧的，按"最旧先丢"裁会让"正在跑什么"凭空消失；
 *   2. 淘汰**必须上报水位线**（`evictedThrough`/`evictedTotal`），
 *      否则读侧无从判断自己看到的是全部还是被裁过的最近 200 条。
 */
function trimFlows(
  flows: FlowRecord[],
  prev?: EvictionWatermark,
): { flows: FlowRecord[]; watermark: EvictionWatermark } {
  // `trimWithWatermark` 返回 `kept`；本函数保持仓内既有命名 `flows`（调用方
  // `startFlow` 用的是 `trimmed.flows`）。这层改名不是多余的：`kept` 在策略层
  // 表达的是「留下了哪些」（与 `evicted` 对偶），而 `flows` 在状态层表达的是
  // 「窗口里有哪些」——两者语义不同，各自在自己那层是准确的名字。
  const r = trimWithWatermark(flows, MAX_WINDOW, prev);
  return { flows: r.kept, watermark: r.watermark };
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
  // cycle-94：淘汰结果带水位线（`prev` 从 state 带入，保证跨次调用单调累加）。
  const trimmed = trimFlows([...state.flows, record], state.watermark);
  const newState: FlowTrackerState = {
    flows: trimmed.flows,
    counter,
    watermark: trimmed.watermark,
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
  // cycle-94：水位线原样带过（本函数不改变窗口成员集合 ⇒ 不可能产生新淘汰）。
  const newState: FlowTrackerState = { flows, counter: state.counter, watermark: state.watermark };
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
  // cycle-94：水位线原样带过（终态转换不改变窗口成员集合）。
  const newState: FlowTrackerState = { flows, counter: state.counter, watermark: state.watermark };
  saveFlowTracker(cyclesDir, newState);
  // 终态才进历史（INVOKING/RUNNING 不是可统计样本，见 appendHistory 头注）。
  if (finished !== undefined) appendHistory(cyclesDir, finished);
  return newState;
}
