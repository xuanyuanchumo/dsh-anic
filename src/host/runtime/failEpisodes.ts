/**
 * 门禁账本 → 「FAIL → PASS」修复 episode（cycle-90 · 从 `gateSurvival.ts` 拆出，
 * 守 T3 ≤250 行）。
 *
 * ## 切分规则（逐门独立）
 *
 * - 遇到 FAIL：开一个 episode（起点 = 该 FAIL 的时间戳）。
 * - 遇到 PASS 且有未闭合 episode：**闭合**它（终点 = 该 PASS 的时间戳，event=true）。
 * - 遇到 PASS 且无未闭合 episode：忽略（PASS 不开 episode —— 我们测的是「修复耗时」）。
 * - 序列结束时仍有未闭合 episode ⇒ **右删失**（event=false）—— 该门还没修好。
 *
 * ## 为什么逐门切而不是全局切
 *
 * 门是**独立的判定单元**：G0 失败不影响 G1 的时钟。混在一起测出来的
 * 「修复耗时」会把不同门的等待时间串成一条假时间线。
 *
 * ## 边界
 *
 * 纯函数：零 DOM / 零 clock / 零 random / 零 IO。
 */
import type { SurvivalSample } from './gateSurvival.ts';

/**
 * 从门禁账本条目切出「FAIL → PASS」的修复 episode。
 *
 * @param entries 门禁账本条目（需含 `gate` / `result` / `timestamp`）
 */
export function failEpisodes(
  entries: ReadonlyArray<{ gate?: string; result?: string; timestamp?: string }>,
): SurvivalSample[] {
  const byGate = new Map<string, Array<{ result: string; t: number }>>();
  for (const e of entries) {
    const gate = typeof e.gate === 'string' ? e.gate : '';
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
    if (gate === '' || !Number.isFinite(ts)) continue;
    const list = byGate.get(gate);
    if (list === undefined) byGate.set(gate, [{ result: e.result ?? '', t: ts }]);
    else list.push({ result: e.result ?? '', t: ts });
  }

  const samples: SurvivalSample[] = [];
  for (const list of byGate.values()) {
    list.sort((a, b) => a.t - b.t);
    let openStart: number | null = null;
    for (const item of list) {
      if (item.result === 'FAIL') {
        // 连续 FAIL：保留**最早**那个起点（修一次要修到底）。
        if (openStart === null) openStart = item.t;
        continue;
      }
      if (item.result === 'PASS' && openStart !== null) {
        samples.push({ durationMs: Math.max(0, item.t - openStart), event: true });
        openStart = null;
      }
    }
    if (openStart !== null) {
      // 未闭合 ⇒ 右删失（此刻还没有观测到修复）。
      const lastT = list[list.length - 1]?.t ?? openStart;
      samples.push({ durationMs: Math.max(0, lastT - openStart), event: false });
    }
  }
  return samples;
}
