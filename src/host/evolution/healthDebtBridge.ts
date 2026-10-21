/**
 * 技能健康建议 → tech-debt 提案落盘通道（cycle-55 T-5501）。
 *
 * 为什么存在：改进建议有两条并行通道——
 *   1. PatchEngine：评估失败维度 → .cycles/tech-debt/*.json（有落盘有消费面）；
 *   2. continuousLearning：技能调用失败模式 → suggestions（只进面板/工具
 *      输出，**无落盘**——改进建议看完即散，无工作队列承载）。
 * 本模块把通道 2 合流进通道 1 的队列形态：severity 映射 + TechDebtEntry
 * 形状 + 原子写 + 同日幂等（同 id 已存在则跳过——健康分析是幂等纯函数，
 * 同一天的重复轮询不该堆出重复提案文件）。
 *
 * 设计裁决：
 * - severity 映射 critical→critical / warn→medium / info→low
 *   （SuggestionSeverity 无 high——warn 是中间档对应 debt 的 medium；
 *   info 是提示档对应 low；critical 同名直传）；
 * - dimension 字段用 `skill:<script>`（区分于评估域的 E1-E8/Q1-Q8——
 *   消费侧一眼可辨来源是技能健康而非评估维度）；
 * - 幂等粒度=文件名带日期（health-<YYYY-MM-DD>.json）：健康快照随轮询
 *   反复生成，同日同 id 只落一次；跨日 severity 恶化会产新文件（id 带
 *   日期后缀）——恶化可追踪；
 * - 「执行修复」仍是 R-31 纪律：本模块只产提案不改码，修复由人/上游
 *   agent 执行，经 markTechDebtConsumed 记账闭环（techDebtQueue 契约）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { TechDebtEntry, DebtSeverity } from './techDebtQueueImports.ts';
import type { ImprovementSuggestion } from '../runtime/continuousLearning.ts';

/** SuggestionSeverity → DebtSeverity（critical 同名 / warn→medium / info→low）。 */
export function mapSeverity(sev: ImprovementSuggestion['severity']): DebtSeverity {
  if (sev === 'critical') return 'critical';
  if (sev === 'warn') return 'medium';
  return 'low';
}

/** 单条建议 → TechDebtEntry（id 带日期后缀——跨日恶化产新提案可追踪）。 */
export function suggestionToEntry(s: ImprovementSuggestion, todayIso: string): TechDebtEntry {
  return {
    id: `health-${s.id}-${todayIso.slice(0, 10)}`,
    dimension: `skill:${s.script}`,
    severity: mapSeverity(s.severity),
    description: s.description,
    proposedAction: s.action,
    createdAt: todayIso,
    resolved: false,
  };
}

export interface HealthDebtResult {
  /** 本次新落盘的提案数。 */
  written: number;
  /** 同日已存在被幂等跳过的提案数。 */
  skipped: number;
  /** 落盘文件路径（无可落建议时为 null）。 */
  file: string | null;
}

/**
 * 健康建议 → tech-debt 提案文件（.cycles/tech-debt/health-<date>.json）。
 *
 * 幂等语义：读同日文件已有的 entry id 集合，同 id 跳过（written/skipped
 * 如实分开计数——面板与测试都能区分「新债」与「已登记」）。
 * 写失败抛给调用方（Post-Verify 纪律：写不进去不算落盘）。
 */
export function persistHealthSuggestionsAsDebt(
  cyclesDir: string,
  suggestions: ImprovementSuggestion[],
  nowIso: string,
): HealthDebtResult {
  if (suggestions.length === 0) return { written: 0, skipped: 0, file: null };
  const dir = join(cyclesDir, 'tech-debt');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fileName = `health-${nowIso.slice(0, 10)}.json`;
  const filePath = join(dir, fileName);

  // 读同日已有条目（损坏/不存在都按空集处理——重建语义）。
  let existing: TechDebtEntry[] = [];
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(raw)) existing = raw as TechDebtEntry[];
    } catch {
      existing = [];
    }
  }
  const knownIds = new Set(existing.map((e) => e.id));

  const fresh: TechDebtEntry[] = [];
  let skipped = 0;
  for (const s of suggestions) {
    const entry = suggestionToEntry(s, nowIso);
    if (knownIds.has(entry.id)) {
      skipped++;
      continue;
    }
    fresh.push(entry);
    knownIds.add(entry.id);
  }
  if (fresh.length === 0) return { written: 0, skipped, file: null };

  const merged = [...existing, ...fresh];
  atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  return { written: fresh.length, skipped, file: fileName };
}
