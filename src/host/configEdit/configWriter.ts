/**
 * 配置写入的**证据链**（cycle-82）：备份 → 原子写 → 回读断言 → 不符则回滚。
 *
 * ## 为什么回读断言不是装饰
 *
 * 本仓有前科：`autonomyActions.ts` 的文件头写着「唯一做法是手改 config.yml：
 * 无前置判定、无回读断言、无审计记录」。它的修法就是 Post-Verify —— 改完
 * **重新解析**，按解析到的实际值判定，绝不无条件声称「已改」。
 * 这里的写路径完全同源：`loadWorkspaceConfig` 是唯一解析入口（INV-25），
 * 写完用它回读——如果手术刀切错了行（缩进被判成别的段、值被写在下属结构里），
 * 文件字节变了但语义没变，只有回读能发现。
 *
 * ## cycle-83 拆分：动作下移到 configCommit.ts
 *
 * 本文件现在只保留**patch 策略**（planPatch 怎么算），动作（备份/写/验/回滚）
 * 在 configCommit.ts。拆分动机是回滚必须复用同一写入器（G-SINGLE）：
 * 若 configWriter 里再长一个 `rollback()` 分支各写一份 atomicWrite，两条路径的
 * 回读断言强度就会分家。消费者 import 路径零变更（本文件再导出动作族）。
 *
 * ## 备份纪律
 *
 * 同目录 `config.yml.bak.<ISO 紧凑时间戳>`，只保留最近 3 份，按名排序清理
 * （实现见 configCommit.ts）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceConfig } from '../config.ts';
import { planPatch, type PatchPlan } from './yamlPatch.ts';
import { readFieldValue } from './configRead.ts';
import { fieldById, type ConfigFieldDef } from './configSchema.ts';
import {
  commitConfigContent,
  configFileStatOf,
  verifyFields,
  type VerifyResult,
  type WriteOutcome,
} from './configCommit.ts';

export {
  BACKUP_KEEP,
  BACKUP_PREFIX,
  backupFileName,
  compactStamp,
  listBackups,
  pruneBackups,
  type BackupPruneResult,
  type WriteOutcome,
} from './configCommit.ts';

/**
 * 回读断言（patch 专用）：用唯一 loader `loadWorkspaceConfig`（INV-25）解析磁盘事实，
 * 并与「计划里的 after」逐字段比对。
 *
 * 为什么两条腿都要：loader 只覆盖语义子集（build/test/lint/autonomy/flow/
 * toolDisclosure/allowedOrigins），而 project.* / coverage 等字段它不解析；
 * 只靠 schema 读取器会绕过唯一入口（INV-25），只靠 loader 会漏掉一半字段。
 */
function verifyReadback(cyclesDir: string, plan: PatchPlan): VerifyResult {
  let cfg;
  try {
    cfg = loadWorkspaceConfig(cyclesDir);
  } catch (e) {
    return { ok: false, observed: null, error: `re-read threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  const fieldCheck = verifyFields(cyclesDir, plan.after, plan.changedFields);
  const observed: Record<string, unknown> = { ...(fieldCheck.observed ?? {}) };
  const mismatched: string[] = fieldCheck.ok ? [] : [fieldCheck.error];
  // loader 交叉确认：这几类是它真正消费的字段，必须与文件事实一致。
  const loaderView: Record<string, unknown> = {
    'macro_cycle.autonomy_level': cfg.values.autonomyLevel,
    'anic.toolDisclosure': cfg.values.toolDisclosure,
    'anic.allowedOrigins': cfg.values.allowedOrigins,
  };
  observed['loader'] = loaderView;
  for (const [id, got] of Object.entries(loaderView)) {
    if (!plan.changedFields.includes(id)) continue;
    const want = readFieldValue(plan.after, fieldById(id) as ConfigFieldDef);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatched.push(`${id}(loader): got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  if (mismatched.length > 0) return { ok: false, observed, error: mismatched.join('; ') };
  return { ok: true, observed, error: '' };
}

/**
 * 应用 patch（备份 → 原子写 → 回读断言 → 失败回滚）。
 *
 * 三个注入点都是**为失败路径服务**的：`beforeWrite` 可在写后立刻篡改磁盘
 * （模拟「写了但读不回来」），`verify` 可整段替换回读判定（模拟断言失败），
 * `now` 固定备份时间戳（让 .bak 命名可断言）。只读目录在 Windows 上造不出来，
 * 注入钩子才是这两条失败路径的可复现证据。
 */
export function applyConfigPatch(
  cyclesDir: string,
  patch: Record<string, unknown>,
  opts: { now?: Date; beforeWrite?: (after: string) => void; verify?: (cyclesDir: string, plan: PatchPlan) => VerifyResult } = {},
): WriteOutcome {
  const configPath = join(cyclesDir, 'config.yml');
  if (!existsSync(configPath)) {
    return { ok: false, applied: false, changedFields: [], insertedFields: [], warnings: [], backupPath: null, observed: null, error: 'config.yml not found (run skill init-workflow first)' };
  }
  const plan = planPatch(readFileSync(configPath, 'utf-8'), patch);
  const base = { changedFields: [] as string[], insertedFields: [] as string[], warnings: plan.warnings };
  if (!plan.ok) return { ok: false, applied: false, ...base, backupPath: null, observed: null, error: plan.error };
  // 幂等：目标值已等于现值 ⇒ 零写入、零备份（保存未修改的表单必须零副作用）。
  if (plan.changedFields.length === 0) return { ok: true, applied: false, ...base, backupPath: null, observed: null, error: '' };

  return commitConfigContent(cyclesDir, {
    after: plan.after,
    changedFields: plan.changedFields,
    insertedFields: plan.insertedFields,
    warnings: plan.warnings,
    verify: (dir) => (opts.verify ?? verifyReadback)(dir, plan),
  }, { now: opts.now, beforeWrite: opts.beforeWrite });
}

/** 当前文件事实（供 GET 使用：原文 + 字节数 + mtime）。 */
export const configFileStat = configFileStatOf;
