/**
 * 配置路由的**响应体构造**（cycle-83：从 configRoute.ts 拆出，T3 ≤250 行）。
 *
 * ## 为什么 GET 也返回 schema
 *
 * 客户端只做纯渲染（不引 hooks、不自带字段表）。字段表若在客户端手抄一份，
 * 加了 host 校验忘了改客户端，或反过来，就会出现「表单允许的值被后端拒绝」。
 * 所以 schema 随 values 一起下发——**同一张表**既驱动渲染又驱动校验。
 *
 * ## rawHash 的用途
 *
 * 响应带原文 sha256 前 16 位。客户端保存时可带上它做「基于哪个版本改的」证据；
 * 本轮不做乐观锁（并发写配置是罕见动作，且回读断言已保证最终一致），
 * 但哈希进响应让「你以为改的和实际改的不是同一份」这件事**可被发现**。
 *
 * ## 写侧语义
 *
 * dryRun=true → 只算不写，返回 diff；否则备份 → 原子写 → 回读断言 → 不符回滚。
 * 任何非法字段值一律 400 且**零写入**（半套配置比没改更危险）。
 *
 * ## cycle-83 新增的两个形状
 *
 * GET 多了 `pathOverrides`（生效覆盖 + 可覆盖 id + 是否整份被忽略）与
 * `backupViews`（每份 .bak 相对当前的字段级 diff 摘要）。两者都是**事实**，
 * 不是建议：客户端据此决定「编辑按钮是否可用」「恢复按钮点哪一份」。
 * 旧的 `backups: string[]` 保留（既有契约测试按名字断言，改形状会假红）。
 */
import { anicError } from './envelope.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceConfig } from '../config.ts';
import { CONFIG_FIELDS, configFieldViews } from '../configEdit/configSchema.ts';
import { readFieldValue } from '../configEdit/configRead.ts';
import { planPatch } from '../configEdit/yamlPatch.ts';
import { diffStats, lineDiff } from '../configEdit/yamlDiff.ts';
import { applyConfigPatch, configFileStat, listBackups } from '../configEdit/configWriter.ts';
import { collectPaths, resolveCustomPath } from '../configEdit/paths.ts';
import { loadPathOverrides } from '../configEdit/pathOverrides.ts';
import { EDITABLE_PATH_IDS } from '../configEdit/pathOverrides.ts';
import { listBackupsWithDiff } from '../configEdit/configBackup.ts';

/** 读当前值表：字段表逐项回读（缺键 = null，如实标注而不是填默认值）。 */
export function readConfigValues(content: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const def of CONFIG_FIELDS) values[def.id] = readFieldValue(content, def);
  return values;
}

export function rawHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

/** 覆盖层事实（客户端据此渲染「默认 / 自定义」与整份忽略告警）。 */
function pathOverrideView(root: string) {
  const r = loadPathOverrides(root);
  const active: Record<string, string> = {};
  for (const [id, v] of Object.entries(r.overrides)) active[id] = v.rel;
  return {
    active,
    editableIds: [...EDITABLE_PATH_IDS],
    ignored: r.ignored,
    present: r.present,
    warnings: r.warnings,
  };
}

/** GET 响应体（客户端 isConfigJson 的形状契约）。 */
export function buildGetBody(root: string, probeRaw: string | null) {
  const cyclesDir = join(root, '.cycles');
  const configPath = join(cyclesDir, 'config.yml');
  const probe = probeRaw === null ? null : resolveCustomPath(root, probeRaw);
  const overrides = pathOverrideView(root);
  const base = {
    workspace: root,
    schema: configFieldViews(),
    paths: collectPaths(root),
    pathOverrides: overrides,
    probe,
  };
  if (probeRaw !== null && probe !== null && !probe.ok) {
    // 自定义路径被拒：只回原因，不回任何文件内容（边界即边界）。
    return {
      ...base, values: {}, warnings: [probe.reason], rawHash: null,
      configFile: configFileStat(configPath), backups: [], backupViews: [],
    };
  }
  const stat = configFileStat(configPath);
  const warnings: string[] = [...overrides.warnings];
  if (!stat.exists) {
    warnings.push('.cycles/config.yml 不存在（先跑 init-workflow / 自举）');
    return { ...base, values: {}, warnings, rawHash: null, configFile: stat, backups: [], backupViews: [] };
  }
  const content = readFileSync(configPath, 'utf-8');
  // 唯一 loader 的告警（legacy 文件并存 / 未知键）一并透出——写侧与读侧看到同一份事实。
  try {
    const cfg = loadWorkspaceConfig(cyclesDir);
    warnings.push(...cfg.warnings);
    if (cfg.source === 'legacy') warnings.push('当前只有 legacy 的 cycle-config.yml；写侧会拒绝（canonical 缺失）');
  } catch (e) {
    warnings.push(`loader threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    ...base,
    values: readConfigValues(content),
    warnings,
    rawHash: rawHash(content),
    configFile: stat,
    backups: listBackups(cyclesDir),
    backupViews: listBackupsWithDiff(cyclesDir),
  };
}

/**
 * POST /anic/api/config 响应体。
 *
 * dryRun 的 diff 与真写走**同一个** planPatch：预览不是另一条实现，
 * 而是同一条实现的输出——否则「预览说只改一行」与「实际改了五行」会分家。
 */
export function buildPostBody(root: string, body: Record<string, unknown>) {
  const cyclesDir = join(root, '.cycles');
  const configPath = join(cyclesDir, 'config.yml');
  const patch = body['patch'];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { status: 400, payload: anicError('ANIC_CONFIG_BAD_PATCH', 'body.patch must be an object of {fieldId: value}') };
  }
  const dryRun = body['dryRun'] === true;
  if (!existsSync(configPath)) {
    return { status: 404, payload: anicError('ANIC_CONFIG_MISSING', 'no .cycles/config.yml in this workspace') };
  }
  const before = readFileSync(configPath, 'utf-8');

  if (dryRun) {
    const plan = planPatch(before, patch as Record<string, unknown>);
    return {
      status: plan.ok ? 200 : 400,
      payload: {
        ok: plan.ok,
        dryRun: true,
        applied: false,
        error: plan.error,
        changedFields: plan.changedFields,
        insertedFields: plan.insertedFields,
        warnings: plan.warnings,
        diff: lineDiff(plan.before, plan.after).filter((d) => d.kind !== 'same'),
        stats: diffStats(plan.before, plan.after),
        beforeHash: rawHash(plan.before),
      },
    };
  }

  const outcome = applyConfigPatch(cyclesDir, patch as Record<string, unknown>);
  const afterContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  return {
    status: outcome.ok ? 200 : outcome.applied ? 500 : 400,
    payload: {
      ok: outcome.ok,
      dryRun: false,
      applied: outcome.applied,
      error: outcome.error,
      changedFields: outcome.changedFields,
      insertedFields: outcome.insertedFields,
      warnings: outcome.warnings,
      backupPath: outcome.backupPath,
      observed: outcome.observed,
      stats: diffStats(before, afterContent),
      beforeHash: rawHash(before),
      afterHash: outcome.ok ? rawHash(afterContent) : rawHash(before),
    },
  };
}
