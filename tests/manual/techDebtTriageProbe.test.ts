/**
 * 技术债分诊**探针**（cycle-88）——默认只读（打印三态清单），真写需显式 env。
 *
 * ## 为什么要有这个探针
 *
 * `.cycles/tech-debt/` 的 health-* 提案是每日自举评估自动生成的；问题修掉后
 * 它们永远留在队列里（cycle-88 实测 40+ 条 open，其中 35+ 条已 stale）。
 * `applyTriage` 只会关闭"当前健康读数证明条件已不复现"的提案，并写
 * resolvedAt/By/Evidence 审计字段——reproduced 与 unverifiable 一律保留。
 *
 * ## 运行方式（与归档探针同纪律：危险动作要人按）
 *
 *   预览   node node_modules/vitest/vitest.mjs run tests/manual/techDebtTriageProbe.test.ts
 *   执行   ANIC_DEBT_TRIAGE=1 node node_modules/vitest/vitest.mjs run tests/manual/techDebtTriageProbe.test.ts
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { analyzeSkillHealth } from '../../src/host/runtime/continuousLearning.ts';
import { listTechDebt, markTechDebtConsumed } from '../../src/host/evolution/techDebtQueue.ts';
import { applyTriage, triageTechDebt } from '../../src/host/evolution/techDebtTriage.ts';
import type { FlowTrackerState } from '../../src/host/runtime/flowTracker.ts';
import { readFileSync } from 'node:fs';

describe('tech-debt triage probe（默认只读）', () => {
  it('对照当前健康读数给出三态清单；仅 ANIC_DEBT_TRIAGE=1 时落盘', () => {
    const cyclesDir = join(process.cwd(), '.cycles');
    const health = analyzeSkillHealth(
      JSON.parse(readFileSync(join(cyclesDir, 'flow-tracker.json'), 'utf8')) as FlowTrackerState,
    );
    const listing = listTechDebt(cyclesDir);
    const decisions = triageTechDebt(listing.open.map((o) => ({ file: o.file, entry: o.entry })), health);

    const by = (v: string): string[] => decisions.filter((d) => d.verdict === v).map((d) => d.id);
    console.log('[triage] open=', listing.open.length, 'resolved=', listing.resolved.length, 'skipped=', listing.skipped.length);
    console.log('[triage] stale=', by('stale').length, 'reproduced=', by('reproduced').length, 'unverifiable=', by('unverifiable').length);
    for (const d of decisions) console.log(`[triage] ${d.verdict} | ${d.id} | ${d.evidence}`);

    const execute = process.env.ANIC_DEBT_TRIAGE === '1';
    if (!execute) {
      console.log('[triage] dry-run（未设 ANIC_DEBT_TRIAGE=1，零写入）');
      expect(listing.open.length).toBeGreaterThan(0); // 探针存在的前提：队列非空
      return;
    }
    const r = applyTriage(cyclesDir, decisions, 'agent:cycle-88-debt-triage');
    console.log('[triage] applied marked=', r.marked, 'errors=', JSON.stringify(r.errors));
    expect(r.errors).toEqual([]);
    // 兜底：如果历史上有同名提案已被人工以别的方式关闭（resolved=true），幂等不报错
    void markTechDebtConsumed;
  });
});
