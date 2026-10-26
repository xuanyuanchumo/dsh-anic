/**
 * 重载史账域（cycle-80 WS-1 · 一域一文件）：`.cycles/reload-history.json` 的读写与握手落定。
 *
 * ## 为什么先落 in-flight（本模块存在的核心理由）
 * `reconcileProfile` 会卸载/替换本实例，之后本进程写的任何东西都可能丢失——事后没有任何
 * 进程能补写「我请求过重载」。所以请求方必须**先**写 `status:'in-flight'` 条目，重载后的
 * **新实例**再调 `finalizeInFlight` 把它补成 `reloaded`。这不是日志，是跨实例状态机：
 * 少了 in-flight，重载史在真发生重载时会显示成「什么都没发生」。
 *
 * ## 三条写盘纪律
 * 1. 原子写（tmp + rename）：读到半截 JSON 的历史不可信任，故不原地覆写；
 * 2. 有界 FIFO 50：留够最近若干次，又不让文件无限长（返回 dropped 让调用方如实记账）；
 * 3. 损坏文件先改名 `.corrupt` 备份再重建——**静默销毁证据**是不允许的。
 *
 * ## 幂等语义
 * `finalizeInFlight` 只在「最后一条确为 in-flight」时改写，否则返回 null 且**零写入**。
 * 于是「正常启动调用一次」不污染历史，「重复调用」也不会产生第二个结局。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 重载史文件名（放工作区 `.cycles/` 下；跨实例共享的握手面）。 */
export const RELOAD_HISTORY_FILE = 'reload-history.json';
/** 有界 FIFO：够看清最近若干次重载，又不让文件无限长。 */
export const RELOAD_HISTORY_LIMIT = 50;

/** 一次重载请求的留痕条目（in-flight → reloaded / failed 的跨实例状态机）。 */
export interface ReloadHistoryEntry {
  at: string;
  actor: string;
  reason: string;
  status: 'in-flight' | 'reloaded' | 'refused' | 'unavailable' | 'failed';
  fromRevision: string | null;
  toRevision: string | null;
  staleAtRequest: boolean;
  warnings: string[];
  pending: string[];
  restartReason: string | null;
  error: string | null;
  finalizedAt?: string;
}

/** 历史文件绝对路径。 */
function historyPath(cyclesDir: string): string {
  return join(cyclesDir, RELOAD_HISTORY_FILE);
}

/** 原子写（tmp + rename）；失败返回 false，由调用方决定是否继续（不吞异常语义）。 */
function writeHistory(cyclesDir: string, entries: ReloadHistoryEntry[]): boolean {
  try {
    mkdirSync(cyclesDir, { recursive: true });
    const target = historyPath(cyclesDir);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** 读重载史。缺失 → 空数组 + error null；损坏 → 空数组 + **响亮** error（绝不抛）。 */
export function readReloadHistory(cyclesDir: string): { entries: ReloadHistoryEntry[]; error: string | null } {
  const p = historyPath(cyclesDir);
  if (!existsSync(p)) return { entries: [], error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return { entries: [], error: `${RELOAD_HISTORY_FILE} is not a JSON array` };
    return { entries: parsed as ReloadHistoryEntry[], error: null };
  } catch (e) {
    return { entries: [], error: `${RELOAD_HISTORY_FILE} is corrupt: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 追加一条重载史（有界 FIFO 50）。
 * 损坏文件先改名 `.corrupt` 备份再重建——覆盖允许，静默销毁证据不允许。
 */
export function appendReloadHistory(cyclesDir: string, entry: ReloadHistoryEntry): { ok: boolean; dropped?: number } {
  const read = readReloadHistory(cyclesDir);
  if (read.error !== null) {
    try { renameSync(historyPath(cyclesDir), `${historyPath(cyclesDir)}.corrupt`); } catch { /* 备份失败不阻断追加 */ }
  }
  const entries = [...read.entries, entry];
  const dropped = Math.max(0, entries.length - RELOAD_HISTORY_LIMIT);
  const kept = dropped > 0 ? entries.slice(dropped) : entries;
  const ok = writeHistory(cyclesDir, kept);
  return dropped > 0 ? { ok, dropped } : { ok };
}

/**
 * 跨实例握手落定：把最后一条 in-flight 改写成 reloaded。
 *
 * 只有「最后一条是 in-flight」时才写（返回新条目）；否则返回 null 且**零写入**——
 * 幂等正是它的价值：新实例启动正常调用不污染历史，重复调用不产生第二个结局。
 */
export function finalizeInFlight(cyclesDir: string, observedRevision: string | null): ReloadHistoryEntry | null {
  const { entries } = readReloadHistory(cyclesDir);
  const last = entries[entries.length - 1];
  if (last === undefined || last.status !== 'in-flight') return null;
  const finalized: ReloadHistoryEntry = {
    ...last,
    status: 'reloaded',
    toRevision: observedRevision,
    finalizedAt: new Date().toISOString(),
  };
  const next = [...entries.slice(0, -1), finalized];
  return writeHistory(cyclesDir, next) ? finalized : null;
}
