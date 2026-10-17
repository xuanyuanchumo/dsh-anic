import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyBand, detectTrend, runBandDetection } from '../../src/host/evolution/bandDetector.ts';
import { aggregateVerdicts, heuristicEvaluate, runGate, GATE_NAMES, AGENT_ROLES } from '../../src/host/llm/multiAgentGate.ts';
import { runFixLoop, MAX_RETRIES } from '../../src/host/evolution/fixLoop.ts';
import { runHitlAudit, checkH1, checkH2, checkH3, checkH4 } from '../../src/host/governance/hitlAudit.ts';
import { runFactBaseVerify } from '../../src/host/governance/factBaseVerify.ts';
import { runPlanSync } from '../../src/host/governance/planSync.ts';
import { runOrgStatus } from '../../src/host/evolution/orgStatus.ts';
import { resolveSkillScriptsDir, isSkillInstalled, autoInstallSkill, listSkillScripts } from '../../src/host/skillInvoker.ts';

/**
 * 临时工作区一律落在**系统临时目录**，并在每个用例后删除。
 *
 * 修因（真实泄漏，非假想）：本文件此前写作
 * `const TMP = join(process.cwd(), 'tests', 'tmp-native')`，且**没有任何清理**
 * —— 每次运行都把 `runFixLoop` 的 `.cycles/tech-debt/fix-loop-*.json` 留在
 * 仓库树内，实测已累积 **87 个**残留文件。
 *
 * 它还有一个更隐蔽的连带后果：`tests/` 下的临时目录会被
 * `tests/contract/independenceGuard.test.ts` 的递归 walk 扫到（该守卫在模块
 * 加载期列目录、在用例执行期读文件），于是"目录被删掉"会让守卫以 ENOENT
 * 报红 —— 一个用例的脏写让另一个用例随机失败。仓库内其余 12 个测试文件
 * 早已统一用 `mkdtempSync(tmpdir())` + `afterEach(rmSync)`，本文件是唯一的例外。
 *
 * 另删：原第 14 行的 `MKDIR` 常量是死代码（全文件零调用），且用了 `require`。
 */
let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'anic-native-'));
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('bandDetector', () => {
  it('classifies bands correctly', () => {
    expect(classifyBand(0.9)).toBe('normal');
    expect(classifyBand(0.7)).toBe('normal');
    expect(classifyBand(0.6)).toBe('warn');
    expect(classifyBand(0.3)).toBe('alarm');
  });

  it('detects trends', () => {
    expect(detectTrend([0.5, 0.6, 0.7, 0.8])).toBe('improving');
    expect(detectTrend([0.8, 0.7, 0.6, 0.5])).toBe('degrading');
    expect(detectTrend([0.7, 0.7, 0.7])).toBe('stable');
    expect(detectTrend([])).toBe('stable');
  });
});

describe('multiAgentGate', () => {
  it('aggregates verdicts with threshold 2', () => {
    const v = [
      { role: 'planner' as const, verdict: 'approve' as const, confidence: 0.8, evidenceIds: ['e1'], notes: '', tier: 'Tier-1' as const },
      { role: 'implementer' as const, verdict: 'approve' as const, confidence: 0.7, evidenceIds: ['e2'], notes: '', tier: 'Tier-1' as const },
      { role: 'reviewer' as const, verdict: 'doubt' as const, confidence: 0.4, evidenceIds: ['e3'], notes: '', tier: 'Tier-1' as const },
    ];
    const result = aggregateVerdicts(v, 2);
    expect(result.verdict).toBe('approve');
    expect(result.trustScore).toBe(67);
    expect(result.passed).toBe(true);
  });

  it('rejects when any agent rejects and no threshold met', () => {
    const v = [
      { role: 'planner' as const, verdict: 'reject' as const, confidence: 0.8, evidenceIds: [], notes: '', tier: 'Tier-1' as const },
      { role: 'implementer' as const, verdict: 'approve' as const, confidence: 0.7, evidenceIds: [], notes: '', tier: 'Tier-1' as const },
      { role: 'reviewer' as const, verdict: 'doubt' as const, confidence: 0.4, evidenceIds: [], notes: '', tier: 'Tier-1' as const },
    ];
    expect(aggregateVerdicts(v, 2).verdict).toBe('reject');
  });

  it('heuristic evaluate returns doubt for empty evidence', () => {
    const result = heuristicEvaluate('planner', 'intent', []);
    expect(result.verdict).toBe('doubt');
    expect(result.tier).toBe('Tier-1');
  });

  it('heuristic evaluate approves with sufficient evidence', () => {
    const longEvidence = Array.from({ length: 12 }, (_, i) => ({ content: `test ${i} passed ✓ complete done PASS verified`, id: `e${i}` }));
    const result = heuristicEvaluate('reviewer', 'pr', longEvidence);
    expect(result.verdict).toBe('approve');
  });

  it('heuristic evaluate rejects with fail keywords', () => {
    const result = heuristicEvaluate('reviewer', 'pr', [
      { content: 'test suite failed FAIL error ❌ broken assertion missing module', id: 'e1' },
      { content: 'build failed FAIL error ❌ compilation failed type error', id: 'e2' },
    ]);
    expect(result.verdict).toBe('reject');
  });

  it('GATE_NAMES has 5 gates', () => {
    expect(GATE_NAMES).toHaveLength(5);
  });

  it('AGENT_ROLES has 3 roles', () => {
    expect(AGENT_ROLES).toHaveLength(3);
  });
});

describe('fixLoop', () => {
  it('converges immediately when verify passes', () => {
    const result = runFixLoop(TMP, () => ({ passed: true, report: 'all good' }));
    expect(result.converged).toBe(true);
    expect(result.finalVerdict).toBe('PASS');
    expect(result.totalRounds).toBe(1);
  });

  it('exhausts after max retries when always failing', () => {
    let count = 0;
    const result = runFixLoop(TMP, () => {
      count++;
      return { passed: false, report: `FAIL: test ${count} failed` };
    }, { maxRetries: 2 });
    expect(result.converged).toBe(false);
    expect(result.finalVerdict).toBe('EXHAUSTED');
    expect(result.techDebtGenerated.length).toBeGreaterThan(0);
  });

  it('MAX_RETRIES is 3', () => {
    expect(MAX_RETRIES).toBe(3);
  });
});

describe('hitlAudit', () => {
  it('checkH4 returns passed for missing ledger', () => {
    const result = checkH4(join(TMP, 'no-cycles'));
    expect(result.passed).toBe(true);
  });

  it('runHitlAudit returns 4 checks', () => {
    const result = runHitlAudit(process.cwd());
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((c) => c.check)).toEqual(['H1', 'H2', 'H3', 'H4']);
  });
});

describe('factBaseVerify', () => {
  it('returns structured result', () => {
    const result = runFactBaseVerify(process.cwd());
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('verified');
    expect(result).toHaveProperty('missing');
    expect(result).toHaveProperty('total');
    expect(result.verified + result.missing).toBe(result.total);
  });
});

describe('planSync', () => {
  it('returns synced=true for no cycles', () => {
    const result = runPlanSync(TMP);
    expect(result.synced).toBe(true);
    expect(result.tasksDeclared).toBe(0);
  });
});

describe('orgStatus', () => {
  it('returns full status structure', () => {
    const result = runOrgStatus(process.cwd(), {});
    expect(result).toHaveProperty('cycles');
    expect(result).toHaveProperty('ledger');
    expect(result).toHaveProperty('trust');
    expect(result).toHaveProperty('autonomy');
    expect(result).toHaveProperty('band');
    expect(result).toHaveProperty('flows');
    expect(result).toHaveProperty('timestamp');
  });

  it('P1 回归：currentBand 缺省时读配置 autonomy_level，而非硬编码 L2', () => {
    // 修复前：`options.currentBand ?? 'L2'` —— 配置声明 L4 时 org-status
    // 仍报 L2，与 snapshotCore 读同一配置得到的 L4 同屏矛盾（双真相源）。
    mkdirSync(join(TMP, '.cycles'), { recursive: true });
    writeFileSync(
      join(TMP, '.cycles', 'config.yml'),
      'project:\n  name: t\nmacro_cycle:\n  autonomy_level: L4\n',
      'utf-8',
    );
    const result = runOrgStatus(TMP, {});
    expect(result.autonomy.currentBand).toBe('L4');
    expect(result.autonomy.configuredBand).toBe('L4');
  });

  it('显式 currentBand 优先于配置（降级路径覆盖）', () => {
    mkdirSync(join(TMP, '.cycles'), { recursive: true });
    writeFileSync(
      join(TMP, '.cycles', 'config.yml'),
      'project:\n  name: t\nmacro_cycle:\n  autonomy_level: L4\n',
      'utf-8',
    );
    const result = runOrgStatus(TMP, { currentBand: 'L3' });
    expect(result.autonomy.currentBand).toBe('L3');
    expect(result.autonomy.configuredBand).toBe('L4');
  });

  it('配置缺失时兜底可观测（configuredBand 反映 loader 缺省）', () => {
    const result = runOrgStatus(TMP, {});
    // 无 .cycles/config.yml → loadWorkspaceConfig 走 missing 分支（L2 缺省）
    expect(['L1', 'L2', 'L3', 'L4']).toContain(result.autonomy.configuredBand);
    expect(result.autonomy.currentBand).toBe(result.autonomy.configuredBand);
  });

  it('R3 阶段 1：真实 incidents 信号流入 API 响应（熔断不再恒零）', () => {
    mkdirSync(join(TMP, '.cycles', 'incidents'), { recursive: true });
    writeFileSync(join(TMP, '.cycles', 'incidents', 'incident-H1-circuit-e2e.md'), '# incident\n', 'utf-8');
    const result = runOrgStatus(TMP, {});
    expect(result.autonomy.breakers).toContain('user_data_unisolated');
    // 严重熔断 → 动作至少 pause（decideAction 契约）
    expect(['pause', 'downgrade']).toContain(result.autonomy.action);
  });

  it('R3 阶段 1：band-history 分数序列驱动 trend（不再硬编码 stable）', () => {
    mkdirSync(join(TMP, '.cycles'), { recursive: true });
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.7, 0.8].map((score, i) => ({ cycle: i + 1, score, timestamp: '2026-01-01', band: 'warn' as const }))),
      'utf-8',
    );
    const improving = runOrgStatus(TMP, {});
    expect(improving.band.trend).toBe('improving');
    writeFileSync(
      join(TMP, '.cycles', 'band-history.json'),
      JSON.stringify([0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.7, 0.6].map((score, i) => ({ cycle: i + 1, score, timestamp: '2026-01-01', band: 'normal' as const }))),
      'utf-8',
    );
    const degrading = runOrgStatus(TMP, {});
    expect(degrading.band.trend).toBe('degrading');
  });
});

describe('skillInvoker inline', () => {
  it('listSkillScripts returns 15 scripts', () => {
    expect(listSkillScripts()).toHaveLength(15);
  });

  it('resolveSkillScriptsDir finds inline fallback', () => {
    const dir = resolveSkillScriptsDir(process.cwd());
    expect(dir).not.toBeNull();
  });

  it('isSkillInstalled returns boolean', () => {
    const result = isSkillInstalled(process.cwd());
    expect(typeof result).toBe('boolean');
  });
});
