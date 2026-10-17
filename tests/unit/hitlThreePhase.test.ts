/**
 * hitlThreePhase 单元测试 —— 原生三段编排（R3 阶段 4 后半）。
 *
 * 判定语义基准 = 技能 hitl-audit.mjs:293-383 三段主流程：
 *   全过（含修复后全过）→ pass/exit 0；有败无熔断 → fail/exit 1；
 *   修复尝试后仍熔断 → circuit/exit 2 + suggestedNextStep。
 * 落盘纪律：审计行只追加到已存在日志；incident 只属 Phase 2 仍熔断门。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHitlThreePhaseNative } from '../../src/host/governance/hitlThreePhase.ts';
import { seedGitRepo, seedCycle, seedGreenLedger, AUDIT_HEADER } from '../helpers/hitlWorkspace.ts';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-hitl3p-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('runHitlThreePhaseNative', () => {
  it('全绿夹具（gate=all）：verdict pass / exit 0 / 四门全过 / 零修复', () => {
    seedGitRepo(dir);
    seedCycle(dir, true);
    seedGreenLedger(dir);
    const r = runHitlThreePhaseNative(dir, 'all');
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.checks.map((c) => c.gate)).toEqual(['H1', 'H2', 'H3', 'H4']);
    expect(r.checks.every((c) => c.pass && !c.circuit)).toBe(true);
    expect(r.fixes).toEqual([]);
    expect(r.rechecks).toEqual([]);
    expect(r.incidents).toEqual([]);
    expect(r.suggestedNextStep).toBeNull();
    expect(r.auditLogPath).toContain('审计日志.md');
  });

  it('H1 可修复熔断（gate=H1）：fix → re-audit → pass（exit 0）', () => {
    seedGitRepo(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=1'); // 未跟踪敏感文件，无 .gitignore
    const r = runHitlThreePhaseNative(dir, 'H1');
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.circuits).toEqual(['H1']);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]?.gate).toBe('H1');
    expect(r.fixes[0]?.success).toBe(true);
    expect(r.rechecks).toHaveLength(1);
    expect(r.rechecks[0]?.pass).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('.env.*');
  });

  it('H3 不可修复熔断（gate=H3）：fix 失败 → circuit / exit 2 / 不重审不落 incident', () => {
    seedCycle(dir, false); // cycle 目录在、账本缺 → 'No gate ledger'
    const r = runHitlThreePhaseNative(dir, 'H3');
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.circuits).toEqual(['H3']);
    expect(r.fixes[0]?.success).toBe(false);
    expect(r.fixes[0]?.reason).toBe('gate ledger missing, run gate-check.mjs first');
    expect(r.rechecks).toEqual([]);
    expect(r.incidents).toEqual([]); // 技能同款：incident 只属 Phase 2 仍熔断门
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
  });

  it('H1 修复成功但重审仍熔断（credentials 模式族不匹配 basename）：Phase 2 落 incident', () => {
    seedGitRepo(dir);
    writeFileSync(join(dir, 'credentials.json'), '{}'); // '*.credentials' 不匹配 basename 'credentials.json'
    const r = runHitlThreePhaseNative(dir, 'H1');
    expect(r.verdict).toBe('circuit');
    expect(r.exitCode).toBe(2);
    expect(r.fixes[0]?.success).toBe(true); // fix 添加了模式族（技能同款的成功判据）
    expect(r.rechecks).toHaveLength(1);
    expect(r.rechecks[0]?.circuit).toBe(true);
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]?.gate).toBe('H1');
    expect(existsSync(r.incidents[0]?.path ?? '')).toBe(true);
    expect(r.suggestedNextStep).toBe('autonomy-fallback');
  });

  it('审计日志存在（带表头）：Phase 0 每门追加一行 PASS/FAIL', () => {
    seedGitRepo(dir);
    const cycle = seedCycle(dir, true);
    seedGreenLedger(dir);
    runHitlThreePhaseNative(dir, 'all');
    const log = readFileSync(join(cycle, '审计日志.md'), 'utf-8');
    expect(log).toContain('| H1 | PASS |');
    expect(log).toContain('| H3 | PASS |');
    expect(log).toContain('| 正常 |');
    expect(log.match(/\| H[1-4] \| PASS \|/g)).toHaveLength(4);
  });

  it('审计日志存在但无表头：补「HITL 自动审计记录」表头后再追加', () => {
    seedGitRepo(dir);
    const cycle = seedCycle(dir, true);
    writeFileSync(join(cycle, '审计日志.md'), '# 别的内容\n');
    seedGreenLedger(dir);
    runHitlThreePhaseNative(dir, 'all');
    const log = readFileSync(join(cycle, '审计日志.md'), 'utf-8');
    expect(log).toContain('## HITL 自动审计记录');
    expect(log).toContain('| H1 | PASS |');
  });

  it('审计日志不存在：Phase 0 行记录静默跳过，文件由 H3 fix 创建后 Phase 2 行落盘', () => {
    seedGitRepo(dir);
    seedCycle(dir, false);
    seedGreenLedger(dir);
    const r = runHitlThreePhaseNative(dir, 'all');
    // H3 熔断（No audit log）→ fix 创建审计日志 → 重审全绿 → pass
    expect(r.verdict).toBe('pass');
    expect(r.fixes.some((f) => f.gate === 'H3' && f.success)).toBe(true);
    expect(r.auditLogPath).not.toBeNull();
    const log = readFileSync(r.auditLogPath ?? 'x', 'utf-8');
    expect(log).toContain('| 时间 | 检查点 | 结果 | 详情 | 状态 |');
    // Phase 0 时文件尚不存在 → H1/H2/H4 初始行被静默跳过（技能同款）
    expect(log).not.toContain('| H1 | PASS |');
    expect(log).not.toContain('| H2 | PASS |');
    expect(log).not.toContain('| H4 | PASS |');
    // Phase 2 重审时文件已由 fix 创建 → H3 行落盘
    expect(log).toContain('| H3 | PASS |');
  });

  it('无 cycle 目录：auditLogPath=null，判定不受影响', () => {
    seedGitRepo(dir);
    const r = runHitlThreePhaseNative(dir, 'H1');
    expect(r.auditLogPath).toBeNull();
    expect(r.verdict).toBe('pass'); // .env 不存在 → H1 本来就绿
  });
});
