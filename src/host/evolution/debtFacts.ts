/**
 * 债务复核的**当前事实**（cycle-108 · 闭环断点 B1 的读面）。
 *
 * ## 缺陷（doc 26 §3 B1）
 *
 * `.cycles/tech-debt/debt-E4-2026-11-05.json` 至今 `resolved:false`：
 * 它由「round 2 eval=0.00 / gate=FAIL」生成，而该根因（G1 任务清单为空）早已修复、
 * 后续轮次 E4 维度实测 PASS。旧分诊器只认 `skill:*` 维度（见 techDebtTriage.ts 判据表），
 * 对 `E4`/`Q7` 这类**评估维度债务**一律 `unverifiable`——于是已修复的债永远悬着，
 * 下一轮自举分析把它当开放债重报（提案污染判断）。
 *
 * ## 修法
 *
 * 评估维度债务的裁决者就是**评估本身**，与 health 债务的裁决者是健康读数同构：
 * 读「最新活跃循环的 `项目评估报告.md`」里该维度的当前裁决行，
 * PASS ⇒ 条件不再复现（stale）；FAIL ⇒ 仍复现（reproduced）；
 * SKIP / 无行 ⇒ 不可判定（unverifiable，**没证据不等于通过**）。
 *
 * 证据必须可复算：报告相对路径 + 内容 sha256 前 8 位。只写"当前 PASS"而不写
 * 是哪份报告，等于让下一次复核无法回答"你当时看的是哪一版"。
 *
 * ## 边界
 *
 * - **只扫活跃面**（`cycles/`），不扫 `archive/`：归档报告的结论不属于本轮输入；
 * - 读不到报告 ⇒ `dimensions` 为空 ⇒ 全部维度债务保持 unverifiable（不猜）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCycleDirNames } from '../runtime/bootstrapFactsReaders.ts';
import { loadLedger } from '../runtime/ledger.ts';

export type DimensionVerdict = 'PASS' | 'FAIL' | 'SKIP';

/** 评估报告裁决行：`| E4 | 代码质量 | PASS | detail |`（gate-check.mjs:53 同列位）。 */
const DIM_ROW = /^\|\s*((?:E|Q)[1-8])\s*\|\s*[^|\n]*\|\s*(PASS|FAIL|SKIP)\s*\|/gm;

/** 解析 16 维度裁决（同维度出现多次取**最后**一条——后写的行才是当前结论）。 */
export function parseDimensionVerdicts(markdown: string): Record<string, DimensionVerdict> {
  const out: Record<string, DimensionVerdict> = {};
  for (const m of markdown.matchAll(DIM_ROW)) {
    const dim = m[1];
    const verdict = m[2] as DimensionVerdict;
    if (dim !== undefined && (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'SKIP')) out[dim] = verdict;
  }
  return out;
}

export interface DebtFacts {
  /** 提供评估事实的活跃循环名；无报告 → null。 */
  cycle: string | null;
  /** 相对工作区的报告路径（正斜杠）；无 → null。 */
  reportPath: string | null;
  /** 报告内容 sha256 前 8 位；无 → null。 */
  digest: string | null;
  dimensions: Record<string, DimensionVerdict>;
  /** 账本里每个门的**最后一次**裁决（G0-G3）。 */
  gates: Record<string, DimensionVerdict>;
  gatesAllPass: boolean;
}

const GATES = ['G0', 'G1', 'G2', 'G3'] as const;

/** 最新活跃循环的评估报告 → 维度裁决；账本 → 门裁决。只读。 */
export function readDebtFacts(cyclesDir: string): DebtFacts {
  const names = listCycleDirNames(join(cyclesDir, 'cycles'));
  let cycle: string | null = null;
  let reportPath: string | null = null;
  let digest: string | null = null;
  let dimensions: Record<string, DimensionVerdict> = {};
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i];
    if (name === undefined) continue;
    const abs = join(cyclesDir, 'cycles', name, '项目评估报告.md');
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      cycle = name;
      reportPath = `.cycles/cycles/${name}/项目评估报告.md`;
      digest = createHash('sha256').update(buf).digest('hex').slice(0, 8);
      dimensions = parseDimensionVerdicts(buf.toString('utf-8'));
      break;
    } catch {
      continue;
    }
  }

  const gates: Record<string, DimensionVerdict> = {};
  try {
    for (const e of loadLedger(cyclesDir)) {
      if (!GATES.includes(e.gate as (typeof GATES)[number])) continue;
      const v = e.result.toUpperCase();
      if (v === 'PASS' || v === 'FAIL' || v === 'SKIP') gates[e.gate] = v;
    }
  } catch {
    // 账本损坏 ⇒ gates 留空 ⇒ gatesAllPass=false（不可判定，不假绿）。
  }
  return {
    cycle,
    reportPath,
    digest,
    dimensions,
    gates,
    gatesAllPass: GATES.every((g) => gates[g] === 'PASS'),
  };
}