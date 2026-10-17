/**
 * HITL 审计（原生实现，H1-H4 语义与技能 hitl-audit.mjs:53-155 逐条对齐）。
 *
 * R3 阶段 1（语义对齐，已修）：此前插件侧四检查全部错位——
 *   旧 H1 = 敏感文件名扫描（无 .gitignore 保护判定） ← 技能 H1 的一半
 *   旧 H2 = .gitignore 三字面量覆盖检查              ← 技能 H1 的另一半
 *   旧 H3 = diff 新增行破坏性命令扫描                ← 技能没有的检查
 *   旧 H4 = verifyLedger 哈希链                      ← 技能 H4 的证据子项
 * 现在对齐后（技能侧语义为唯一基准）：
 *   H1 敏感数据保护：变更文件命中敏感模式（.env/credentials/secret/password/
 *      token/api_key 子串）且未被 .gitignore 保护（basename 或全路径）→ fail；
 *      另查 .env/.env.local/.env.production 落盘未保护。
 *   H2 破坏性操作/回滚保障：变更文件命中 [.gitignore/package.json/tsconfig/
 *      migration/schema]；>10 个 → 影响面过大 fail；有变更但无 .git 历史 →
 *      无回滚 fail；否则 pass（rollback available via git）。
 *      【插件增强，技能侧无】保留 diff 新增行破坏性命令扫描（rm -rf/DROP
 *      TABLE/DELETE FROM/TRUNCATE/git push --force/git reset --hard），命中即
 *      fail——方向是更严而非更松。
 *   H3 门禁全绿：账本末 4 条含 G0-G3 全部 PASS + 最新 cycle 有 审计日志.md。
 *   H4 门禁裁决仲裁：账本末 4 条存在 FAIL 且无 detail → 冲突 fail；
 *      【插件增强，INV-20 执行点】保留 verifyLedger 哈希链校验，断裂即 fail。
 *
 * circuit 字段 = 技能侧熔断语义（fail 且需人类介入）。技能的三段修复流程
 * （attemptFix → 重审 → incident 落盘 → 自主级降级）按 R3 路线图属阶段 4，
 * 本轮只对齐检查语义，不落盘、不改配置。
 *
 * 结构纪律：evaluateH1-H4 是纯函数核心（可单测），checkH1-H4 是 IO 包装
 * （git/fs 采集），与 presentCall/deriveEvidenceResult 同范式。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyLedger, loadLedger, type LedgerEntry } from '../runtime/ledger.ts';
import { CONVERGENCE_GATES, latestCycleDir } from '../llm/gateEvidence.ts';

const SENSITIVE_PATTERNS = ['.env', 'credentials', 'secret', 'password', 'token', 'api_key'];
const ENV_FILES = ['.env', '.env.local', '.env.production'];
const DESTRUCTIVE_FILE_PATTERNS = ['.gitignore', 'package.json', 'tsconfig', 'migration', 'schema'];
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /rm\s+-rf/i, /DROP\s+TABLE/i, /DELETE\s+FROM/i, /TRUNCATE/i,
  /git\s+push\s+--force/i, /git\s+reset\s+--hard/i,
];

export interface HitlResult {
  check: 'H1' | 'H2' | 'H3' | 'H4';
  passed: boolean;
  detail: string;
  findings?: string[];
  /** 熔断语义（对齐技能）：fail 且需人类介入（阶段 4 落盘 incident） */
  circuit: boolean;
}

// ── 纯函数核心 ────────────────────────────────────────────────────────────

/** H1：敏感文件未被 .gitignore 保护，或 .env 落盘未保护。 */
export function evaluateH1(changedFiles: string[], gitignoreContent: string, envFilesOnDisk: string[]): HitlResult {
  const sensitive = changedFiles.filter((f) => SENSITIVE_PATTERNS.some((p) => f.toLowerCase().includes(p)));
  const unprotected = sensitive.filter((f) => {
    const basename = f.split('/').pop() ?? f;
    return !gitignoreContent.includes(basename) && !gitignoreContent.includes(f);
  });
  if (unprotected.length > 0) {
    return { check: 'H1', passed: false, circuit: true, detail: `Sensitive files not in .gitignore: ${unprotected.join(', ')}`, findings: unprotected };
  }
  const unprotectedEnv = envFilesOnDisk.filter((f) => !gitignoreContent.includes(f));
  if (unprotectedEnv.length > 0) {
    return { check: 'H1', passed: false, circuit: true, detail: `Env files not in .gitignore: ${unprotectedEnv.join(', ')}`, findings: unprotectedEnv };
  }
  return { check: 'H1', passed: true, circuit: false, detail: 'No security-sensitive operations detected' };
}

/** H2：破坏性文件影响面 + 回滚可用性（+ 插件增强的破坏性命令扫描）。 */
export function evaluateH2(changedFiles: string[], hasGitHistory: boolean, destructiveCommandLines: string[]): HitlResult {
  // 插件增强：diff 新增行含破坏性命令 → 直接 fail（技能侧无此扫描）
  if (destructiveCommandLines.length > 0) {
    return { check: 'H2', passed: false, circuit: true, detail: `Destructive commands in diff: ${destructiveCommandLines.length} line(s)`, findings: destructiveCommandLines.slice(0, 10) };
  }
  const destructiveFiles = changedFiles.filter((f) => DESTRUCTIVE_FILE_PATTERNS.some((p) => f.toLowerCase().includes(p)));
  if (destructiveFiles.length > 0) {
    if (destructiveFiles.length > 10) {
      return { check: 'H2', passed: false, circuit: true, detail: `Large impact scope: ${destructiveFiles.length} destructive files changed`, findings: destructiveFiles.slice(0, 12) };
    }
    if (!hasGitHistory) {
      return { check: 'H2', passed: false, circuit: true, detail: 'No git history for rollback' };
    }
    return { check: 'H2', passed: true, circuit: false, detail: `Destructive ops detected (${destructiveFiles.length} files), rollback available via git` };
  }
  return { check: 'H2', passed: true, circuit: false, detail: 'No destructive operations detected' };
}

/** H3：账本末 4 条 G0-G3 全绿 + 最新 cycle 有 审计日志.md。 */
export function evaluateH3(latestCycle: string | null, ledgerExists: boolean, ledgerEntries: LedgerEntry[], auditLogExists: boolean): HitlResult {
  if (!latestCycle) return { check: 'H3', passed: false, circuit: true, detail: 'No cycle directory' };
  if (!ledgerExists) return { check: 'H3', passed: false, circuit: true, detail: 'No gate ledger (G0-G3 not evaluated)' };
  const recent = ledgerEntries.slice(-4);
  const passedGates = recent.filter((e) => e.result === 'PASS').map((e) => e.gate);
  if (!CONVERGENCE_GATES.every((g) => passedGates.includes(g))) {
    const missing = CONVERGENCE_GATES.filter((g) => !passedGates.includes(g));
    return { check: 'H3', passed: false, circuit: true, detail: `Gates not all green: missing ${missing.join(', ')}` };
  }
  if (!auditLogExists) return { check: 'H3', passed: false, circuit: true, detail: 'No audit log' };
  return { check: 'H3', passed: true, circuit: false, detail: 'All gates green, audit log present' };
}

/** H4：账本末 4 条 FAIL 无 detail = 裁决冲突；插件增强哈希链校验（INV-20）。 */
export function evaluateH4(
  ledgerExists: boolean,
  ledgerEntries: LedgerEntry[],
  chain: { ok: boolean; brokenAt: number | null; reason: string | null } | null,
): HitlResult {
  if (!ledgerExists) return { check: 'H4', passed: true, circuit: false, detail: 'No gate ledger (nothing to arbitrate)' };
  if (ledgerEntries.length === 0) return { check: 'H4', passed: true, circuit: false, detail: 'No gate entries to arbitrate' };
  const conflicts = ledgerEntries.slice(-4)
    .filter((e) => e.result === 'FAIL' && !e.detail)
    .map((e) => `${e.gate}: FAIL without detail`);
  if (conflicts.length > 0) {
    return { check: 'H4', passed: false, circuit: true, detail: `Gate arbitration issues: ${conflicts.join('; ')}`, findings: conflicts };
  }
  if (chain && !chain.ok) {
    return { check: 'H4', passed: false, circuit: true, detail: `Ledger chain broken at entry ${chain.brokenAt}: ${chain.reason ?? 'unknown reason'}`, findings: [`broken at ${chain.brokenAt}`] };
  }
  return { check: 'H4', passed: true, circuit: false, detail: 'Gate evidence sufficient, no conflicts' };
}

// ── IO 包装 ──────────────────────────────────────────────────────────────

/** 变更文件清单：git diff HEAD~1 优先，失败回退 git status --porcelain（技能同款回退链）。 */
function getGitChangedFiles(workspaceRoot: string): string[] {
  try {
    const out = execSync('git diff --name-only HEAD~1', { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    try {
      const out = execSync('git status --porcelain', { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      return out.trim().split('\n').filter(Boolean).map((line) => line.substring(3));
    } catch { return []; }
  }
}

export function checkH1(workspaceRoot: string): HitlResult {
  const changedFiles = getGitChangedFiles(workspaceRoot);
  const gitignorePath = join(workspaceRoot, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const envFilesOnDisk = ENV_FILES.filter((f) => existsSync(join(workspaceRoot, f)));
  return evaluateH1(changedFiles, gitignore, envFilesOnDisk);
}

export function checkH2(workspaceRoot: string): HitlResult {
  const changedFiles = getGitChangedFiles(workspaceRoot);
  const hasGitHistory = existsSync(join(workspaceRoot, '.git'));
  let destructiveCommandLines: string[] = [];
  try {
    const diff = execSync('git diff HEAD~1', { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    destructiveCommandLines = diff.split('\n')
      .filter((line) => line.startsWith('+') && DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(line)))
      .map((line) => line.slice(1).trim());
  } catch { /* no git */ }
  return evaluateH2(changedFiles, hasGitHistory, destructiveCommandLines);
}

export function checkH3(workspaceRoot: string): HitlResult {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const latest = latestCycleDir(cyclesDir);
  const ledgerExists = existsSync(join(cyclesDir, 'gates', 'ledger.json'));
  const entries = ledgerExists ? loadLedger(cyclesDir) : [];
  // latestCycleDir 返回完整路径（gateEngine.ts:44 同款陷阱注记）——直接 join 文件名，
  // 不能再拼 'cycles' 前缀（会把绝对路径当目录名拼出碎路径，恒 existsSync=false）
  const auditLogExists = latest !== null && existsSync(join(latest, '审计日志.md'));
  return evaluateH3(latest, ledgerExists, entries, auditLogExists);
}

export function checkH4(cyclesDir: string): HitlResult {
  const ledgerExists = existsSync(join(cyclesDir, 'gates', 'ledger.json'));
  if (!ledgerExists) return evaluateH4(false, [], null);
  const entries = loadLedger(cyclesDir);
  const v = verifyLedger(cyclesDir);
  return evaluateH4(true, entries, { ok: v.ok, brokenAt: v.brokenAt, reason: v.reason });
}

export function runHitlAudit(workspaceRoot: string): { checks: HitlResult[]; allPassed: boolean; anyCircuit: boolean } {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const checks = [checkH1(workspaceRoot), checkH2(workspaceRoot), checkH3(workspaceRoot), checkH4(cyclesDir)];
  return { checks, allPassed: checks.every((c) => c.passed), anyCircuit: checks.some((c) => c.circuit) };
}
