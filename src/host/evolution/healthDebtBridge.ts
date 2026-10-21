/**
 * 技能健康建议 → tech-debt 提案落盘通道（cycle-55 T-5501；cycle-56 T-5601 复活防御）。
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
 * - **债务复活防御（cycle-56 T-5601）**：id 带日期意味着「已消费」的债务
 *   次日会以新 id 复活（建议数据未变 → 新日期 → 新提案）。防御：落盘前
 *   扫全部 health-*.json，同 suggId 已 resolved 且当前 severity **未升级**
 *   的建议跳过；severity 升级（如 medium→critical）是真实恶化，重开新
 *   债务合理。open 态提案不受此防御影响（未偿还的债务保持视野内——
 *   既有跨日语义不变）；
 * - 「执行修复」仍是 R-31 纪律：本模块只产提案不改码，修复由人/上游
 *   agent 执行，经 markTechDebtConsumed 记账闭环（techDebtQueue 契约）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  /** 已 resolved 且 severity 未升级被复活防御跳过的提案数（cycle-56 T-5601）。 */
  skippedResolved: number;
  /** 落盘文件路径（无可落建议时为 null）。 */
  file: string | null;
}

/** 严重度秩（比较「是否升级」用——low<medium<high<critical）。 */
const SEV_RANK: Record<DebtSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * 从历史 health-*.json 提取「已 resolved 的建议 id → 落盘时的 severity」。
 *
 * entry.id 形如 `health-<suggId>-<YYYY-MM-DD>`——suggId 用正则剥前后缀还原。
 * 损坏文件跳过（读面容错——防御是增强不是门卫）。
 */
function resolvedSuggestionHistory(dir: string): Map<string, DebtSeverity> {
  const map = new Map<string, DebtSeverity>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('health-') || !f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (!Array.isArray(raw)) continue;
      for (const e of raw as TechDebtEntry[]) {
        if (typeof e?.id !== 'string' || e.resolved !== true) continue;
        const m = e.id.match(/^health-(.*)-\d{4}-\d{2}-\d{2}$/);
        const suggId = m?.[1];
        if (suggId === undefined) continue;
        // 同 suggId 多次 resolved：取最高 severity（最保守——升级判定用最强历史）。
        const prev = map.get(suggId);
        if (!prev || SEV_RANK[e.severity] > SEV_RANK[prev]) map.set(suggId, e.severity);
      }
    } catch {
      // 损坏文件跳过——防御不因脏数据失效
    }
  }
  return map;
}

/**
 * 健康建议 → tech-debt 提案文件（.cycles/tech-debt/health-<date>.json）。
 *
 * 幂等语义（两层）：
 * 1. 同日幂等：读同日文件已有的 entry id 集合，同 id 跳过；
 * 2. 复活防御（cycle-56）：扫全部 health-*.json，同 suggId 已 resolved 且
 *    当前 severity 未超过历史最高 → 跳过（已偿还的债务不因日期翻页复活）；
 *    severity 升级 → 重开新提案（真实恶化）。
 * written/skipped/skippedResolved 如实分开计数——面板与测试都能区分
 * 「新债/同日已登记/已偿还防御」。
 * 写失败抛给调用方（Post-Verify 纪律：写不进去不算落盘）。
 */
export function persistHealthSuggestionsAsDebt(
  cyclesDir: string,
  suggestions: ImprovementSuggestion[],
  nowIso: string,
): HealthDebtResult {
  if (suggestions.length === 0) return { written: 0, skipped: 0, skippedResolved: 0, file: null };
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
  const resolvedHist = resolvedSuggestionHistory(dir);

  const fresh: TechDebtEntry[] = [];
  let skipped = 0;
  let skippedResolved = 0;
  for (const s of suggestions) {
    const entry = suggestionToEntry(s, nowIso);
    if (knownIds.has(entry.id)) {
      skipped++;
      continue;
    }
    // 复活防御：同建议 id 已 resolved 且 severity 未升级 → 跳过。
    const suggId = s.id;
    const resolvedSev = resolvedHist.get(suggId);
    if (resolvedSev !== undefined && SEV_RANK[entry.severity] <= SEV_RANK[resolvedSev]) {
      skippedResolved++;
      continue;
    }
    fresh.push(entry);
    knownIds.add(entry.id);
  }
  if (fresh.length === 0) return { written: 0, skipped, skippedResolved, file: null };

  const merged = [...existing, ...fresh];
  atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  return { written: fresh.length, skipped, skippedResolved, file: fileName };
}
