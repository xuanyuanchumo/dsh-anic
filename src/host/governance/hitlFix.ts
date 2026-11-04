/**
 * HITL 三段修复 —— Phase 1 修复尝试函数（R3 阶段 4 后半）。
 *
 * 与技能 hitl-audit.mjs:190-284 逐字对齐：
 *  - H1：向 .gitignore 追加敏感模式族（.env 族 + credentials/secret/key）
 *  - H2：无 git 历史 → git init 基线提交；「影响面过大」→ 不可自动修复（需人拆分）
 *  - H3：审计日志缺失 → 创建空表头；门禁未全绿 → 不可修复（去跑 gate-check）
 *  - H4：**永远拒绝**——账本只追加（INV-1/INV-9），entry 的 hash 覆盖 detail
 *    字段，原地改写历史记录立即变成 HASH_MISMATCH（技能 v1.8.3 同款裁决：
 *    「修复」会自毁哈希链）。缺失证据必须以新条目补充，历史永不改写。
 *
 * 纪律：修复只作用于熔断（circuit=true）的检查点——这是技能「先修复后降级」
 * 的第一步；修复成功与否都如实返回，绝不掩盖失败。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { latestCycleDir } from '../llm/gateEvidence.ts';
import type { HitlResult } from './hitlAudit.ts';

/** 修复尝试结局（对齐技能 fixResult {success, action?, reason?}）。 */
export interface FixOutcome {
  success: boolean;
  action?: string;
  reason?: string;
}

/** H1 修复：向 .gitignore 追加缺失的敏感模式族（技能 attemptH1Fix:190-213）。 */
export function attemptH1Fix(workspaceRoot: string, result: HitlResult): FixOutcome {
  if (!result.circuit) return { success: true, action: 'no fix needed' };

  const gitignorePath = join(workspaceRoot, '.gitignore');
  let gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const patternsToAdd: string[] = [];
  if (result.detail.includes('.env')) {
    for (const p of ['.env', '.env.local', '.env.production', '.env.*']) {
      if (!gitignore.includes(p)) patternsToAdd.push(p);
    }
  }
  if (result.detail.includes('credentials') || result.detail.includes('secret') || result.detail.includes('password')) {
    for (const p of ['*.credentials', '*.secret', '*.key']) {
      if (!gitignore.includes(p)) patternsToAdd.push(p);
    }
  }

  if (patternsToAdd.length > 0) {
    gitignore += `\n# Auto-added by HITL audit\n${patternsToAdd.join('\n')}\n`;
    atomicWriteFileSync(gitignorePath, gitignore);
    return { success: true, action: `Added ${patternsToAdd.join(', ')} to .gitignore` };
  }

  return { success: false, reason: 'cannot auto-fix: sensitive files need manual review' };
}

/** H2 修复：无 git 历史时建基线；影响面过大不可自动拆分（技能 attemptH2Fix:216-235）。 */
export function attemptH2Fix(workspaceRoot: string, result: HitlResult): FixOutcome {
  if (!result.circuit) return { success: true, action: 'no fix needed' };

  if (result.detail.includes('No git history')) {
    try {
      // cycle-104：-c 兜底身份——CI/容器环境没有全局 user.email/user.name，
      // 裸 git commit 必败（run 41887328804 实录 Linux 假红；Windows 本地因装过
      // 全局身份而假绿）。修复链的自愈语义不该依赖宿主机是否恰好配过 git 身份，
      // -c 只在仓库级临时生效，不污染全局配置，已有身份时也不会覆盖用户配置
      // （git 以 -c 为准，等价于机器人提交署名，HITL 审计里如实可查）。
      execSync(
        'git init && git add -A && git -c user.name="anic-hitl-fix" -c user.email="anic-fix@localhost" '
        + 'commit -m "baseline for rollback"',
        {
          cwd: workspaceRoot, timeout: 10000, stdio: 'pipe', encoding: 'utf-8',
          windowsHide: true, // cycle-99b：H2 修复链的 git 调用不弹 cmd 窗口
        },
      );
      return { success: true, action: 'Initialized git repo with baseline commit' };
    } catch (e) {
      return { success: false, reason: `git init failed: ${(e as { message?: string }).message ?? 'unknown'}` };
    }
  }

  if (result.detail.includes('Large impact scope')) {
    return { success: false, reason: 'impact scope too large, requires human judgment to split changes' };
  }

  return { success: false, reason: 'requires manual review' };
}

/** H3 修复：审计日志缺失则创建；门禁缺失指向 gate-check（技能 attemptH3Fix:237-263）。 */
export function attemptH3Fix(workspaceRoot: string, result: HitlResult): FixOutcome {
  if (!result.circuit) return { success: true, action: 'no fix needed' };

  if (result.detail.includes('No gate ledger')) {
    return { success: false, reason: 'gate ledger missing, run gate-check.mjs first' };
  }

  if (result.detail.includes('Gates not all green')) {
    const missingMatch = result.detail.match(/missing\s+(.+)/);
    const missingGates = missingMatch ? missingMatch[1] : 'all';
    return { success: false, reason: `gates ${missingGates} not passed, run gate-check.mjs --gate ${missingGates}` };
  }

  if (result.detail.includes('No audit log')) {
    // latestCycleDir 返回完整路径——直接 join 文件名（同 gateEngine.ts:44 陷阱注记）
    const latest = latestCycleDir(join(workspaceRoot, '.cycles'));
    if (latest) {
      const auditLogPath = join(latest, '审计日志.md');
      if (!existsSync(auditLogPath)) {
        atomicWriteFileSync(auditLogPath, '# 审计日志\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n');
        return { success: true, action: 'Created audit log file' };
      }
    }
    return { success: false, reason: 'no cycle directory for audit log' };
  }

  return { success: false, reason: 'requires manual review' };
}

/**
 * H4 修复（技能 v1.8.3 attemptH4Fix:265-284 同款分支结构）。
 * 账本只追加（INV-1/INV-9）：entry 的 hash 覆盖 detail 字段，原地改写历史
 * 记录立即变成 HASH_MISMATCH——「修复」会自毁哈希链。缺失证据必须以新条目
 * 补充，历史永不改写。
 */
export function attemptH4Fix(workspaceRoot: string, result: HitlResult): FixOutcome {
  if (!result.circuit) return { success: true, action: 'no fix needed' };

  if (result.detail.includes('FAIL without detail')) {
    const ledgerPath = join(workspaceRoot, '.cycles', 'gates', 'ledger.json');
    if (!existsSync(ledgerPath)) return { success: false, reason: 'no gate ledger' };
    return {
      success: false,
      reason: 'ledger is append-only: re-run the failing gate with --record (or gate-ledger.mjs append) to add a corrected entry; mutating history would corrupt the hash chain',
    };
  }

  return { success: false, reason: 'requires manual review' };
}

/** 修复函数表（技能 FIX_FUNCTIONS 同表）。 */
export const HITL_FIXERS: Record<HitlResult['check'], (workspaceRoot: string, result: HitlResult) => FixOutcome> = {
  H1: attemptH1Fix,
  H2: attemptH2Fix,
  H3: attemptH3Fix,
  H4: attemptH4Fix,
};

/** incident 落盘（技能 recordIncident:180-188；标题与基本信息表逐字同构）。 */
export function writeHitlIncident(
  workspaceRoot: string,
  gate: 'H1' | 'H2' | 'H3' | 'H4',
  detail: string,
): string {
  const incidentsDir = join(workspaceRoot, '.cycles', 'incidents');
  if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incidentPath = join(incidentsDir, `incident-${timestamp}.md`);
  // 影响范围行刻意诚实（技能版无条件写「自主级别回退：L4 → L3」，但 hitl-audit
  // 本身并不执行降级——降级是 auto-fallback 流程的职责）。插件版陈述事实：
  // 熔断已触发 + 降级是建议的下一步，而非已发生的动作。基本信息表与标题
  // 逐字同构（incident 只在 circuit 门上写，熔断条件恒为「触发」）。
  const content = [
    `# 事故记录：${gate} 熔断`,
    '',
    '## 基本信息',
    '| 字段 | 值 |',
    '|---|---|',
    `| 时间 | ${timestamp} |`,
    `| 检查点 | ${gate} |`,
    '| 结果 | FAIL |',
    `| 详情 | ${detail} |`,
    '| 熔断条件 | 触发 |',
    '',
    '## 影响范围',
    `- 熔断检查点：${gate}（三段修复后仍失败）`,
    '- 需要人类介入诊断',
    '- 建议执行自主级回退（auto-fallback）——本流程只记录与建议，不自动降级',
    '',
    '## 恢复条件',
    '- 根因已定位且修复已验证',
    '- 人类确认问题已修复',
    '',
  ].join('\n');
  atomicWriteFileSync(incidentPath, content);
  return incidentPath;
}
