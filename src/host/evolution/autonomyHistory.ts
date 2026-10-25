/**
 * 自主级变更审计账（cycle-77 T4 —— 修「自主级变更不可审计」P0）。
 *
 * 被守卫缺陷（实测证据，非推断）：`docs/anic/spike/evolution-replay-simulation.md`
 * 记录 incidents 目录里声称发生过 2 次 L4→L3 降级，而 `gates/ledger.json` 里
 * **0 条**自主级变更记录；`runAutonomyFallback` 也只在内存里返回结论 + 写一份
 * 自由文本 incident。后果：任何「现在为什么是 L4/L3」的问题都无法用**机器可读、
 * 结构化、可回归**的事实回答——只能读人写的 md，而 md 可由任意代码随意生成。
 *
 * 修法（INV-21 结构化身份纪律）：独立账本 `.cycles/autonomy-history.json`，
 * 每条变更记录 `from/to/at/actor/reason/authorization/evidence`，**不写自由文本
 * 充当身份**；写入走 `atomicWriteFileSync`（避免与读侧看到半写文件）。
 *
 * 刻意不写进 `gates/ledger.json`：AUTONOMY 条目会污染 H3 的 `slice(-4)` 门窗口
 * （两载体缺陷，R3 阶段 2 FlowRegistry 处理）——与 autonomyActions.ts 既有边界一致。
 *
 * 边界（有界保留，如实登记）：最多保留最近 `MAX_HISTORY_ENTRIES` 条，超限时
 * **从最旧端 FIFO 裁剪**（不写「中段省略」占位条目——占位条目本身是伪记录，
 * 会让 validateHistory 的 from/to 相邻性断言失效）。裁剪条数由 append 结果返回。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { AutonomyBand } from './trustModel.ts';

/** 账本文件名（`<workspace>/.cycles/` 下）。 */
export const AUTONOMY_HISTORY_FILE = 'autonomy-history.json';

/** 有界保留上限：50 条覆盖 ~50 次变更，足够回归定位且不让文件无界增长。 */
export const MAX_HISTORY_ENTRIES = 50;

/** 权威级别序列（相邻性判定的唯一口径，避免各调用点各写一份 if 链）。 */
export const BAND_ORDER: readonly AutonomyBand[] = ['L1', 'L2', 'L3', 'L4'];

/** 变更授权来源：human=人类显式承担；system=机器证据（熔断回退/机器升级）。 */
export type AutonomyAuthorization = 'human' | 'system';

/**
 * 变更时的证据快照 —— 让「凭什么变更」可复算，而不是只有一句 reason。
 * `trust.avg` 是全账本信任均值；`trust.gates` 是逐 gate 信任分；
 * `gates` 是逐 gate 的**最新实际裁决**（G0..G3，缺失的 gate 不编造）；
 * `breakers` 是当时触发的熔断 id 列表。
 */
export interface AutonomyEvidenceSnapshot {
  trust: { avg: number; gates: Record<string, number> };
  breakers: string[];
  gates: Record<string, string>;
  recommendedBand: string;
}

/** 一条自主级变更记录。 */
export interface AutonomyHistoryEntry {
  from: string;
  to: string;
  /** ISO 时间戳（写入时刻，非调用方声称时刻）。 */
  at: string;
  /** 动作发起者（工具名 / 模块名 / 人类标识）。 */
  actor: string;
  reason: string;
  authorization: AutonomyAuthorization;
  evidence: AutonomyEvidenceSnapshot;
  /**
   * 人类豁免信任阈值时**如实记录豁免内容**（cycle-77）：信任分不足而人类显式
   * 承担时升级是合法的，但事后看到 `trust.avg < threshold` 必须能查到「谁豁免了」，
   * 否则这条升级记录看起来像个 bug。
   */
  trustExemption?: { avg: number; threshold: number };
  /** 变更发生时的工作区最新 cycle 号（存在 `.cycles/cycles/cycle-N` 时）。 */
  atCycle?: number;
}

/** 读取结果：坏 JSON **响亮**报错（不静默吞成 []，那会让审计面假绿）。 */
export interface HistoryReadResult {
  entries: AutonomyHistoryEntry[];
  error: string | null;
}

/** 追加结果（含裁剪事实，便于调用方回显「有界」而不是假装全量保留）。 */
export interface HistoryAppendResult {
  ok: boolean;
  path: string;
  /** 写入后的总条数。 */
  count: number;
  /** 本次因超限被裁掉的最旧条数。 */
  dropped: number;
  error: string | null;
}

/** 账本绝对路径。 */
export function historyPath(cyclesDir: string): string {
  return join(cyclesDir, AUTONOMY_HISTORY_FILE);
}

/** 级别序号（非法级别返回 -1，供相邻性判定与排序）。 */
export function bandIndex(band: string): number {
  return BAND_ORDER.indexOf(band as AutonomyBand);
}

/** 两档是否相邻（L2↔L3 / L3↔L4；同档或跨档都不算）。 */
export function areAdjacentBands(from: string, to: string): boolean {
  const a = bandIndex(from);
  const b = bandIndex(to);
  return a >= 0 && b >= 0 && Math.abs(a - b) === 1;
}

/**
 * 读账本：缺失 → 空账 + 无错误（首次运行是合法初始态）；
 * 坏 JSON / 非数组 → entries=[] 且 error 点名文件与根因。
 */
export function readHistory(cyclesDir: string): HistoryReadResult {
  const path = historyPath(cyclesDir);
  if (!existsSync(path)) return { entries: [], error: null };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return { entries: [], error: `cannot read ${AUTONOMY_HISTORY_FILE}: ${(e as Error).message}` };
  }
  if (raw.trim() === '') return { entries: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], error: `${AUTONOMY_HISTORY_FILE} is not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], error: `${AUTONOMY_HISTORY_FILE} is not a JSON array` };
  }
  // 逐条形状校验但不丢弃坏条目：坏条目由 validateHistory 点名，
  // 读侧不做「静默过滤」（过滤 = 让坏账消失得无声无息）。
  return { entries: parsed as AutonomyHistoryEntry[], error: null };
}

/**
 * 追加一条变更记录：读 → 追加 → 有界裁剪 → 原子写 → 回读断言。
 *
 * 坏账拒绝追加（ok:false）：在损坏文件上覆盖写会**销毁**原有审计线索，
 * 「响亮失败 + 保留原文」比「写成功但历史被抹」更符合审计纪律。
 */
export function appendHistory(cyclesDir: string, entry: AutonomyHistoryEntry): HistoryAppendResult {
  const path = historyPath(cyclesDir);
  const read = readHistory(cyclesDir);
  if (read.error !== null) {
    return { ok: false, path, count: read.entries.length, dropped: 0, error: read.error };
  }
  const entryIssues = validateEntry(entry);
  if (entryIssues.length > 0) {
    return { ok: false, path, count: read.entries.length, dropped: 0, error: entryIssues.join('; ') };
  }
  const all = [...read.entries, entry];
  const dropped = Math.max(0, all.length - MAX_HISTORY_ENTRIES);
  const kept = dropped > 0 ? all.slice(dropped) : all;
  atomicWriteFileSync(path, JSON.stringify(kept, null, 2) + '\n');
  // Post-Verify：回读末尾条目必须与意图逐字一致（写入与事实不得解耦）。
  const verified = readHistory(cyclesDir);
  const last = verified.entries[verified.entries.length - 1];
  const same = verified.error === null && last !== undefined &&
    last.from === entry.from && last.to === entry.to && last.at === entry.at;
  if (!same) {
    return {
      ok: false, path, count: verified.entries.length, dropped,
      error: `post-verify mismatch: observed last entry ${JSON.stringify(last?.at ?? null)} != ${entry.at}`,
    };
  }
  return { ok: true, path, count: verified.entries.length, dropped, error: null };
}

/**
 * 单条校验：必填字段 + 级别合法 + 相邻 + 证据形状。
 * 返回问题列表（空数组 = 合法），供自检 / 测试复用（不做 IO）。
 */
export function validateEntry(entry: AutonomyHistoryEntry): string[] {
  const issues: string[] = [];
  const e = entry as Partial<AutonomyHistoryEntry> | null;
  if (e === null || typeof e !== 'object') return ['entry is not an object'];
  for (const key of ['from', 'to', 'at', 'actor', 'reason'] as const) {
    const v = e[key];
    if (typeof v !== 'string' || v.trim() === '') issues.push(`${key} must be a non-empty string`);
  }
  if (typeof e.from === 'string' && bandIndex(e.from) < 0) issues.push(`from "${e.from}" is not L1-L4`);
  if (typeof e.to === 'string' && bandIndex(e.to) < 0) issues.push(`to "${e.to}" is not L1-L4`);
  if (typeof e.from === 'string' && typeof e.to === 'string' &&
    bandIndex(e.from) >= 0 && bandIndex(e.to) >= 0 && !areAdjacentBands(e.from, e.to)) {
    issues.push(`from/to must be adjacent bands, got ${e.from} -> ${e.to}`);
  }
  if (typeof e.at === 'string' && Number.isNaN(Date.parse(e.at))) issues.push(`at "${e.at}" is not a parseable timestamp`);
  if (e.authorization !== 'human' && e.authorization !== 'system') {
    issues.push('authorization must be "human" or "system"');
  }
  const ev = e.evidence;
  if (ev === undefined || ev === null || typeof ev !== 'object') {
    issues.push('evidence is required');
  } else {
    if (typeof ev.trust?.avg !== 'number') issues.push('evidence.trust.avg must be a number');
    if (ev.trust?.gates === undefined || typeof ev.trust.gates !== 'object') issues.push('evidence.trust.gates must be an object');
    if (!Array.isArray(ev.breakers)) issues.push('evidence.breakers must be an array');
    if (ev.gates === undefined || typeof ev.gates !== 'object') issues.push('evidence.gates must be an object');
    if (typeof ev.recommendedBand !== 'string') issues.push('evidence.recommendedBand must be a string');
  }
  return issues;
}

/**
 * 整账校验：逐条校验 + **时间序单调**（非递减）+ 相邻性由单条校验覆盖。
 * 单调容忍相等时间戳（同一毫秒内两次变更不是错误），倒退才是。
 */
export function validateHistory(entries: AutonomyHistoryEntry[]): string[] {
  const issues: string[] = [];
  let prevAt: number | null = null;
  entries.forEach((entry, i) => {
    for (const issue of validateEntry(entry)) issues.push(`#${String(i)} ${issue}`);
    const at = Date.parse(entry?.at ?? '');
    if (!Number.isNaN(at)) {
      if (prevAt !== null && at < prevAt) issues.push(`#${String(i)} at is earlier than previous entry (time order violated)`);
      prevAt = at;
    }
  });
  return issues;
}

/** 摘要投影（org-status 只暴露最近 N 条，不把整账灌进响应）。
 *
 * cycle-78 补漏：`trustExemption` 是**人类授权覆盖信任阈值**的机器证据
 * （L3→L4 在 avg 84 < 85 时靠它成立）。此前摘要把它丢掉 ⇒ 面板 UI 的豁免分支
 * 永远走不到（fixture 能测、真机看不见）。审计信息不得在投影层被择优丢失。
 */
export function summarizeHistory(
  entries: AutonomyHistoryEntry[],
  limit = 5,
): Array<{
  from: string;
  to: string;
  at: string;
  actor: string;
  authorization: string;
  reason: string;
  trustExemption?: { avg: number; threshold: number };
}> {
  return entries.slice(-Math.max(0, limit)).map((e) => ({
    from: e.from,
    to: e.to,
    at: e.at,
    actor: e.actor,
    authorization: e.authorization,
    reason: e.reason,
    ...(e.trustExemption ? { trustExemption: e.trustExemption } : {}),
  }));
}
