/**
 * tech-debt 提案消费队列（G-C3 后半闭环，docs/anic/15 §5.2）。
 *
 * 设计裁决（cycle-16）：
 * - PatchEngine 生成提案（写 .cycles/tech-debt/*.json），fixLoop 每次内联重新
 *   生成——生成侧三处通、消费执行侧断（15 号评审 G-C3「半闭环」）。
 * - 本模块补**读取与消费记账**侧：listTechDebt 读全部未消费提案，
 *   markTechDebtConsumed 把 resolved 置 true + 追加 consumedAt/consumedBy。
 *   「执行修复」本身仍是 R-31 纪律（不自我改码）——由人/上游 agent 拿着
 *   提案去修，修完经本模块记账闭环。自动执行队列是 15 号建议的原始形态，
 *   本工程裁决为「提案→人工/上游执行→记账」形态（fixLoop 不自我改码红线）。
 * - 单实现：TechDebtEntry 形状从 patchEngine.ts 导入（唯一权威）。
 * - fixLoop 写的 fix-loop-*.json 是数组形态、selfBootstrapRoute 写的
 *   self-bootstrap-round-*.json 是自由形态——两者不是 TechDebtEntry 单体，
 *   解析时按形状分流（数组展开 / 单体直收 / 无法识别跳过并如实报告）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { TechDebtEntry } from './patchEngine.ts';

export interface TechDebtFile {
  file: string;
  entry: TechDebtEntry;
}

export interface TechDebtListing {
  open: TechDebtFile[];
  resolved: TechDebtFile[];
  skipped: Array<{ file: string; reason: string }>;
}

function isTechDebtEntry(v: unknown): v is TechDebtEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.dimension === 'string'
    && typeof o.description === 'string';
}

/** 解析单个提案文件（单体 / 数组两种落盘形态；fix-loop-*.json 是数组）。 */
function parseDebtFile(filePath: string): { entries: TechDebtEntry[]; isArray: boolean } | { skipped: string } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { skipped: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { skipped: 'unparseable JSON' };
  }
  if (Array.isArray(parsed)) {
    const entries = parsed.filter(isTechDebtEntry);
    if (entries.length === 0) return { skipped: 'array with no recognizable TechDebtEntry' };
    return { entries, isArray: true };
  }
  if (isTechDebtEntry(parsed)) return { entries: [parsed], isArray: false };
  return { skipped: 'not a TechDebtEntry shape (e.g. self-bootstrap free-form proposal)' };
}

/** 列出 .cycles/tech-debt/ 全部提案（open = 未消费；skipped 如实报告不吞）。 */
export function listTechDebt(cyclesDir: string): TechDebtListing {
  const dir = join(cyclesDir, 'tech-debt');
  const listing: TechDebtListing = { open: [], resolved: [], skipped: [] };
  if (!existsSync(dir)) return listing;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    const parsed = parseDebtFile(filePath);
    if ('skipped' in parsed) {
      listing.skipped.push({ file: name, reason: parsed.skipped });
      continue;
    }
    for (const entry of parsed.entries) {
      const rec = { file: name, entry };
      if (entry.resolved) listing.resolved.push(rec);
      else listing.open.push(rec);
    }
  }
  return listing;
}

export interface ConsumeResult {
  marked: number;
  notFound: string[];
  errors: string[];
}

/**
 * 标记提案已消费（resolved=true + consumedAt/consumedBy 审计字段）。
 * 按提案 id 匹配（同 id 可出现在数组形态文件里，全部标记）。
 * 写失败进 errors 响亮返回——Post-Verify 纪律：效果即记录，写不进去不算消费。
 */
export function markTechDebtConsumed(cyclesDir: string, ids: string[], consumedBy: string): ConsumeResult {
  const result: ConsumeResult = { marked: 0, notFound: [...ids], errors: [] };
  if (ids.length === 0) return result;
  const dir = join(cyclesDir, 'tech-debt');
  if (!existsSync(dir)) return result;
  const pending = new Set(ids);
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    const parsed = parseDebtFile(filePath);
    if ('skipped' in parsed) continue;
    const { entries, isArray } = parsed;
    let changed = false;
    for (const e of entries) {
      if (!pending.has(e.id)) continue;
      if (e.resolved) {
        pending.delete(e.id); // 幂等：已消费算成功
        continue;
      }
      e.resolved = true;
      (e as TechDebtEntry & { consumedAt?: string; consumedBy?: string }).consumedAt = new Date().toISOString();
      (e as TechDebtEntry & { consumedAt?: string; consumedBy?: string }).consumedBy = consumedBy;
      pending.delete(e.id);
      result.marked++;
      changed = true;
    }
    if (!changed) continue;
    try {
      // 原文件形态保持：数组文件写回数组（哪怕只剩/只改一条），单体写回单体。
      atomicWriteFileSync(filePath, JSON.stringify(isArray ? entries : entries[0], null, 2));
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.notFound = [...pending];
  return result;
}
