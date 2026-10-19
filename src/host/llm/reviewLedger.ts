/**
 * 评审结论账本 + 结论时效性（cycle-38 · G5）。
 *
 * 要解决的问题（来自 docs/anic/19 §3 差距清单 G5）：
 *   本仓此前只有**流程投影**的时效检测（`flows/persistence.ts` 的
 *   `isProjectionStale`：投影盖的 ledgerHead 与当前链头不符 → 落后）。评审结论
 *   完全没有时效概念：一次 `approve` 在证据被换掉之后依然躺在账本里，看上去
 *   与刚刚做出时一模一样。**结论的有效期是它的前提，不是它的时间戳。**
 *
 * 吸收的外部纪律（第三方取证块 b7）：
 *   - `dsh-plugin-veriscope` 0.6.0：「PASS 只说明归档指标通过所绑定门禁」——
 *     结论必须绑定它所依据的那批输入，输入换了结论就作废。
 *   - `dsh-negative-ledger`（npm 上查无此包，仅作提纲出处）的「precondition
 *     变化 → 结论 stale」形态。
 *   - `dsh-continual-evolve` 0.19.0：回滚靠**账本**而不是靠机制——每次变更落
 *     before/after 快照。这里落的是 before（上一次结论 + 它依据的证据指纹）。
 *
 * 判据是**内容指纹**，不是时间：
 *   `reviewEngine.buildAttribution(...).promptDigest` 只由（门、角色、证据 id+内容）决定，
 *   与 provider/model/时间戳无关（它刻意不含这两项）。两次评审的指纹相同 ⇔ 它们
 *   面对的是同一批证据。此处直接复用该指纹作为 evidenceDigest，不新造第二套哈希。
 *   于是「证据换过没有」是一个确定性的字符串比较，不需要任何模型参与。
 *
 * 诚实边界：
 *   - 账本只记**摘要**（指纹 + 证据 id），不落证据正文、不落提示词原文。
 *   - 只保留最近 `MAX_REVIEW_RECORDS` 条（滚动窗口）；更早的结论不存在，
 *     读侧返回空数组而不是伪造。
 *   - `stale` 是**提示**不是裁决：它不改变本次 verdict，只把「你正在覆盖一个
 *     基于不同证据的历史结论」这件事显式说出来。插件不替调用方做取舍。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';

/** 一条评审结论（摘要形态，非全量提示词）。 */
export interface ReviewRecord {
  gate: string;
  role: string;
  verdict: 'approve' | 'reject' | 'doubt';
  /** 'tier-2-llm' | 'tier-1-heuristic' | 'tier-0-unavailable'（评审层级）。 */
  tier: string;
  /** 该结论所依据证据的内容指纹（sha256 前 16 位）。 */
  evidenceDigest: string;
  /** 被引用的证据 id（保序），用于事后核对「当时看的是哪几条」。 */
  evidenceIds: string[];
  provider: string;
  model: string;
  timestamp: string;
}

/** 结论相对当前证据的时效状态。 */
export type ReviewFreshness = 'none' | 'fresh' | 'stale';

/** 账本文件（相对 .cycles/）。 */
export const REVIEW_LEDGER_FILE = 'reviews/ledger.json';

/** 滚动保留上限。 */
export const MAX_REVIEW_RECORDS = 200;

/** 账本路径。 */
export function reviewLedgerPath(cyclesDir: string): string {
  return join(cyclesDir, REVIEW_LEDGER_FILE);
}

/**
 * 读账本。缺失/损坏一律返回空数组（不 throw）——账本是观测工件，
 * 它的缺失不能让评审本身失败。
 */
export function loadReviewRecords(cyclesDir: string): ReviewRecord[] {
  const p = reviewLedgerPath(cyclesDir);
  if (!existsSync(p)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    const list = Array.isArray(raw) ? raw : (raw as { records?: unknown })?.records;
    if (!Array.isArray(list)) return [];
    return list.filter(isReviewRecord);
  } catch {
    return [];
  }
}

/** 形状守卫：形状不对的条目不采信（绝不部分采信）。 */
function isReviewRecord(v: unknown): v is ReviewRecord {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.gate === 'string' &&
    typeof r.role === 'string' &&
    (r.verdict === 'approve' || r.verdict === 'reject' || r.verdict === 'doubt') &&
    typeof r.tier === 'string' &&
    typeof r.evidenceDigest === 'string' &&
    Array.isArray(r.evidenceIds) &&
    typeof r.timestamp === 'string'
  );
}

/**
 * 追加一条结论（原子写；滚动保留最近 MAX_REVIEW_RECORDS 条）。
 * 失败返回原因字符串，绝不 throw——记账是增强不是依赖。
 */
export function appendReviewRecord(
  cyclesDir: string,
  record: ReviewRecord,
): { ok: true } | { ok: false; reason: string } {
  try {
    const p = reviewLedgerPath(cyclesDir);
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const next = [...loadReviewRecords(cyclesDir), record].slice(-MAX_REVIEW_RECORDS);
    atomicWriteFileSync(p, JSON.stringify(next, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 取某门某角色最近一次结论（读侧投影；无记录返回 null，不伪造）。 */
export function findLatestReview(
  records: ReviewRecord[],
  gate: string,
  role: string,
): ReviewRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && r.gate === gate && r.role === role) return r;
  }
  return null;
}

/**
 * 时效判定（确定性字符串比较，零模型参与）。
 *   none  = 该门该角色此前没有结论
 *   fresh = 历史结论依据的证据与当前完全一致
 *   stale = 证据已变，历史结论不再代表当前输入
 */
export function reviewFreshness(prev: ReviewRecord | null, currentDigest: string): ReviewFreshness {
  if (!prev) return 'none';
  return prev.evidenceDigest === currentDigest ? 'fresh' : 'stale';
}
