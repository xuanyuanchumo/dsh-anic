/**
 * hitlFix 单元测试 —— H1-H4 修复尝试函数（R3 阶段 4 后半）。
 *
 * 语义基准 = 技能 hitl-audit.mjs:190-284 逐字对齐（含 v1.8.3 的 H4
 * append-only 拒绝理由原文）。修复函数只对 circuit 门动作。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { attemptH1Fix, attemptH2Fix, attemptH3Fix, attemptH4Fix, writeHitlIncident, HITL_FIXERS } from '../../src/host/governance/hitlFix.ts';
import type { HitlResult } from '../../src/host/governance/hitlAudit.ts';

let dir: string;

function mk(over: Partial<HitlResult> & { check: HitlResult['check'] }): HitlResult {
  return { passed: false, detail: '', circuit: true, ...over };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anic-hitlfix-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('attemptH1Fix', () => {
  it('circuit 且 detail 含 .env：追加 .env 模式族到 .gitignore（不存在则创建）', () => {
    const r = attemptH1Fix(dir, mk({ check: 'H1', detail: 'Sensitive files not in .gitignore: .env' }));
    expect(r.success).toBe(true);
    expect(r.action).toBe('Added .env, .env.local, .env.production, .env.* to .gitignore');
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gi).toContain('# Auto-added by HITL audit');
    expect(gi).toContain('.env.*');
  });

  it('已有 .gitignore 时在既有内容后追加（不覆盖）', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    const r = attemptH1Fix(dir, mk({ check: 'H1', detail: 'Env files not in .gitignore: .env' }));
    expect(r.success).toBe(true);
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gi.startsWith('node_modules\n')).toBe(true);
    expect(gi).toContain('.env.local');
  });

  it('detail 含 credentials：追加凭据模式族', () => {
    const r = attemptH1Fix(dir, mk({ check: 'H1', detail: 'Sensitive files not in .gitignore: credentials.json' }));
    expect(r.success).toBe(true);
    expect(r.action).toBe('Added *.credentials, *.secret, *.key to .gitignore');
  });

  it('detail 不含任何已知模式：拒绝（需人工审查）', () => {
    const r = attemptH1Fix(dir, mk({ check: 'H1', detail: 'Sensitive files not in .gitignore: token.txt' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('cannot auto-fix: sensitive files need manual review');
  });

  it('非 circuit：无需修复', () => {
    const r = attemptH1Fix(dir, mk({ check: 'H1', detail: 'ok', circuit: false }));
    expect(r).toEqual({ success: true, action: 'no fix needed' });
  });
});

describe('attemptH2Fix', () => {
  it('无 git 历史：git init 基线提交成功', () => {
    writeFileSync(join(dir, 'README.md'), 'seed'); // 空仓库 git add -A 无可暂存 → 提交必败，先播种
    const r = attemptH2Fix(dir, mk({ check: 'H2', detail: 'No git history for rollback' }));
    expect(r.success).toBe(true);
    expect(r.action).toBe('Initialized git repo with baseline commit');
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('影响面过大：拒绝（需人类拆分判断）', () => {
    const r = attemptH2Fix(dir, mk({ check: 'H2', detail: 'Large impact scope: 12 destructive files changed' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('impact scope too large, requires human judgment to split changes');
  });

  it('其他 circuit：requires manual review', () => {
    const r = attemptH2Fix(dir, mk({ check: 'H2', detail: 'Destructive commands in diff: 2 line(s)' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('requires manual review');
  });
});

describe('attemptH3Fix', () => {
  it('无账本：拒绝并指向 gate-check', () => {
    const r = attemptH3Fix(dir, mk({ check: 'H3', detail: 'No gate ledger (G0-G3 not evaluated)' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('gate ledger missing, run gate-check.mjs first');
  });

  it('门禁未全绿：拒绝并给出缺的门', () => {
    const r = attemptH3Fix(dir, mk({ check: 'H3', detail: 'Gates not all green: missing G2, G3' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('gates G2, G3 not passed, run gate-check.mjs --gate G2, G3');
  });

  it('审计日志缺失且 cycle 目录存在：创建表头文件', () => {
    const cycle = join(dir, '.cycles', 'cycles', 'cycle-1');
    mkdirSync(cycle, { recursive: true });
    const r = attemptH3Fix(dir, mk({ check: 'H3', detail: 'No audit log' }));
    expect(r.success).toBe(true);
    expect(r.action).toBe('Created audit log file');
    const log = readFileSync(join(cycle, '审计日志.md'), 'utf-8');
    expect(log).toContain('| 时间 | 检查点 | 结果 | 详情 | 状态 |');
  });

  it('审计日志缺失但无 cycle 目录：拒绝', () => {
    const r = attemptH3Fix(dir, mk({ check: 'H3', detail: 'No audit log' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no cycle directory for audit log');
  });

  it('无 cycle 目录详情：走通用拒绝（技能同款 fallthrough）', () => {
    const r = attemptH3Fix(dir, mk({ check: 'H3', detail: 'No cycle directory' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('requires manual review');
  });
});

describe('attemptH4Fix', () => {
  it('FAIL 无 detail 熔断：append-only 拒绝（理由逐字对齐技能 v1.8.3）', () => {
    const gates = join(dir, '.cycles', 'gates');
    mkdirSync(gates, { recursive: true });
    writeFileSync(join(gates, 'ledger.json'), '{"entries":[],"chainHead":null}');
    const r = attemptH4Fix(dir, mk({ check: 'H4', detail: 'Gate arbitration issues: G1: FAIL without detail' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('ledger is append-only: re-run the failing gate with --record (or gate-ledger.mjs append) to add a corrected entry; mutating history would corrupt the hash chain');
  });

  it('无账本文件：no gate ledger', () => {
    const r = attemptH4Fix(dir, mk({ check: 'H4', detail: 'Gate arbitration issues: G1: FAIL without detail' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no gate ledger');
  });

  it('哈希链断裂熔断（非 FAIL-without-detail）：requires manual review', () => {
    const r = attemptH4Fix(dir, mk({ check: 'H4', detail: 'Ledger chain broken at entry 3: HASH_MISMATCH' }));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('requires manual review');
  });
});

describe('HITL_FIXERS 与 writeHitlIncident', () => {
  it('四门修复函数齐备', () => {
    expect(Object.keys(HITL_FIXERS).sort()).toEqual(['H1', 'H2', 'H3', 'H4']);
  });

  it('incident 落盘：标题与基本信息表同构，影响范围行诚实（不声称已降级）', () => {
    const p = writeHitlIncident(dir, 'H4', 'Gate arbitration issues: G1: FAIL without detail');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content.startsWith('# 事故记录：H4 熔断')).toBe(true);
    expect(content).toContain('| 检查点 | H4 |');
    expect(content).toContain('| 熔断条件 | 触发 |');
    expect(content).toContain('| 详情 | Gate arbitration issues: G1: FAIL without detail |');
    // 诚实纪律：不写技能版的「自主级别回退：L4 → L3」（hitl-audit 不执行降级）
    expect(content).not.toContain('L4 → L3');
    expect(content).toContain('建议执行自主级回退');
    expect(content).toContain('## 恢复条件');
  });

  it('incident 目录不存在时自动创建', () => {
    const p = writeHitlIncident(dir, 'H1', 'Sensitive files not in .gitignore: .env');
    expect(p).toContain(join('.cycles', 'incidents'));
    expect(existsSync(p)).toBe(true);
  });
});

describe('git 环境自证（H2 fix 的 execSync 路径）', () => {
  it('本机 git 可提交（全局或本地身份可用）', () => {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git -c user.name=t -c user.email=t@t.local commit --allow-empty -m x', { cwd: dir, stdio: 'pipe' });
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });
});
