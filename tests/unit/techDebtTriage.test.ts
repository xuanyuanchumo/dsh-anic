/**
 * 技术债分诊单测（cycle-88）——「债务要有生命周期」的机器证明。
 *
 * ## 为什么这套判据值得存在
 *
 * 面板实况：`.cycles/tech-debt/` 17 个文件、40+ 条 open，其中 35+ 条是
 * `health-*` 每日快照派生的——**同一问题**（如 gate-check 成功率 63%）在
 * 10-21/22/23/24/26/27/28/29 各挂一条，问题修掉后也永远留在队列里。
 * 用户看到的是"很多技术债务问题"，真相是**债务没有生命周期**。
 *
 * 判据全部对照 `analyzeSkillHealth` 的当前输出（单一事实源）：
 *   fix-*   → healthy 即 stale；degraded 即 reproduced；insufficient 不可证
 *   speed-* → 非 slow 且超时率 ≤0.2 即 stale
 *   perf-*  → 平均耗时 < 30s 即 stale
 *   非 health 维度 → unverifiable（人工），**绝不假装能自动裁决**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSkillHealth } from '../../src/host/runtime/continuousLearning.ts';
import type { FlowRecord, FlowTrackerState } from '../../src/host/runtime/flowTracker.ts';
import { applyTriage, triageTechDebt, type TriageVerdict } from '../../src/host/evolution/techDebtTriage.ts';
import type { TechDebtEntry } from '../../src/host/evolution/patchEngine.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const iso = (m: number): string => new Date(NOW - m * 60_000).toISOString();

/** 健康夹具：gate-check healthy / auto-fix-loop slow / eval-runner expensive。 */
function healthFixture(): ReturnType<typeof analyzeSkillHealth> {
  const f = (over: Partial<FlowRecord>): FlowRecord => ({
    flowId: over.script + '-' + String(Math.random()).slice(2), script: over.script ?? 'x',
    workspace: 'D:/ws', args: [], status: 'DONE', startedAt: iso(1), exitCode: 0, durationMs: 100, ...over,
  } as FlowRecord);
  const flows: FlowRecord[] = [
    ...Array.from({ length: 8 }, () => f({ script: 'gate-check' })),                       // healthy
    ...Array.from({ length: 4 }, () => f({ script: 'auto-fix-loop', status: 'TIMEOUT', durationMs: 240000 })), // slow
    ...Array.from({ length: 3 }, () => f({ script: 'eval-runner', durationMs: 90000 })),   // expensive（≥MIN_SAMPLE）
    f({ script: 'workflow-state', status: 'FAILED', exitCode: 1, durationMs: 10,
      stderr: '[workflow-state] 只接受 2 个位置参数（<project-dir> <command>）', stdout: '' }),   // usage → 不污染
  ];
  return analyzeSkillHealth({ version: 1, flows } as unknown as FlowTrackerState, NOW);
}

function entry(id: string, dimension: string): TechDebtEntry {
  return { id, dimension, description: 'x', severity: 'warn', proposedAction: 'x', createdAt: iso(0), resolved: false };
}

describe('triageOne：三态判定', () => {
  const health = healthFixture();

  it('fix-*：healthy → stale（条件不再复现）', () => {
    expect(triageTechDebt([{ file: 'a.json', entry: entry('health-fix-gate-check-2026-10-21', 'skill:gate-check') }], health)[0]?.verdict)
      .toBe<TriageVerdict>('stale');
  });

  it('speed-*：慢的脚本 → reproduced；已经不慢 → stale', () => {
    const t = (id: string): TriageVerdict | undefined =>
      triageTechDebt([{ file: 'a.json', entry: entry(id, 'skill:auto-fix-loop') }], health)[0]?.verdict;
    expect(t('health-speed-auto-fix-loop-2026-10-29')).toBe<TriageVerdict>('reproduced');
    // 反向：同一个 speed 判据，脚本换成 healthy 的 gate-check 必须变 stale
    //（证明判据跟**数据**走，不是"speed 前缀恒 reproduced"）
    const t2 = triageTechDebt([{ file: 'a.json', entry: entry('health-speed-gate-check-2026-10-29', 'skill:gate-check') }], health)[0]?.verdict;
    expect(t2).toBe<TriageVerdict>('stale');
  });

  it('cycle-112：speed-* 与健康分档同口径——旧超时出近期窗口后判 stale', () => {
    /*
     * 被修缺陷：speed-* 此前读全史 timeoutRate。auto-fix-loop 真机 5/6 超时
     * （调用方预算杀死，根因已修）后即便近期全绿，提案仍被永久 reproduced。
     * 夹具：2 次旧超时（出 7 天窗）+ 8 次近期成功（近期窗口内）⇒ speed 提案 stale。
     */
    const f = (over: Partial<FlowRecord>): FlowRecord => ({
      flowId: 'x-' + String(Math.random()).slice(2), script: over.script ?? 'auto-fix-loop',
      workspace: 'D:/ws', args: [], status: 'DONE', startedAt: iso(1), exitCode: 0, durationMs: 80_000, ...over,
    } as FlowRecord);
    const flows: FlowRecord[] = [
      f({ status: 'TIMEOUT', startedAt: new Date(NOW - 10 * 864e5).toISOString(), exitCode: -1 }),
      f({ status: 'TIMEOUT', startedAt: new Date(NOW - 9 * 864e5).toISOString(), exitCode: -1 }),
      ...Array.from({ length: 8 }, () => f({})),
    ];
    const recentHealth = analyzeSkillHealth({ version: 1, flows } as unknown as FlowTrackerState, NOW);
    const af = recentHealth.scripts.find((s) => s.script === 'auto-fix-loop');
    expect(af?.timeoutRate, '全史仍含旧超时（白盒不隐藏）').toBeCloseTo(2 / 10, 5);
    expect(af?.recentTimeoutRate).toBe(0);
    const verdict = triageTechDebt([{ file: 'a.json', entry: entry('health-speed-auto-fix-loop-2026-10-21', 'skill:auto-fix-loop') }], recentHealth)[0]?.verdict;
    expect(verdict, '修复后速度类提案必须可关闭').toBe<TriageVerdict>('stale');
  });

  it('fix-*：脚本贵（expensive）但成功率已恢复 → 仍是 stale（成本问题归 perf-* 管）', () => {
    expect(triageTechDebt([{ file: 'a.json', entry: entry('health-fix-eval-runner-2026-10-29', 'skill:eval-runner') }], health)[0]?.verdict)
      .toBe<TriageVerdict>('stale');
  });

  it('perf-*：仍贵 → reproduced', () => {
    expect(triageTechDebt([{ file: 'a.json', entry: entry('health-perf-eval-runner-2026-10-29', 'skill:eval-runner') }], health)[0]?.verdict)
      .toBe<TriageVerdict>('reproduced');
  });

  it('非 health 维度 → unverifiable（人工），绝不假装能自动裁决', () => {
    expect(triageTechDebt([{ file: 'a.json', entry: entry('debt-F07-dual-track', 'Q7') }], health)[0]?.verdict)
      .toBe<TriageVerdict>('unverifiable');
  });

  /*
   * cycle-108（doc 26 §3 B1）：维度债务的裁决者是**评估报告本身**。
   * 没有 facts 时保持 unverifiable（上一条用例钉死）；有 facts 时按当前裁决行判。
   */
  it('维度债务 + 当前评估 PASS → stale（附报告路径与摘要证据）', () => {
    const facts = {
      cycle: 'cycle-108', reportPath: '.cycles/cycles/cycle-108/项目评估报告.md', digest: 'deadbeef',
      dimensions: { E4: 'PASS' as const }, gates: { G0: 'PASS' as const, G1: 'PASS' as const, G2: 'PASS' as const, G3: 'PASS' as const }, gatesAllPass: true,
    };
    const dec = triageTechDebt([{ file: 'debt-E4-2026-11-05.json', entry: entry('debt-E4-2026-11-05', 'E4') }], health, facts)[0];
    expect(dec?.verdict).toBe<TriageVerdict>('stale');
    expect(dec?.evidence).toContain('sha256:deadbeef');
    expect(dec?.evidence).toContain('cycle-108');
  });

  it('维度债务 + 当前评估 FAIL → reproduced（条件仍在）', () => {
    const facts = {
      cycle: 'cycle-108', reportPath: 'r.md', digest: 'x',
      dimensions: { E3: 'FAIL' as const }, gates: {}, gatesAllPass: false,
    };
    expect(triageTechDebt([{ file: 'f.json', entry: entry('debt-E3-x', 'E3') }], health, facts)[0]?.verdict)
      .toBe<TriageVerdict>('reproduced');
  });

  it('维度债务 + 当前评估 SKIP / 报告缺行 → unverifiable（没证据不等于通过）', () => {
    const facts = {
      cycle: 'cycle-108', reportPath: 'r.md', digest: 'x',
      dimensions: { E5: 'SKIP' as const }, gates: {}, gatesAllPass: false,
    };
    expect(triageTechDebt([{ file: 'f.json', entry: entry('debt-E5-x', 'E5') }], health, facts)[0]?.verdict)
      .toBe<TriageVerdict>('unverifiable');
    expect(triageTechDebt([{ file: 'f.json', entry: entry('debt-E6-x', 'E6') }], health, facts)[0]?.verdict)
      .toBe<TriageVerdict>('unverifiable');
  });

  it('非评估维度（自由维名）有 facts 仍 unverifiable —— 判据只对 E1-E8/Q1-Q8 生效', () => {
    const facts = {
      cycle: 'c', reportPath: 'r.md', digest: 'x', dimensions: {}, gates: {}, gatesAllPass: false,
    };
    expect(triageTechDebt([{ file: 'f.json', entry: entry('debt-X9-y', 'F07') }], health, facts)[0]?.verdict)
      .toBe<TriageVerdict>('unverifiable');
  });

  it('insufficient（无近期数据）→ unverifiable：没数据证明不了问题没了', () => {
    // org-status 全史 2 次、近期无数据
    expect(triageTechDebt([{ file: 'a.json', entry: entry('health-fix-org-status-2026-10-18', 'skill:org-status') }], health)[0]?.verdict)
      .toBe<TriageVerdict>('unverifiable');
  });
});

describe('applyTriage：只动 stale，写审计字段', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anic-triage-'));
    mkdirSync(join(dir, 'tech-debt'), { recursive: true });
    writeFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), JSON.stringify([
      entry('health-fix-gate-check-2026-10-21', 'skill:gate-check'),
      entry('health-speed-auto-fix-loop-2026-10-21', 'skill:auto-fix-loop'),
    ], null, 2));
  });
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('stale 被关闭并带 evidence；reproduced 保持 open', () => {
    const health = healthFixture();
    const entries = JSON.parse(readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf8')) as TechDebtEntry[];
    const decisions = triageTechDebt(entries.map((e) => ({ file: 'health-2026-10-21.json', entry: e })), health);
    const r = applyTriage(dir, decisions, 'auto-triage:cycle-88');
    expect(r.marked).toBe(1); // 只有 gate-check（healthy）
    expect(r.errors).toEqual([]);

    const after = (JSON.parse(readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf8')) as TechDebtEntry[]);
    const fixed = after.find((e) => e.id === 'health-fix-gate-check-2026-10-21');
    const speed = after.find((e) => e.id === 'health-speed-auto-fix-loop-2026-10-21');
    expect(fixed?.resolved).toBe(true);
    expect(fixed && 'resolvedBy' in fixed ? (fixed as { resolvedBy?: string }).resolvedBy : undefined)
      .toBe('auto-triage:cycle-88');
    expect(fixed && 'resolutionEvidence' in fixed ? String((fixed as { resolutionEvidence?: string }).resolutionEvidence) : '')
      .toContain('level=healthy');
    expect(speed?.resolved).toBe(false);
  });

  it('幂等：重复 apply 不重复计数（已 resolved 的跳过）', () => {
    const health = healthFixture();
    const entries = JSON.parse(readFileSync(join(dir, 'tech-debt', 'health-2026-10-21.json'), 'utf8')) as TechDebtEntry[];
    const decisions = triageTechDebt(entries.map((e) => ({ file: 'health-2026-10-21.json', entry: e })), health);
    applyTriage(dir, decisions, 't');
    const again = applyTriage(dir, decisions, 't');
    expect(again.marked).toBe(0);
  });

  it('空目录 / 空 decisions → no-op 不抛', () => {
    expect(applyTriage(dir, [], 't').marked).toBe(0);
    expect(applyTriage(join(dir, 'nonexistent'), decisionsForEmpty(), 't').marked).toBe(0);
    function decisionsForEmpty(): never[] { return []; }
    expect(existsSync(join(dir, 'tech-debt'))).toBe(true);
  });
});
