/**
 * 技术债**跨日去重**契约（cycle-89）。
 *
 * ## 被守卫的缺陷
 *
 * `persistHealthSuggestionsAsDebt` 的去重只看**同日**文件
 * （`knownIds` 来自当天 `health-<date>.json`），于是同一条建议在每个日期
 * 都生成一条新提案。
 *
 * 实测：`.cycles/tech-debt/` 里 `health-speed-auto-fix-loop` 有 **3 条**
 * （10-28 / 10-29 / 10-30），`health-perf-eval-runner` 有 **2 条** ——
 * 而这实际是**两个问题**（auto-fix-loop 超时、eval-runner 慢）。
 *
 * 后果不是显示难看，是**债务计数失真**：用户按数字决定修什么，
 * 修 3 次同一个问题，另 6 条真正的债（debt-F 系列 / G1）反而没动。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistHealthSuggestionsAsDebt } from '../../src/host/evolution/healthDebtBridge.ts';
import type { ImprovementSuggestion } from '../../src/host/runtime/healthSuggestions.ts';

/** 造一条建议。 */
function sugg(id: string, severity: ImprovementSuggestion['severity'] = 'warn'): ImprovementSuggestion {
  return {
    id,
    severity,
    script: id.replace(/^(fix|speed|perf)-/, ''),
    description: `${id} 的描述`,
    action: '修复',
  };
}

/** 读某日文件里的条目（文件在 `tech-debt/` 子目录下）。 */
function readEntries(cyclesDir: string, date: string): Array<{ id: string; severity: string; resolved?: boolean }> {
  const f = join(cyclesDir, 'tech-debt', `health-${date}.json`);
  if (!existsSync(f)) return [];
  const raw = JSON.parse(readFileSync(f, 'utf-8'));
  return raw as Array<{ id: string; severity: string; resolved?: boolean }>;
}

describe('persistHealthSuggestionsAsDebt：跨日去重', () => {
  it('**同一条建议在第二个日期不重复建债**（核心守卫）', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-debt-'));
    const cyclesDir = join(base, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });

    // 第一天：新建一条。
    const r1 = persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop')], '2026-10-28T00:00:00.000Z');
    expect(r1.written).toBe(1);

    // 第二天：**同一条**建议 → 不应新建。
    const r2 = persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop')], '2026-10-29T00:00:00.000Z');
    expect(r2.written).toBe(0);
    expect(r2.skipped).toBe(1);

    // 第三天同理。
    const r3 = persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop')], '2026-10-30T00:00:00.000Z');
    expect(r3.written).toBe(0);

    // 全目录里这条建议**只应有一条**未决条目。
    const all = [
      ...readEntries(cyclesDir, '2026-10-28'),
      ...readEntries(cyclesDir, '2026-10-29'),
      ...readEntries(cyclesDir, '2026-10-30'),
    ];
    expect(all.filter((e) => e.id.startsWith('health-speed-auto-fix-loop'))).toHaveLength(1);

    rmSync(base, { recursive: true, force: true });
  });

  it('**不同建议各建各的**（去重不能误伤）', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-debt2-'));
    const cyclesDir = join(base, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });

    const r1 = persistHealthSuggestionsAsDebt(
      cyclesDir,
      [sugg('speed-auto-fix-loop'), sugg('perf-eval-runner')],
      '2026-10-28T00:00:00.000Z',
    );
    expect(r1.written).toBe(2);

    const r2 = persistHealthSuggestionsAsDebt(
      cyclesDir,
      [sugg('speed-auto-fix-loop'), sugg('perf-eval-runner')],
      '2026-10-29T00:00:00.000Z',
    );
    expect(r2.written).toBe(0);

    rmSync(base, { recursive: true, force: true });
  });

  it('**severity 升级 → 更新那条（不是新建，也不是忽略）**', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-debt3-'));
    const cyclesDir = join(base, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });

    persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop', 'warn')], '2026-10-28T00:00:00.000Z');
    // 次日同一条，但严重度升级。
    const r2 = persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop', 'critical')], '2026-10-29T00:00:00.000Z');
    expect(r2.written).toBe(0); // 不新建

    // 原那条的 severity 应被更新为 critical。
    const entries = readEntries(cyclesDir, '2026-10-28');
    const target = entries.find((e) => e.id.startsWith('health-speed-auto-fix-loop'));
    expect(target?.severity).toBe('critical');

    rmSync(base, { recursive: true, force: true });
  });

  it('**已偿还的债不因日期翻页复活**（复活防御仍然生效）', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-debt4-'));
    const cyclesDir = join(base, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });

    persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop', 'warn')], '2026-10-28T00:00:00.000Z');
    // 标记已偿还。
    const file = join(cyclesDir, 'tech-debt', 'health-2026-10-28.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    for (const e of raw) e.resolved = true;
    writeFileSync(file, JSON.stringify(raw, null, 2));

    // 次日同一条同严重度 → 跳过（不复活）。
    const r2 = persistHealthSuggestionsAsDebt(cyclesDir, [sugg('speed-auto-fix-loop', 'warn')], '2026-10-29T00:00:00.000Z');
    expect(r2.written).toBe(0);
    expect(r2.skippedResolved).toBe(1);

    rmSync(base, { recursive: true, force: true });
  });

  it('空建议列表 → 什么都不写', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-debt5-'));
    const cyclesDir = join(base, '.cycles');
    mkdirSync(cyclesDir, { recursive: true });
    const r = persistHealthSuggestionsAsDebt(cyclesDir, [], '2026-10-28T00:00:00.000Z');
    expect(r.written).toBe(0);
    expect(r.file).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});
