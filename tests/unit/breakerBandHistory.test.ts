/**
 * CB5「性能未恢复」可达性契约（cycle-78 WS-E）——真实 band-history 形状下必须能触发。
 *
 * 被守卫缺陷（fail-open，本轮实测）：`breakerSignals.ts` 的 CB5 判定原为
 *   `recent.every(e => e.band === 'alarm')`
 * 而真实生产里 `band-detector.mjs` 写进 `.cycles/band-history.json` 的条目形状是
 * `{timestamp,totalScore,avgScore,fileCount,overBudgetCount}` —— **没有 band 字段**
 * ⇒ `every()` 对 undefined 恒 false ⇒ **CB5 熔断永不触发**（该熔断的安全作用等于
 * 不存在），而三处文档仍宣称它有效。坏方向是「沉默失效」，没有任何测试会红。
 *
 * 修法：双形状兼容（两种形状都是真实生产写出的，不是为测试编造）——
 *   · 自主带形状 `band === 'alarm'`（保留既有语义）；
 *   · 质量带形状 `overBudgetCount > 0`（该轮存在超预算文件 = 质量未恢复）；
 *   · 末 2 条**都**命中才触发（「连续 2 轮」），缺失/坏 JSON/非对象 → false 不抛。
 *
 * 反向自检：用例内重建**旧判定**并在同一夹具上断言它判 false —— 证明 ① 的夹具
 * 真能区分新旧实现（旧实现下 ① 必红），而不是「新旧都 true」的空断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectBreakerSignals } from '../../src/host/evolution/breakerSignals.ts';
import { checkBreakers, type BreakerInput } from '../../src/host/evolution/autonomyGovernor.ts';

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `anic-cb5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.cycles'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 真实生产形状（band-detector.mjs 写盘）：无 band 字段，只有 overBudgetCount。 */
function qualityEntry(overBudgetCount: number): Record<string, unknown> {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    totalScore: 1840,
    avgScore: 70.77,
    fileCount: 26,
    overBudgetCount,
  };
}

/** 自主带形状（autonomyHistory 侧写盘）：band 字段。 */
function autonomyEntry(band: string): Record<string, unknown> {
  return { cycle: 1, score: 0.5, timestamp: '2026-01-01', band };
}

function writeHistory(entries: unknown[]): void {
  writeFileSync(join(root, '.cycles', 'band-history.json'), JSON.stringify(entries));
}

/** 旧实现逐字重建（只认 band 字段）——反向自检用，不得进入生产路径。 */
function legacyBandUnrecovered(history: unknown[]): boolean {
  if (!Array.isArray(history) || history.length < 2) return false;
  const recent = history.slice(-2) as Array<{ band?: unknown }>;
  return recent.every((e) => e?.band === 'alarm');
}

/** CB5 结果（checkBreakers 的 perf_unrecovered 臂）。 */
function cb5(input: BreakerInput): { tripped: boolean; detail: string } {
  const r = checkBreakers(input).find((b) => b.id === 'perf_unrecovered');
  expect(r, 'checkBreakers 必须保留 perf_unrecovered（CB5）臂').toBeTruthy();
  return r as { tripped: boolean; detail: string };
}

describe('① 真实生产形状（无 band 字段，overBudgetCount>0）→ CB5 必须触发', () => {
  it('末 2 条 overBudgetCount>0 → perfUnrecovered=true 且 checkBreakers 熔断', () => {
    const entries = [qualityEntry(0), qualityEntry(3), qualityEntry(1)];
    writeHistory(entries);
    const input = collectBreakerSignals(root);
    expect(input.perfUnrecovered, '末 2 条都超预算 → CB5 必须可达（旧实现下恒 false）').toBe(true);
    const r = cb5(input);
    expect(r.tripped).toBe(true);
    expect(r.detail).toContain('性能阈值');
  });
});

describe('② 末 2 条 overBudgetCount=0 → 不触发（不误报）', () => {
  it('健康历史不得触发 CB5', () => {
    writeHistory([qualityEntry(2), qualityEntry(0), qualityEntry(0)]);
    const input = collectBreakerSignals(root);
    expect(input.perfUnrecovered).toBe(false);
    expect(cb5(input).tripped).toBe(false);
  });
});

describe('③ 只有最后 1 条超预算 → 不触发（「连续 2 轮」语义）', () => {
  it('单轮命中不是连续两轮', () => {
    writeHistory([qualityEntry(0), qualityEntry(0), qualityEntry(5)]);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
  });
});

describe('④ 自主带形状 band=\'alarm\'×2 → 仍触发（向后兼容）', () => {
  it('既有 band 语义不被双形状改造破坏', () => {
    writeHistory([autonomyEntry('stable'), autonomyEntry('alarm'), autonomyEntry('alarm')]);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(true);
  });

  it('混合形状（前一条超预算、后一条 alarm）→ 触发（逐条取或）', () => {
    writeHistory([qualityEntry(0), qualityEntry(2), autonomyEntry('alarm')]);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(true);
  });
});

describe('⑤ fail-safe：缺失/坏 JSON/非数组/字段类型不符 → 不抛、不触发', () => {
  it('文件缺失 → false', () => {
    rmSync(join(root, '.cycles', 'band-history.json'), { force: true });
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
  });

  it('坏 JSON → false 且不抛（采集层绝不炸 org-status）', () => {
    writeFileSync(join(root, '.cycles', 'band-history.json'), '[broken');
    expect(() => collectBreakerSignals(root)).not.toThrow();
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
  });

  it('非数组 / 少于 2 条 → false', () => {
    writeFileSync(join(root, '.cycles', 'band-history.json'), JSON.stringify({ snapshots: [] }));
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
    writeHistory([qualityEntry(3)]);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
  });

  it('overBudgetCount 非数字（字符串/布尔/null）→ false，不做隐式转换', () => {
    writeHistory([
      { overBudgetCount: '3' },
      { overBudgetCount: true },
      { overBudgetCount: null },
    ]);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
  });
});

describe('⑥ 反向自检：旧判定（只认 band）在同一夹具上必须判 false', () => {
  it('真实生产夹具下旧实现 = fail-open；且旧实现在自主带夹具上仍 true（变异有区分力）', () => {
    const realShape = [qualityEntry(0), qualityEntry(3), qualityEntry(1)];
    // 旧实现（cycle-21 形态）在真实生产形状上恒 false ⇒ 修复前的 CB5 永不可达
    expect(legacyBandUnrecovered(realShape)).toBe(false);
    // 新实现同夹具 true ⇒ 「① 在旧实现下必红」成立（不是新旧都 true 的空断言）
    writeHistory(realShape);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(true);
    // 旧实现并非恒 false：自主带夹具上仍判 true —— 证明变异点确实在「形状」上
    expect(legacyBandUnrecovered([autonomyEntry('alarm'), autonomyEntry('alarm')])).toBe(true);
  });
});
