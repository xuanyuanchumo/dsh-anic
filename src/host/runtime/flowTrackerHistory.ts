/**
 * flow-tracker 的 **append-only 历史层**（cycle-91）—— 读写 `flow-history.jsonl`。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `flowTracker.ts` 原本是「热窗口 + 历史」两件事挤在一个文件里。cycle-91
 * 引入历史层后文件破 250 行（T3 纪律），而更实际的问题是**变更节奏不同**：
 * - 热窗口（`flow-tracker.json`）：原子写、滚动裁剪、v1↔v2 兼容；
 * - 历史（`flow-history.jsonl`）：**只追加**、永不重写、坏行跳过。
 *
 * 混在一起时，改「历史坏行策略」的人会顺手改热窗口的原子写——
 * 两者的失效模式完全不同（热窗口坏了 = 状态丢失；历史坏了 = 一行丢失）。
 *
 * ## 边界
 *
 * 零业务逻辑：本文件只管「一行 JSON ↔ 一条记录」的编解码与落盘。
 * 「读多少条」「怎么排序」「怎么去重」在 `flowTracker.ts` 里。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { safeReadFileSync } from '../../shared/fs-safe.ts';
import { HISTORY_FILE } from './flowTrackerStore.ts';
import type { FlowRecord } from './flowTrackerTypes.ts';

/**
 * **append-only 历史**：追加一条终态记录到 `flow-history.jsonl`。
 *
 * ## 为什么在 `finishFlow` 追加而不是 `startFlow`
 *
 * 只有**终态**记录（`endedAt` / `exitCode` / `durationMs` 齐备）才是
 * 可统计的样本。`startFlow` 时记录还是 `INVOKING`（无耗时、无退出码），
 * 追加它会在历史里留下**永远不会被终结的幽灵样本**——那些流程若真的
 * 崩了（宿主被杀），就永远停在 `INVOKING`，统计口径就被污染。
 *
 * ⇒ 历史只收终态；未终结的流程只能从**热窗口**看到（如实显示为 RUNNING）。
 *
 * ## 为什么不覆盖写历史
 *
 * 覆盖写 = 重写整个文件 = O(n) 写放大 + 中途崩溃会丢历史。
 * append 只追加一行 = O(1)，崩溃最多丢最后一行（且那一行是"半条"，
 * 读侧会跳过不完整行——见 `readHistoryAll`）。
 */
export function appendHistory(cyclesDir: string, record: FlowRecord): void {
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const file = join(cyclesDir, HISTORY_FILE);
  // 每条记录一行 JSON（JSON.stringify 不含裸换行 ⇒ 一条记录 = 一行）。
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * 读取 **append-only 全量历史**（消除滚动淘汰偏差的读侧入口）。
 *
 * ## 坏行处理
 *
 * 追加写若在崩溃时中断，文件末行可能是**半条 JSON**。读侧**跳过**
 * 无法解析的行（而不是整体失败）——理由与 `loadFlowTracker` 的
 * "corrupt → reset" 不同：那里只有一个文件，坏了就是全坏；
 * 这里坏的是**一行**，前面的行都是好的。全丢是过度反应。
 *
 * ## 返回形状
 *
 * 按**追加顺序**返回（= 时间顺序）。调用方若要"最近 N 条"自己切尾。
 */
export function readHistoryAll(cyclesDir: string): FlowRecord[] {
  const file = join(cyclesDir, HISTORY_FILE);
  const raw = safeReadFileSync(file);
  if (!raw) return [];
  const out: FlowRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as FlowRecord;
      // 最小形状校验：没有 flowId 的不是记录（可能是别的行格式）。
      if (parsed && typeof parsed.flowId === 'string') out.push(parsed);
    } catch { /* 跳过半条/坏行，不整体失败 */ }
  }
  return out;
}
