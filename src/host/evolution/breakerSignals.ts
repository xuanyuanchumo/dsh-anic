/**
 * 八熔断信号采集层（R3 路线图 阶段 1，对齐技能侧 org-status.mjs:25-82 CB1-CB8）。
 *
 * 此前 orgStatus 用 DEFAULT_BREAKER_INPUT（全零）喂 checkBreakers —— 纯函数
 * 实现了 8 条判定，但**输入永远为零**，真实工作区上熔断从未触发过。
 * 本层从真实文件采集信号：
 *
 *   熔断条件            信号源（技能侧对齐）                                BreakerInput 字段
 *   CB1 连续修复失败    .cycles/incidents/ 文件名含 'auto-fix-fail' 计数     consecutiveFixFails
 *   CB2 门禁存疑        账本末 4 条 result==='FAIL' 且 detail 空或含 ambiguous hasDoubt
 *   CB3 用户数据未隔离  incidents 文件名同时含 'H1' 与 'circuit'             userDataUnisolated
 *   CB4 破坏性不可回滚  incidents 文件名同时含 'H2' 与 'circuit'             destructiveNoRollback
 *   CB5 性能未恢复      band-history 末 2 条 band 均为 'alarm'（OVER_BUDGET） perfUnrecovered
 *   CB6 人类要求 L3     config.yml 原文 /human_override:\s*(L3|true)/i        humanRequestsL3
 *   CB7 无人值守超时    config.yml 原文 /session_timeout:\s*(\d+)/ > 24       unattendedHours
 *   CB8 资源上限        incidents 文件名含 'circuit' 计数（>3 触发）；        totalBreakerTrips
 *                        文件名含 'retry' 计数（>10 触发）                    totalRetries
 *
 * 诚实性约束（INV 纪律）：
 * - contextUsagePercent 恒 0：宿主不向插件暴露上下文占用，**没有来源就不伪造**
 *   （采集不到 ≠ 安全，但采集不到 ≠ 也不该编造数值触发熔断）。
 * - 所有读取 fail-safe：文件缺失/损坏 → 该信号归零，绝不让采集层自身炸掉 org-status。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BreakerInput } from './autonomyGovernor.ts';

/** 全零输入（等价于历史 DEFAULT_BREAKER_INPUT，供无任何信号源的工作区）。 */
export function zeroBreakerInput(): BreakerInput {
  return {
    consecutiveFixFails: 0,
    hasDoubt: false,
    userDataUnisolated: false,
    destructiveNoRollback: false,
    perfUnrecovered: false,
    humanRequestsL3: false,
    unattendedHours: 0,
    contextUsagePercent: 0,
    totalRetries: 0,
    totalBreakerTrips: 0,
  };
}

interface IncidentSignals {
  autoFixFails: number;
  h1Circuit: boolean;
  h2Circuit: boolean;
  circuitCount: number;
  retryCount: number;
}

/** 扫描 incidents 目录文件名（技能侧同款：只看文件名约定，不解析正文）。 */
function scanIncidents(incidentsDir: string): IncidentSignals {
  if (!existsSync(incidentsDir)) {
    return { autoFixFails: 0, h1Circuit: false, h2Circuit: false, circuitCount: 0, retryCount: 0 };
  }
  let files: string[] = [];
  try { files = readdirSync(incidentsDir); } catch { files = []; }
  const lower = files.map((f) => f.toLowerCase());
  return {
    autoFixFails: lower.filter((f) => f.includes('auto-fix-fail')).length,
    h1Circuit: lower.some((f) => f.includes('h1') && f.includes('circuit')),
    h2Circuit: lower.some((f) => f.includes('h2') && f.includes('circuit')),
    circuitCount: lower.filter((f) => f.includes('circuit')).length,
    retryCount: lower.filter((f) => f.includes('retry')).length,
  };
}

/** CB2：账本末 4 条中存在 result==='FAIL' 且 detail 空或含 'ambiguous'。 */
function ledgerHasDoubt(cyclesDir: string): boolean {
  const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
  if (!existsSync(ledgerPath)) return false;
  try {
    const raw: unknown = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    const entries = Array.isArray(raw) ? raw : (raw as { entries?: unknown[] }).entries;
    if (!Array.isArray(entries)) return false;
    const recent = entries.slice(-4) as Array<{ result?: unknown; detail?: unknown }>;
    return recent.some((e) =>
      e?.result === 'FAIL' &&
      (e.detail === undefined || e.detail === null || e.detail === '' ||
       String(e.detail).includes('ambiguous')));
  } catch { return false; }
}

/** CB5：band-history 末 2 条 band 均为 'alarm'（技能侧 OVER_BUDGET 对应物）。 */
function bandUnrecovered(workspaceRoot: string): boolean {
  const historyPath = join(workspaceRoot, '.cycles', 'band-history.json');
  if (!existsSync(historyPath)) return false;
  try {
    const history: unknown = JSON.parse(readFileSync(historyPath, 'utf-8'));
    if (!Array.isArray(history) || history.length < 2) return false;
    const recent = history.slice(-2) as Array<{ band?: unknown }>;
    return recent.every((e) => e?.band === 'alarm');
  } catch { return false; }
}

/** 读取 config.yml 原文（正则与技能侧逐字对齐；缺失 → 空串）。 */
function readConfigRaw(cyclesDir: string): string {
  const configPath = join(cyclesDir, 'config.yml');
  if (!existsSync(configPath)) return '';
  try { return readFileSync(configPath, 'utf-8'); } catch { return ''; }
}

/**
 * 从真实工作区采集八熔断信号。
 *
 * @param workspaceRoot 工作区根（含 .cycles/）
 * @param configRaw 覆盖 config 原文（测试注入口；缺省读 <root>/.cycles/config.yml）
 */
export function collectBreakerSignals(workspaceRoot: string, configRaw?: string): BreakerInput {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const incidents = scanIncidents(join(cyclesDir, 'incidents'));
  const raw = configRaw ?? readConfigRaw(cyclesDir);

  // CB6/CB7：与技能侧 org-status.mjs:63-74 的正则逐字对齐
  const humanOverride = raw.match(/human_override:\s*(L3|true)/i) !== null;
  const timeoutMatch = raw.match(/session_timeout:\s*(\d+)/);
  const unattendedHours = timeoutMatch ? parseInt(timeoutMatch[1] ?? '0', 10) : 0;

  return {
    consecutiveFixFails: incidents.autoFixFails,
    hasDoubt: ledgerHasDoubt(cyclesDir),
    userDataUnisolated: incidents.h1Circuit,
    destructiveNoRollback: incidents.h2Circuit,
    perfUnrecovered: bandUnrecovered(workspaceRoot),
    humanRequestsL3: humanOverride,
    unattendedHours: Number.isFinite(unattendedHours) ? unattendedHours : 0,
    // 宿主不暴露上下文占用：没有来源，恒 0，不伪造（诚实性注释见文件头）
    contextUsagePercent: 0,
    totalRetries: incidents.retryCount,
    totalBreakerTrips: incidents.circuitCount,
  };
}
