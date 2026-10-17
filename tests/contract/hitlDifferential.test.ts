/**
 * hitlDifferential —— 孪生夹具差分契约（R3 阶段 4 后半）。
 *
 * 三段修复是写动作（审计行 / .gitignore / incident），同目录双跑会双写——
 * 差分以孪生夹具完成：两份相同夹具各跑一侧（script spawn 真技能脚本
 * vs native hitlThreePhase），比对判定 / 落盘结果 / 副作用。
 *
 * 已文档化的刻意分歧（诚实纪律，不影响判定语义）：
 *  - incident 影响范围行：技能版无条件写「自主级别回退：L4 → L3」（但
 *    hitl-audit 并不执行降级）；插件版陈述「建议执行自主级回退」。
 *    差分只比对 incident 存在性与标题行，不比对影响范围正文。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHitlFlow } from '../../src/host/flows/hitlFlow.ts';
import { seedGitRepo, seedCycle, seedGreenLedger, AUDIT_HEADER } from '../helpers/hitlWorkspace.ts';

let fixtureA: string; // script 侧
let fixtureB: string; // native 侧

/** 孪生播种：对两份夹具执行同一播种函数。 */
function seedTwins(seed: (dir: string) => void): void {
  for (const d of [fixtureA, fixtureB]) seed(d);
}

beforeEach(() => {
  fixtureA = mkdtempSync(join(tmpdir(), 'anic-hitldiff-a-'));
  fixtureB = mkdtempSync(join(tmpdir(), 'anic-hitldiff-b-'));
});
afterEach(() => {
  rmSync(fixtureA, { recursive: true, force: true });
  rmSync(fixtureB, { recursive: true, force: true });
});

describe('hitl 孪生夹具差分（native vs script）', () => {
  it('H1 可修复熔断（gate=H1）：双侧修复后 pass —— .gitignore 逐字节一致', () => {
    seedTwins((d) => {
      seedGitRepo(d);
      writeFileSync(join(d, '.env'), 'SECRET=1');
    });
    const s = runHitlFlow(fixtureA, { mode: 'script', gate: 'H1' });
    const n = runHitlFlow(fixtureB, { mode: 'native', gate: 'H1' });
    expect(s.verdict).toBe('pass');
    expect(n.verdict).toBe('pass');
    expect(s.exitCode).toBe(n.exitCode);
    expect(s.state).toBe('PASSED');
    expect(n.state).toBe('PASSED');
    // 副作用逐字节：.gitignore 追加内容相同
    expect(readFileSync(join(fixtureA, '.gitignore'), 'utf-8')).toBe(readFileSync(join(fixtureB, '.gitignore'), 'utf-8'));
    // 判定结构对齐
    expect(n.fixes[0]?.success).toBe(true);
    expect(s.fixes[0]?.success).toBe(true);
    expect(n.rechecks[0]?.pass).toBe(true);
    expect(s.rechecks[0]?.pass).toBe(true);
  });

  it('H3 不可修复熔断（gate=H3）：双侧 circuit / exit 2 / 不重审不落 incident', () => {
    seedTwins((d) => { seedCycle(d, false); });
    const s = runHitlFlow(fixtureA, { mode: 'script', gate: 'H3' });
    const n = runHitlFlow(fixtureB, { mode: 'native', gate: 'H3' });
    expect(s.verdict).toBe('circuit');
    expect(n.verdict).toBe('circuit');
    expect(s.exitCode).toBe(2);
    expect(n.exitCode).toBe(2);
    expect(s.state).toBe('BLOCKED');
    expect(n.state).toBe('BLOCKED');
    expect(s.suggestedNextStep).toBe('autonomy-fallback');
    expect(n.suggestedNextStep).toBe('autonomy-fallback');
    // 技能同款：fix 失败不落 incident、不重审
    expect(n.incidents).toEqual([]);
    expect(s.incidents).toEqual([]);
    expect(existsSync(join(fixtureA, '.cycles', 'incidents'))).toBe(false);
    expect(existsSync(join(fixtureB, '.cycles', 'incidents'))).toBe(false);
  });

  it('H1 修复成功但重审仍熔断：双侧 circuit / exit 2 / incident 标题行一致', () => {
    seedTwins((d) => {
      seedGitRepo(d);
      writeFileSync(join(d, 'credentials.json'), '{}');
    });
    const s = runHitlFlow(fixtureA, { mode: 'script', gate: 'H1' });
    const n = runHitlFlow(fixtureB, { mode: 'native', gate: 'H1' });
    expect(s.verdict).toBe('circuit');
    expect(n.verdict).toBe('circuit');
    expect(s.exitCode).toBe(2);
    expect(n.exitCode).toBe(2);
    expect(s.state).toBe('BLOCKED');
    expect(n.state).toBe('BLOCKED');
    // incident 双侧都落盘（native 回传路径；script 侧以文件存在性验证）
    expect(n.incidents).toHaveLength(1);
    expect(existsSync(n.incidents[0]?.path ?? '')).toBe(true);
    const incidentsA = readdirSync(join(fixtureA, '.cycles', 'incidents'));
    expect(incidentsA).toHaveLength(1);
    const titleA = readFileSync(join(fixtureA, '.cycles', 'incidents', incidentsA[0]!), 'utf-8').split('\n')[0];
    const titleN = readFileSync(n.incidents[0]?.path ?? '', 'utf-8').split('\n')[0];
    expect(titleA).toBe(titleN); // '# 事故记录：H1 熔断'
    expect(titleA).toBe('# 事故记录：H1 熔断');
    // .gitignore 副作用逐字节（模式族追加）
    expect(readFileSync(join(fixtureA, '.gitignore'), 'utf-8')).toBe(readFileSync(join(fixtureB, '.gitignore'), 'utf-8'));
  });

  it('全绿夹具（gate=all）：双侧四门全过 —— 检查结构逐字段相等 + 审计行同追加', () => {
    seedTwins((d) => {
      seedGitRepo(d);
      seedCycle(d, true);
      seedGreenLedger(d);
    });
    const s = runHitlFlow(fixtureA, { mode: 'script' });
    const n = runHitlFlow(fixtureB, { mode: 'native' });
    expect(s.verdict).toBe('pass');
    expect(n.verdict).toBe('pass');
    expect(s.state).toBe('PASSED');
    expect(n.state).toBe('PASSED');
    // 检查视图逐字段相等（gate/pass/circuit/detail —— 技能与插件 detail 文本对齐）
    expect(n.checks).toEqual(s.checks);
    // 审计行：双侧各追加 4 行 PASS
    const logA = readFileSync(join(fixtureA, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    const logB = readFileSync(join(fixtureB, '.cycles', 'cycles', 'cycle-1', '审计日志.md'), 'utf-8');
    expect(logA.match(/\| H[1-4] \| PASS \|/g)).toHaveLength(4);
    expect(logB.match(/\| H[1-4] \| PASS \|/g)).toHaveLength(4);
    expect(logA.startsWith(AUDIT_HEADER.slice(0, -1))).toBe(true);
  });
});
