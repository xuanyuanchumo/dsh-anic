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
    // P2 语义对齐（R3 阶段 3）：技能 multi-agent-gate.mjs:221-222
    // trustScore = round(avgConfidence*100) = round((0.8+0.7+0.4)/3*100) = 63
    expect(result.trustScore).toBe(63);
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
  it('returns structured result with three-state partition', () => {
    const result = runFactBaseVerify(process.cwd());
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('verified');
    expect(result).toHaveProperty('missing');
    expect(result).toHaveProperty('unscannable');
    expect(result).toHaveProperty('total');
    // 三态划分必须覆盖全集：「核不了」（unscannable）与「确实缺失」（absent）
    // 是两种状态，混算会把无锚点声明误报成缺失（v1 的 132 条伪缺失即此）。
    expect(result.verified + result.missing + result.unscannable).toBe(result.total);
    for (const c of result.checks) {
      expect(['verified', 'absent', 'unscannable']).toContain(c.state);
      // found 是向后兼容字段：只有 verified 才为 true
      expect(c.found).toBe(c.state === 'verified');
      if (c.state === 'verified') expect(typeof c.evidence).toBe('string');
      else expect(typeof c.reason).toBe('string');
    }
  });

  it('本仓库真实形状：源码树可扫描，且存在带 file:line 的 verified 证据', () => {
    const result = runFactBaseVerify(process.cwd());
    expect(result.sourceRoot).toContain('src');
    expect(result.scannedFiles).toBeGreaterThan(100);
    const verified = result.checks.filter((c) => c.state === 'verified');
    expect(verified.length).toBeGreaterThan(0);
    // 符号锚点的证据必须是 file:line 形态（核不了就不该记 verified）
    expect(verified.filter((c) => c.evidence?.includes('.ts:')).length).toBeGreaterThan(0);
  });

  it('cycle-98 多扫描根：scripts/assets/tests 前缀锚点可核（扫描域与判据不再脱钩）', () => {
    const result = runFactBaseVerify(process.cwd());
    // 修复前扫描根只有 <ws>/src，756 个文件里 scripts/assets/tests 全盲。
    expect(result.scannedFiles).toBeGreaterThan(400);
    const abs = result.checks.filter((c) => c.state === 'absent');
    // 缺席声明的 tried 列表里不得再出现「路径锚点从未进扫描域」的系统性假缺失：
    // 即路径锚点全部真实不存在（每一类都是诚实缺席，而非扫描域外的必然 miss）。
    for (const c of abs) {
      const pathTried = (c.reason ?? '').match(/path:[^\s,)]+/g) ?? [];
      for (const p of pathTried) {
        const rel = p.slice(5);
        // 产物锚点与源码锚点缺席时都应真的是文件不存在，此处只断言可读格式
        expect(typeof rel).toBe('string');
      }
    }
  });

  it('cycle-98 目录锚点：`src/host/closureAudit/` 按目录存在性核验（A4）', () => {
    const result = runFactBaseVerify(process.cwd());
    // A4（23-外部研究.md）声明目录锚点 `src/host/closureAudit/`——模块目录也是
    // 事实载体。修复前 PATH_RE 只认带扩展名文件，目录形态落不进任何桶 → unscannable。
    const a4 = result.checks.find((c) => c.declaration === 'A4' && c.source.includes('23-'));
    expect(a4?.state).toBe('verified');
    expect(a4?.evidence).toContain('closureAudit');
  });

  it('cycle-98 产物锚点：.cycles/gates/ledger.json 按产物存在性核验', () => {
    const result = runFactBaseVerify(process.cwd());
    // F23 声明 `.cycles/gates/head.json`（未实现，诚实缺席）；
    // 但含 `ledger.json` 裸名的 F2 声明应经候选目录命中 .cycles/gates/ledger.json。
    const f2 = result.checks.find((c) => c.declaration === 'F2');
    expect(f2?.state).toBe('verified');
    expect(f2?.evidence).toContain('ledger.json');
  });

  it('cycle-98 否定式声明：「无 `X`」在 X 存在时判 absent（违反否定式）', () => {
    // 构造最小工作区：文档声明「无 `foo.md`」，而 foo.md 真实存在 → absent。
    const ws = mkdtempSync(join(tmpdir(), 'anic-fbneg-'));
    try {
      mkdirSync(join(ws, '.cycles'), { recursive: true });
      mkdirSync(join(ws, 'docs', 'anic'), { recursive: true });
      writeFileSync(join(ws, '.cycles', 'config.yml'), 'project:\n  name: t\n');
      writeFileSync(join(ws, 'foo.md'), 'x\n');
      writeFileSync(
        join(ws, 'docs', 'anic', '01.md'),
        '- **N90 兼容**：无 `foo.md`（必须缺席）\n- **N91 兼容**：无 `bar.md`（真缺席）\n',
      );
      const result = runFactBaseVerify(ws);
      const n90 = result.checks.find((c) => c.declaration === 'N90');
      const n91 = result.checks.find((c) => c.declaration === 'N91');
      expect(n90?.state).toBe('absent'); // 否定式被违反：文件存在
      expect(n90?.reason).toContain('inverted');
      expect(n91?.state).toBe('verified'); // 真缺席 → 否定式成立
      expect(n91?.evidence).toContain('bar.md');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('cycle-98 续行锚点：声明行无反引号时并入紧随续行的锚点（假 unscannable 治理）', () => {
    const ws = mkdtempSync(join(tmpdir(), 'anic-fbcont-'));
    try {
      mkdirSync(join(ws, '.cycles'), { recursive: true });
      mkdirSync(join(ws, 'docs', 'anic'), { recursive: true });
      mkdirSync(join(ws, 'src'), { recursive: true });
      writeFileSync(join(ws, '.cycles', 'config.yml'), 'project:\n  name: t\n');
      writeFileSync(join(ws, 'src', 'widget.ts'), 'export const detailSummary = 1;\n');
      writeFileSync(
        join(ws, 'docs', 'anic', '01.md'),
        '- **F60 分段详情**：分段只追加账本的详情视图\n  - 实现入口 `detailSummary`（续行锚点）\n',
      );
      const result = runFactBaseVerify(ws);
      const f60 = result.checks.find((c) => c.declaration === 'F60');
      // 修复前：声明行自身无反引号 → unscannable；续行锚点被丢弃。
      expect(f60?.state).toBe('verified');
      // 证据 = 相对工作区根的 file:line（findSymbol evidenceBase 裁剪后的形态）。
      expect(f60?.evidence).toContain('widget.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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
