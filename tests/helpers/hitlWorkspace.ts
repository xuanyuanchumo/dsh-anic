/**
 * HITL 测试夹具助手 —— git 仓库 / 绿账本 / cycle 目录的孪生播种。
 *
 * 三份测试（hitlThreePhase / hitlFlow / hitlDifferential）共享同一套播种
 * 语义，避免各写一份后语义漂移。账本播种走插件唯一实现 appendEntry
 * （包裹形态 + 哈希链，与技能 lib/ledger.mjs 正典写入者同形态）。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry } from '../../src/host/runtime/ledger.ts';

export const AUDIT_HEADER = '# 审计日志\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n';

/** 播种 git 仓库（本地身份 + 一次空提交——HEAD~1 探测在单提交仓库必然回退 git status）。 */
export function seedGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name anic-test', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email anic-test@local', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m baseline', { cwd: dir, stdio: 'pipe' });
}

/** 播种最新 cycle 目录（审计日志带表头与否可选）。 */
export function seedCycle(dir: string, withAuditLog = true): string {
  const cycle = join(dir, '.cycles', 'cycles', 'cycle-1');
  mkdirSync(cycle, { recursive: true });
  if (withAuditLog) writeFileSync(join(cycle, '审计日志.md'), AUDIT_HEADER);
  return cycle;
}

/** 播种全绿账本（末 4 条 G0-G3 全 PASS，哈希链有效）。 */
export function seedGreenLedger(dir: string): void {
  const cyclesDir = join(dir, '.cycles');
  for (const g of ['G0', 'G1', 'G2', 'G3']) {
    appendEntry(cyclesDir, { gate: g, gateName: `${g} 收敛门`, result: 'PASS', detail: 'All checks passed' });
  }
}

/** 追加单条账本条目（用于构造去重/乱序窗口等非标准形态，哈希链保持有效）。 */
export function appendLedgerEntry(dir: string, gate: string, result: 'PASS' | 'FAIL', detail?: string): void {
  appendEntry(join(dir, '.cycles'), { gate, gateName: `${gate} 收敛门`, result, detail });
}
