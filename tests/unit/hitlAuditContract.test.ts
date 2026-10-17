/**
 * HITL 审计 H1-H4 语义契约（R3 阶段 1：与技能 hitl-audit.mjs:53-155 对齐）。
 *
 * 此前插件侧四检查全部错位（R3 缺口矩阵 P0）：
 *   旧 H1 = 敏感文件名扫描（无 .gitignore 保护判定）
 *   旧 H2 = .gitignore 三字面量覆盖（其实是技能 H1 的子检查）
 *   旧 H3 = diff 破坏性命令扫描（技能没有的检查，现并入 H2 增强）
 *   旧 H4 = verifyLedger 哈希链（技能 H4 的证据子项，现保留为增强）
 *
 * 本套件钉死对齐后的语义（evaluateH1-H4 纯函数核心，零 IO）：
 * 任何一条被改回旧形态都必须立刻变红。
 */
import { describe, it, expect } from 'vitest';
import { evaluateH1, evaluateH2, evaluateH3, evaluateH4 } from '../../src/host/governance/hitlAudit.ts';
import type { LedgerEntry } from '../../src/host/runtime/ledger.ts';

function entry(gate: string, result: string, detail = ''): LedgerEntry {
  return { gate, gateName: gate, result, detail, timestamp: '2026-01-01T00:00:00Z', previousHash: '', hash: '' };
}

describe('H1 敏感数据保护（对齐技能 hitl-audit.mjs:53-87）', () => {
  it('敏感变更文件且未被 .gitignore 保护 → fail + circuit', () => {
    const r = evaluateH1(['src/config/credentials.json'], '', []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('credentials.json');
    expect(r.detail).toContain('not in .gitignore');
  });

  it('敏感文件被 .gitignore 保护（basename 命中）→ pass', () => {
    const r = evaluateH1(['secrets/token.txt'], 'token.txt\n', []);
    expect(r.passed).toBe(true);
  });

  it('敏感文件被 .gitignore 保护（全路径命中）→ pass', () => {
    const r = evaluateH1(['config/api_key.json'], 'config/api_key.json\n', []);
    expect(r.passed).toBe(true);
  });

  it('.env 落盘且未保护 → fail（与 git 变更无关的独立通道）', () => {
    const r = evaluateH1([], '', ['.env']);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('Env files not in .gitignore');
  });

  it('.env 落盘且已保护 → pass', () => {
    const r = evaluateH1([], '.env\n', ['.env']);
    expect(r.passed).toBe(true);
  });

  it('无敏感文件 → pass 且 circuit=false', () => {
    const r = evaluateH1(['src/main.ts', 'README.md'], '', []);
    expect(r.passed).toBe(true);
    expect(r.circuit).toBe(false);
  });
});

describe('H2 破坏性操作/回滚保障（对齐技能 hitl-audit.mjs:89-113 + 插件增强）', () => {
  it('无破坏性文件 → pass（与 git 历史无关，技能同款短路）', () => {
    const r = evaluateH2(['src/main.ts'], false, []);
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('No destructive operations detected');
  });

  it('破坏性文件 ≤10 且有 git 历史 → pass（rollback available）', () => {
    const r = evaluateH2(['package.json', '.gitignore'], true, []);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('rollback available via git');
    expect(r.detail).toContain('2 files');
  });

  it('破坏性文件 >10 → fail（影响面过大）', () => {
    const files = Array.from({ length: 11 }, (_, i) => `migrations/schema-${i}.sql`);
    const r = evaluateH2(files, true, []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('Large impact scope');
  });

  it('有破坏性文件但无 git 历史 → fail（无回滚）', () => {
    const r = evaluateH2(['package.json'], false, []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toBe('No git history for rollback');
  });

  it('【插件增强】diff 新增行含破坏性命令 → fail（技能侧无此扫描，方向更严）', () => {
    const r = evaluateH2([], true, ['rm -rf node_modules', 'DROP TABLE users']);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('Destructive commands in diff');
  });

  it('破坏性命令优先于文件面判定（最危险先报）', () => {
    const r = evaluateH2(['package.json'], true, ['git push --force origin main']);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('Destructive commands');
  });

  it('tsconfig 前缀子串命中（技能同款 lowercase includes）', () => {
    const r = evaluateH2(['tsconfig.client.json'], true, []);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('rollback available');
  });
});

describe('H3 门禁全绿 + 审计日志（对齐技能 hitl-audit.mjs:115-131）', () => {
  it('无 cycle 目录 → fail + circuit', () => {
    const r = evaluateH3(null, false, [], false);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toBe('No cycle directory');
  });

  it('有 cycle 但无账本 → fail（G0-G3 not evaluated）', () => {
    const r = evaluateH3('cycle-1', false, [], false);
    expect(r.passed).toBe(false);
    expect(r.detail).toBe('No gate ledger (G0-G3 not evaluated)');
  });

  it('账本末 4 条非全绿 → fail 列出缺失门', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'FAIL', 'build failed'), entry('G3', 'PASS')];
    const r = evaluateH3('cycle-1', true, entries, true);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('missing G2');
  });

  it('账本末 4 条全绿 + 审计日志在位 → pass', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'PASS'), entry('G3', 'PASS')];
    const r = evaluateH3('cycle-1', true, entries, true);
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('All gates green, audit log present');
  });

  it('全绿但缺审计日志 → fail（No audit log）', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'PASS'), entry('G3', 'PASS')];
    const r = evaluateH3('cycle-1', true, entries, false);
    expect(r.passed).toBe(false);
    expect(r.detail).toBe('No audit log');
  });

  it('per-gate-latest：G2 最新条目 FAIL → fail（后写覆盖为最新）', () => {
    const entries = [
      entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'PASS'), entry('G3', 'PASS'),
      entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'FAIL', 'regression'), entry('G3', 'PASS'),
    ];
    const r = evaluateH3('cycle-1', true, entries, true);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('missing G2');
  });

  it('per-gate-latest 去重免疫（v1.8.4-fork）：末 4 条窗口缺 G1 但每门最新全 PASS → pass（旧窗口语义误熔断）', () => {
    // 场景还原：gate-check 对 result+detail 全同的门去重不重录——cycle-1 全绿四门后，
    // cycle-2 只有 G0 两次 detail 变化被录入（G1/G2/G3 detail 全同被去重），末 4 条窗口
    // [G2, G3, G0', G0''] 缺 G1。每门最新全 PASS，per-gate-latest 判定应为 pass。
    const entries = [
      entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'PASS'), entry('G3', 'PASS'),
      entry('G0', 'PASS', 'new detail A'), entry('G0', 'PASS', 'new detail B'),
    ];
    const r = evaluateH3('cycle-1', true, entries, true);
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('All gates green, audit log present');
  });

  it('per-gate-latest：某门从未录入 → fail 列出缺失门', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'PASS'), entry('G2', 'PASS')];
    const r = evaluateH3('cycle-1', true, entries, true);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('missing G3');
  });
});

describe('H4 门禁裁决仲裁（对齐技能 hitl-audit.mjs:133-155 + 插件增强）', () => {
  it('无账本 → pass（nothing to arbitrate，与旧 H4 一致）', () => {
    const r = evaluateH4(false, [], null);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('nothing to arbitrate');
  });

  it('账本空 → pass（no gate entries）', () => {
    const r = evaluateH4(true, [], { ok: true, brokenAt: null, reason: null });
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('No gate entries to arbitrate');
  });

  it('末 4 条存在 FAIL 且无 detail → 冲突 fail', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'FAIL'), entry('G2', 'PASS'), entry('G3', 'PASS')];
    const r = evaluateH4(true, entries, { ok: true, brokenAt: null, reason: null });
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('G1: FAIL without detail');
  });

  it('FAIL 但有 detail → 非冲突（有证据的失败可仲裁）', () => {
    const entries = [entry('G1', 'FAIL', 'build failed with exit 1')];
    const r = evaluateH4(true, entries, { ok: true, brokenAt: null, reason: null });
    expect(r.passed).toBe(true);
  });

  it('【插件增强】哈希链断裂 → fail（INV-20 执行点，技能侧无）', () => {
    const entries = [entry('G0', 'PASS'), entry('G1', 'PASS')];
    const r = evaluateH4(true, entries, { ok: false, brokenAt: 1, reason: 'hash mismatch at index 1' });
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('Ledger chain broken at entry 1');
  });

  it('无冲突 + 链有效 → pass', () => {
    const entries = [entry('G0', 'PASS', 'ok'), entry('G1', 'PASS', 'ok')];
    const r = evaluateH4(true, entries, { ok: true, brokenAt: null, reason: null });
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('Gate evidence sufficient, no conflicts');
  });

  it('冲突优先于链断裂报告（裁决冲突是 H4 主语义）', () => {
    const entries = [entry('G1', 'FAIL')];
    const r = evaluateH4(true, entries, { ok: false, brokenAt: 0, reason: 'hash mismatch' });
    expect(r.detail).toContain('FAIL without detail');
  });
});
