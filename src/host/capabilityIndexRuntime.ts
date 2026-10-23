/**
 * 能力索引的**运行时消费面**（cycle-73 T-7301）。
 *
 * 为什么要有这个文件（而不是只落两份 JSON）：本轮反复处理「产物生成了但没人读」，
 * 索引若只有制品 + 契约测试，就仍属「只在测试里活着」——模型与运维面看不到它。
 * 本模块让索引在**运行时**被真实消费：/anic/api/self-check 的 P7 探针据此判定
 * 「索引 ⇄ 注册面」是否漂移，结果进白盒面板。
 *
 * 纪律：
 *   - 只读；索引缺失/不可解析一律**如实报 not-ok**（不是静默退回）——
 *     design §3.3 的 fail-closed 方向是「退回 full 模式」，但**诊断面必须响亮**，
 *     否则「索引悄悄失效」正是要消灭的形态。
 *   - 与生成器/契约测试共用 `capabilityIndex.ts` 的判据，不写第二套比对逻辑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUMMARY_MAX_CHARS, TOOL_SUMMARIES, schemaHash, type ToolFace } from './capabilityIndex.ts';

/** 索引漂移判定结果（供探针渲染）。 */
export interface IndexDriftReport {
  ok: boolean;
  /** 人类可读一句话（进 self-check 的 detail 与面板）。 */
  detail: string;
  /** 逐类问题（空 = 无漂移）。 */
  issues: string[];
}

/** 读注入面制品；不存在/不可解析返回 null（调用方据此报 not-ok，不猜）。 */
export function loadInjectedIndex(indexDir: string): Record<string, unknown> | null {
  const p = join(indexDir, 'capability-index.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读校验面 sidecar；不存在/不可解析返回 null。 */
export function loadIndexHashes(indexDir: string): Record<string, string> | null {
  const p = join(indexDir, 'capability-hashes.json');
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { hashes?: Record<string, string> };
    return parsed.hashes ?? null;
  } catch {
    return null;
  }
}

/**
 * 判定「索引 ⇄ 注册面」是否漂移（纯函数：给定注册面 + 制品路径）。
 *
 * 四类检查（与 capabilityIndexContract 判据同源，此处是**运行时**那一份）：
 *   ① 注入面存在且可解析；
 *   ② tools id 集 == 注册面（**双向**：少一个=注册了没被发现；多一个=臆造）；
 *   ③ 每条 schemaHash == 从注册面重算（描述或参数改过而索引没重建）；
 *   ④ 摘要策展表齐全且 ≤ 上限。
 */
export function checkIndexDrift(indexDir: string, faces: ToolFace[]): IndexDriftReport {
  const issues: string[] = [];
  const idx = loadInjectedIndex(indexDir);
  if (idx === null) {
    return { ok: false, detail: 'capability-index.json 缺失或不可解析（运行 npm run index 重建）', issues: ['index-missing'] };
  }
  const pairs = Array.isArray(idx.tools) ? (idx.tools as Array<[string, string]>) : [];
  const fromIndex = pairs.map((p) => p[0]).sort();
  const fromReg = faces.map((f) => f.name).sort();
  const missing = fromReg.filter((id) => !fromIndex.includes(id));
  const fabricated = fromIndex.filter((id) => !fromReg.includes(id));
  if (missing.length > 0) issues.push('索引缺工具: ' + missing.join(', '));
  if (fabricated.length > 0) issues.push('索引臆造工具: ' + fabricated.join(', '));

  const hashes = loadIndexHashes(indexDir);
  if (hashes === null) {
    issues.push('capability-hashes.json 缺失或不可解析');
  } else {
    const stale = faces.filter((f) => hashes[f.name] !== schemaHash(f)).map((f) => f.name);
    if (stale.length > 0) issues.push('schema 已改而索引未重建: ' + stale.join(', '));
  }

  for (const f of faces) {
    const s = TOOL_SUMMARIES[f.name] ?? pairs.find((p) => p[0] === f.name)?.[1];
    if (!s) issues.push('缺摘要: ' + f.name);
    else if (s.length > SUMMARY_MAX_CHARS) issues.push('摘要超长: ' + f.name);
  }

  return {
    ok: issues.length === 0,
    detail: issues.length === 0
      ? 'index in sync (' + String(pairs.length) + ' tools)'
      : issues.join(' | '),
    issues,
  };
}
