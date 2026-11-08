/**
 * 技术债**分诊**（cycle-88）——把"健康快照派生"的债务提案与**当前事实**对账。
 *
 * ## 问题（用户在面板看到的实况）
 *
 * `.cycles/tech-debt/` 里 17 个文件、40+ 条 open 提案，其中绝大多数是
 * `health-*` 系列：**每天的自举评估都会把当时的健康问题拍成一条新提案**，
 * 而问题被修掉之后旧提案**永远留在队列里**——gate-check 已经 healthy 了，
 * 面板上还挂着 10-21/22/23/24/26/27/28/29 八条"gate-check 近期成功率 63%/50%/38%"。
 *
 * 这不是"债务多"，是**债务没有生命周期**：测量类提案的裁决者本就是测量本身，
 * 条件不再复现就该关（带证据），不需要人工再判一次——那正是 R-31"机器不代劳"
 * 的**边界**：人工裁决留给会改变产品行为的修复决策，测量复现与否是可复算的事实。
 *
 * ## 三态（不是二态）
 *
 *   - `stale`        条件不再复现（对照**当前**健康读数逐项给出证据）→ 可自动关闭；
 *   - `reproduced`   条件仍在（同样给出当前读数）→ 保留，且证据说明"为什么还没好"；
 *   - `unverifiable` 无法用健康读数判定（非 health 维度，如 debt-F07/Q7）
 *                    → 保留并写明"需要人工"，**绝不假装能自动裁决**。
 *
 * ## 判据（全部对照 `analyzeSkillHealth` 的当前输出）
 *
 *   `health-fix-<script>-*`   stale ⇔ 该脚本 level === 'healthy'
 *   `health-speed-<script>-*` stale ⇔ level !== 'slow' 且 timeoutRate ≤ 0.2
 *   `health-perf-<script>-*`  stale ⇔ avgDurationMs < 30000（EXPENSIVE 阈值）
 *   `E1-E8` / `Q1-Q8` 维度债务   stale ⇔ 最新活跃循环评估报告里该维度 = PASS
 *                              reproduced ⇔ FAIL；SKIP/无行/无报告 ⇒ unverifiable
 *   其余（debt-F07 之类的自由维度）  ⇒ unverifiable
 *
 * cycle-108（doc 26 §3 B1 闭环）：维度债务此前一律 unverifiable，于是
 * `debt-E4-*`（根因早已修复、E4 实测 PASS）永远悬着并污染下一轮自举判断。
 * 评估维度债务的裁决者就是**评估本身**——与 health 债务的裁决者是健康读数是同一结构。
 *
 * 纯函数判定（`triageTechDebt`）与落盘（`applyTriage`）分离：判定可单测，
 * 落盘复用 `techDebtQueue` 的文件改写纪律（原子写 + 形态保持 + 审计字段）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { TechDebtEntry } from './patchEngine.ts';
import type { SkillHealthReport, ScriptHealth } from '../runtime/continuousLearning.ts';
import type { DebtFacts } from './debtFacts.ts';

/** 与 continuousLearning 的阈值同源（不 import 私有常量，数值对齐由测试钉住）。 */
const SLOW_TIMEOUT_RATE = 0.2;
const EXPENSIVE_DURATION_MS = 30000;

export type TriageVerdict = 'stale' | 'reproduced' | 'unverifiable';

export interface TriageDecision {
  id: string;
  file: string;
  verdict: TriageVerdict;
  /** 人读证据：当前健康读数怎么支持这个裁决（关闭/保留都有据）。 */
  evidence: string;
}

/** 从提案 id/dimension 里解析目标脚本（`health-fix-gate-check-2026-10-21` + `skill:gate-check`）。 */
function scriptOf(entry: TechDebtEntry): string | null {
  if (entry.dimension.startsWith('skill:')) return entry.dimension.slice('skill:'.length) || null;
  return null;
}

/** 评估维度（E1-E8 / Q1-Q8）——只有这两族可以用「评估报告」裁决。 */
const DIMENSION_RE = /^[EQ][1-8]$/;

/** 维度债务证据：必须点名**是哪份报告**（路径 + 内容摘要），否则不可复算。 */
function dimensionEvidence(dim: string, verdict: string, facts: DebtFacts): string {
  const where = facts.reportPath === null ? '无活跃评估报告' : facts.reportPath;
  const digest = facts.digest === null ? '—' : facts.digest;
  const gates = facts.gatesAllPass ? '；G0-G3 全 PASS（佐证）' : '';
  return `${facts.cycle ?? '未知循环'} 维度 ${dim} = ${verdict}（${where} · sha256:${digest}）${gates}`;
}

/** 单条提案的分诊判定（纯函数）。 */
export function triageOne(
  entry: TechDebtEntry,
  health: SkillHealthReport,
  facts?: DebtFacts,
): TriageVerdict {
  const script = scriptOf(entry);
  if (script === null) {
    // 维度债务：没有事实（未读报告 / 非维度）时保持 unverifiable —— 不猜。
    if (facts === undefined || !DIMENSION_RE.test(entry.dimension)) return 'unverifiable';
    const v = facts.dimensions[entry.dimension];
    if (v === 'PASS') return 'stale';
    if (v === 'FAIL') return 'reproduced';
    return 'unverifiable'; // SKIP / 报告缺行：没证据不等于通过
  }
  const h: ScriptHealth | undefined = health.scripts.find((x) => x.script === script);
  if (h === undefined) return 'unverifiable';

  if (entry.id.startsWith('health-fix-')) {
    /*
     * "成功率低"类的复现判据是**有效成功率本身**，不是 level：
     * 一个脚本可以同时"成功率 100%"和"贵"（expensive）——后者由 perf-* 提案负责，
     * 若因 level=expensive 就把 fix-* 判成 unverifiable，等于让"成本问题"掩盖
     * "成功率问题已修复"这个事实（cycle-88 实测：eval-runner 5 条 fix-* 被埋）。
     * insufficient 仍不可证——"没数据"证明不了"问题没了"。
     */
    if (h.level === 'healthy') return 'stale';
    if (h.level === 'expensive'
      && h.recentEffectiveRate !== undefined && h.recentEffectiveRate >= 0.8) return 'stale';
    return h.level === 'degraded' ? 'reproduced' : 'unverifiable';
  }
  if (entry.id.startsWith('health-speed-')) {
    // cycle-112：与健康分档**同口径**——用近期窗口超时率（无近期样本回落全史）。
    // 旧实现读全史 timeoutRate：预算不足被掐断的旧记录会让提案永久 reproduced，
    // 即便根因已修、近期全绿（与 continuousLearning 的 slow 判据同一族缺陷）。
    const rate = h.recentTimeoutRate ?? h.timeoutRate;
    return rate <= SLOW_TIMEOUT_RATE && h.level !== 'slow' ? 'stale' : 'reproduced';
  }
  if (entry.id.startsWith('health-perf-')) {
    return h.avgDurationMs < EXPENSIVE_DURATION_MS ? 'stale' : 'reproduced';
  }
  return 'unverifiable';
}

/** 证据串（stale 与 reproduced 都要能回答"凭什么"）。 */
function evidenceOf(h: ScriptHealth): string {
  const eff = h.recentEffectiveRate === undefined ? '无近期数据' : `${Math.round(h.recentEffectiveRate * 100)}%`;
  // cycle-112：超时率给双口径（近期分级用它，全史是历史事实）——只报一个数都白盒不足。
  const recentTo = h.recentTimeoutRate === undefined ? '无近期数据' : `${Math.round(h.recentTimeoutRate * 100)}%`;
  return `当前 level=${h.level}，有效成功率 ${eff}，超时率 近期 ${recentTo} / 全史 ${Math.round(h.timeoutRate * 100)}%，`
    + `平均耗时 ${String(h.avgDurationMs)}ms，有效负裁决 ${String(h.validVerdicts)}，用法错误 ${String(h.usageErrors)}`;
}

/** 对 open 提案做分诊（纯读；不改盘）。`facts` 缺省 = 只有 health 判据（旧行为，向后兼容）。 */
export function triageTechDebt(
  open: Array<{ file: string; entry: TechDebtEntry }>,
  health: SkillHealthReport,
  facts?: DebtFacts,
): TriageDecision[] {
  return open.map(({ file, entry }) => {
    const verdict = triageOne(entry, health, facts);
    const script = scriptOf(entry);
    const h = script === null ? undefined : health.scripts.find((x) => x.script === script);
    let evidence: string;
    if (h !== undefined) {
      evidence = evidenceOf(h);
    } else if (facts !== undefined && DIMENSION_RE.test(entry.dimension)) {
      const v = facts.dimensions[entry.dimension] ?? '缺行';
      evidence = dimensionEvidence(entry.dimension, v, facts);
    } else {
      evidence = '非 health / 非评估维度——需要人工判定';
    }
    return { id: entry.id, file, verdict, evidence };
  });
}

/** 落盘：把 stale 名单标记 resolved（带 resolvedAt/By/Evidence 审计字段）。 */
export interface TriageApplyResult {
  marked: number;
  notFound: string[];
  errors: string[];
}

export function applyTriage(
  cyclesDir: string,
  decisions: TriageDecision[],
  actor: string,
): TriageApplyResult {
  const stale = decisions.filter((d) => d.verdict === 'stale');
  const pending = new Map(stale.map((d) => [d.id, d.evidence]));
  const result: TriageApplyResult = { marked: 0, notFound: [...pending.keys()], errors: [] };
  const dir = join(cyclesDir, 'tech-debt');
  if (!existsSync(dir) || pending.size === 0) return result;
  const now = new Date().toISOString();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      result.errors.push(`${name}: unparseable JSON`);
      continue;
    }
    const isArray = Array.isArray(parsed);
    const entries: TechDebtEntry[] = isArray
      ? (parsed as TechDebtEntry[]).filter((v): v is TechDebtEntry =>
          typeof v === 'object' && v !== null && typeof (v as TechDebtEntry).id === 'string')
      : [parsed as TechDebtEntry];
    let changed = false;
    for (const e of entries) {
      const evidence = pending.get(e.id);
      if (evidence === undefined || e.resolved) continue;
      e.resolved = true;
      const ext = e as TechDebtEntry & { resolvedAt?: string; resolvedBy?: string; resolutionEvidence?: string };
      ext.resolvedAt = now;
      ext.resolvedBy = actor;
      ext.resolutionEvidence = evidence;
      pending.delete(e.id);
      result.marked += 1;
      changed = true;
    }
    if (!changed) continue;
    try {
      atomicWriteFileSync(filePath, JSON.stringify(isArray ? entries : entries[0], null, 2));
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  result.notFound = [...pending.keys()];
  return result;
}
